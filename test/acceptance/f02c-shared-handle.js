'use strict';

/**
 * F02C · P0 · 共享只读句柄下的领取竞争（Windows 文件共享语义）
 *
 * 验收目标（审计 01 报告 §8 点名「共享句柄竞争」；对应历史 EPERM 问题方向）：
 *   当一条 pending 记录正被**另一进程以只读句柄打开**时，消费者对该 id 发起领取：
 *     - 要么领取成功且内容完整（单赢家）；
 *     - 要么**明确失败**（结构化错误）；
 *   无论哪种，**绝不丢失、绝不双成功**。
 *
 * 为什么值得做：Windows 上对「被他人打开的文件」执行 link/unlink/rename 会抛 EPERM/EACCES/EBUSY
 *   （目标部署形态即 Codex 侧写、WorkBuddy 侧读）。历史缺陷正源于此。本用例把只读句柄保持打开，
 *   让领取必须走「带退避重试的 link/unlink」路径，验证在该交互下记录不丢失、不重复。
 *
 * 判别力自证（F02C.3）：并发变体在「互斥原语被破坏（幻影成功）」时必须检出双赢家。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const PROBE = path.join(__dirname, '_fault-sim-link.js');
const STATE_DIRS = ['pending', 'picked', 'done', 'failed'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造带故障模拟的环境变量。 */
function faultEnv(baseEnv, mode, id, pauseMs) {
  const env = Object.assign({}, baseEnv, {
    NODE_OPTIONS: `--require ${PROBE}`,
    WB_TEST_LINK_FAULT: mode,
  });
  if (id) env.WB_TEST_LINK_ID = id;
  if (pauseMs) env.WB_TEST_LINK_PAUSE_MS = String(pauseMs);
  return env;
}

/** 轮询等待条件成立。 */
async function waitFor(predicate, timeoutMs, intervalMs = 15) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try { ok = predicate(); } catch (_e) { ok = false; }
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** 入队一条指令，返回其 id。 */
async function enqueue(env, instruction, sessionId) {
  const client = new H.Client(env);
  try {
    await client.initialize();
    const t = H.parseTool(await client.call('wb_send_instruction', { instruction, sessionId }));
    if (!t.ok) throw new Error(`入队失败: ${JSON.stringify(t).slice(0, 200)}`);
    return t.payload.instructionId;
  } finally {
    await client.close();
  }
}

