'use strict';

/**
 * F12 · P2 · README 消费示例先全局领取，再跳过其他会话指令
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   按修订后的完整示例做两会话端到端测试：A 不改变 B 的 pending 状态，B 能领取并完成；
 *   同时保留有意设计的全局消费能力。
 *
 * 说明：F12 属「README 集成流程」缺陷。行为层面（API 按 sessionId 过滤）本就正确，
 *   因此本用例分两部分：
 *     - 行为：定向消费者 A 在领取时传自身 sessionId，不得取走 B 的指令；B 可领取并完成；全局消费保留。
 *     - 文档：README 若仍指示「先全局领取再跳过」，判 FAIL（文档未修订）。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** README 中暴露缺陷的旧措辞（全局领取后按 sessionId 跳过）。 */
const BAD_DOC_PATTERNS = [
  /sessionId\s*非空且与当前会话不符[:：]?\s*跳过/,
  /markPicked\s*=\s*true[^\n]*拉取待处理指令[^\n]*\n[\s\S]{0,120}跳过/,
];

(async () => {
  process.stdout.write('=== F12 · P2 · 跨会话定向消费 + README 流程 ===\n');
  const sandbox = H.makeSandbox('f12');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  const client = new H.Client(env);

  try {
    await client.initialize();

    // 投递一条定向 session-B 的指令
    const sb = H.parseTool(await client.call('wb_send_instruction', { instruction: 'FOR_SESSION_B', sessionId: 'session-B' }));
    H.assert(sb.ok && sb.payload && sb.payload.instructionId, `定向投递失败: ${JSON.stringify(sb).slice(0, 200)}`);
    const instrId = sb.payload.instructionId;

    // 会话 A 按修订流程：领取时即传自己的 sessionId
    await H.check('F12.1 会话 A（传自身 sessionId）不得领取到 B 的指令', async () => {
      const res = await client.call('wb_pending_instructions', { sessionId: 'session-A', markPicked: true, limit: 5 });
      const t = H.parseTool(res);
      H.assert(t.ok, `A 领取调用失败: ${JSON.stringify(t).slice(0, 200)}`);
      const ids = (t.payload.instructions || []).map((x) => x.id);
      H.assert(!ids.includes(instrId), 'A 领取到了定向给 B 的指令（误消费）');
    });

    await H.check('F12.2 A 的调用未改变 B 的 pending 状态', async () => {
      const persisted = H.readPersisted(sandbox.store);
      const rec = persisted.records.find((r) => r.id === instrId);
      H.assert(!!rec, 'B 的指令在持久状态中消失');
      H.assert(rec.status === 'pending', `B 的指令状态被 A 改为 ${rec.status}（应为 pending）`);
    });

    await H.check('F12.3 会话 B（传自身 sessionId）能领取并完成', async () => {
      const res = await client.call('wb_pending_instructions', { sessionId: 'session-B', markPicked: true, limit: 5 });
      const t = H.parseTool(res);
      H.assert(t.ok, `B 领取失败: ${JSON.stringify(t).slice(0, 200)}`);
      const ids = (t.payload.instructions || []).map((x) => x.id);
      H.assert(ids.includes(instrId), 'B 未能领取到定向给自己的指令');
      const done = H.parseTool(await client.call('wb_complete_instruction', { instructionId: instrId, status: 'done', result: { summary: 'ok' } }));
      H.assert(done.ok, `B 回填失败: ${JSON.stringify(done).slice(0, 200)}`);
    });

    await H.check('F12.4 有意设计的全局消费能力保留（不传 sessionId 可全局领取）', async () => {
      const g = H.parseTool(await client.call('wb_send_instruction', { instruction: 'GLOBAL_TASK' }));
      H.assert(g.ok && g.payload.instructionId, '全局投递失败');
      const res = await client.call('wb_pending_instructions', { markPicked: true, limit: 10 });
      const t = H.parseTool(res);
      H.assert(t.ok, `全局领取失败: ${JSON.stringify(t).slice(0, 200)}`);
      const ids = (t.payload.instructions || []).map((x) => x.id);
      H.assert(ids.includes(g.payload.instructionId), '全局消费能力丢失（未领到无 sessionId 的指令）');
    });

    await H.check('F12.5 README 消费示例已修订（不再先全局领取再跳过）', () => {
      const readmePath = path.join(H.PROJECT_ROOT, 'README.md');
      if (!fs.existsSync(readmePath)) H.raiseEnv('README.md 不存在');
      const readme = fs.readFileSync(readmePath, 'utf8');
      const hit = BAD_DOC_PATTERNS.find((re) => re.test(readme));
      H.assert(!hit, `README 仍含「先全局领取再按 sessionId 跳过」的旧示例，定向任务会被错误消费者领取（模式 ${hit}）`);
    });
  } finally {
    await client.close();
  }

  H.finish('F12');
})().catch((e) => { H.fail('F12 harness', (e && e.stack) || String(e)); H.finish('F12'); });