/** 仅扫描四个状态目录（排除 tmp）。 */
function stateRecords(store, id) {
  const out = [];
  for (const dir of STATE_DIRS) {
    const p = path.join(store, dir, `${id}.json`);
    if (!fs.existsSync(p)) continue;
    let record = null;
    try { record = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { record = null; }
    out.push({ dir, path: p, record });
  }
  return out;
}

const pickedPath = (store, id) => path.join(store, 'picked', `${id}.json`);
const pendingPath = (store, id) => path.join(store, 'pending', `${id}.json`);

(async () => {
  process.stdout.write('=== F02C · P0 · 共享只读句柄下的领取竞争 ===\n');
  const sandbox = H.makeSandbox('f02c');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  const store = sandbox.store;

  // ---------- B.1：单消费者 + 只读句柄保持打开 ----------
  await H.check('F02C.1 只读句柄打开时领取：成功则内容完整，失败则记录仍在 pending；绝不丢失/双成功', async () => {
    const id = await enqueue(env, 'shared-handle-single', 'sess-b1');
    const p = pendingPath(store, id);
    H.assert(fs.existsSync(p), '入队后 pending 文件缺失');

    const fd = fs.openSync(p, 'r'); // 测试进程持有只读句柄
    let t;
    try {
      const client = new H.Client(env);
      await client.initialize();
      t = H.parseTool(await client.call('wb_pending_instructions', { limit: 10, markPicked: true }));
      await client.close();
    } finally {
      fs.closeSync(fd);
    }

    const recs = stateRecords(store, id);
    H.assert(recs.length === 1, `该 id 状态记录数 ${recs.length}（应恰好 1，绝不丢失/重复）: ${recs.map((r) => r.dir).join(',')}`);
    H.assert(recs[0].record && recs[0].record.instruction === 'shared-handle-single', '记录内容不完整/不可读');

    const got = t.ok && (t.payload.instructions || []).some((x) => x.id === id);
    if (got) {
      H.assert(recs[0].dir === 'picked', `领取声称成功但记录不在 picked（在 ${recs[0].dir}）`);
    } else {
      // 明确失败（t.ok=false）或明确跳过：记录必须原样留在 pending（未丢失、未被误移）。
      H.assert(recs[0].dir === 'pending', `未领取成功但记录已不在 pending（在 ${recs[0].dir}）`);
    }
  });

  // ---------- B.2：两个并发消费者 + 只读句柄 ----------
  await H.check('F02C.2 只读句柄打开 + 两并发领取 → 单赢家（无重叠）、无丢失、无重复', async () => {
    const id = await enqueue(env, 'shared-handle-concurrent', 'sess-b2');
    const p = pendingPath(store, id);
    const fd = fs.openSync(p, 'r');
    let ids1 = [];
    let ids2 = [];
    try {
      const c1 = new H.Client(env);
      const c2 = new H.Client(env);
      await c1.initialize();
      await c2.initialize();
      const [r1, r2] = await Promise.all([
        c1.call('wb_pending_instructions', { limit: 10, markPicked: true }),
        c2.call('wb_pending_instructions', { limit: 10, markPicked: true }),
      ]);
      await c1.close();
      await c2.close();
      const t1 = H.parseTool(r1);
      const t2 = H.parseTool(r2);
      ids1 = (t1.ok && t1.payload.instructions ? t1.payload.instructions : []).map((x) => x.id);
      ids2 = (t2.ok && t2.payload.instructions ? t2.payload.instructions : []).map((x) => x.id);
    } finally {
      fs.closeSync(fd);
    }

    const overlap = ids1.filter((x) => ids2.includes(x));
    H.assert(overlap.length === 0, `双赢家：两进程同时领取同一记录 ${overlap.join(',')}`);

    const recs = stateRecords(store, id);
    H.assert(recs.length === 1, `该 id 状态记录数 ${recs.length}（应恰好 1）: ${recs.map((r) => r.dir).join(',')}`);
    H.assert(recs[0].record && recs[0].record.instruction === 'shared-handle-concurrent', '记录内容不完整/不可读');
    const winner = ids1.includes(id) || ids2.includes(id);
    if (winner) {
      H.assert(recs[0].dir === 'picked', `有消费者领取成功但记录不在 picked（在 ${recs[0].dir}）`);
    } else {
      H.assert(recs[0].dir === 'pending', `无人领取成功但记录已不在 pending（在 ${recs[0].dir}）`);
    }
  });

  // ---------- B.3：判别力自证 ----------
  await H.check('F02C.3 判别力自证：互斥被破坏（幻影成功）时并发领取必须检出双赢家', async () => {
    const id = await enqueue(env, 'shared-handle-selfproof', 'sess-b3');
    // P1 暂停制造窗口；P2 用 phantom 使第二个领取者也「成功」。
    const p1 = new H.Client(faultEnv(env, 'pause', id, 4000));
    await p1.initialize();
    const p1Promise = p1.call('wb_pending_instructions', { limit: 10, markPicked: true });
    const appeared = await waitFor(() => fs.existsSync(pickedPath(store, id)), 3000);
    H.assert(appeared, '自证：等待暂停窗口超时');

    const p2 = new H.Client(faultEnv(env, 'phantom', id));
    await p2.initialize();
    const t2 = H.parseTool(await p2.call('wb_pending_instructions', { limit: 10, markPicked: true }));
    const t1 = H.parseTool(await p1Promise);
    await p2.close();
    await p1.close();

    const ids1 = (t1.payload && t1.payload.instructions ? t1.payload.instructions : []).map((x) => x.id);
    const ids2 = (t2.payload && t2.payload.instructions ? t2.payload.instructions : []).map((x) => x.id);
    const overlap = ids1.filter((x) => ids2.includes(x));
    H.assert(overlap.length > 0, '判别力自证失败：互斥被破坏后仍未观察到双赢家 —— 本用例抓不到该缺陷');
  });

  H.finish('F02C', '只读句柄由测试进程持有；模拟仅作用于测试子进程');
})().catch((e) => { H.fail('F02C harness', (e && e.stack) || String(e)); H.finish('F02C'); });
