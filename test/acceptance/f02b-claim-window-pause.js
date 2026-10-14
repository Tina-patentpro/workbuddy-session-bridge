'use strict';

/**
 * F02B · P0 · 领取临界窗口内暂停 / 崩溃（Windows 原生故障模拟，替代不可用的 SIGSTOP）
 *
 * 验收目标（审计 01 报告 §8 最终再审门槛点名「进程暂停 / 共享句柄竞争」；对应旧 F02.5 的 ENV 缺口）：
 *   持锁者在「已取得所有权、尚未释放旧名」的临界窗口内被暂停或崩溃时：
 *     - 暂停变体：并发消费者**不得**同时领取同一记录（单赢家语义不变）；恢复后最终恰好一条、内容完整、无丢失。
 *     - 崩溃变体：已确认的记录**不得丢失**（至少一个状态目录中内容完整可读）；后续消费者对同一 id
 *                 领取**不得重复投递**（不得出现两个消费者都成功拿到）。
 *
 * 实现方式：**不修改生产源码**，用 NODE_OPTIONS=--require 模拟预载（_fault-sim-link.js）
 *   包装 `fs.linkSync`——真实 link 成功后阻塞（暂停）或立即 process.exit(9)（崩溃）。
 *   这正是审计方自己的「操作失败 / 进程执行屏障」模拟技术在本机的等价复现。
 *
 * 判别力自证（F02B.3）：用 phantom 模式把互斥原语「退化」为幻影成功（第二个领取者也成功），
 *   若如此仍检测不到双赢家，说明本用例抓不到它声称要抓的缺陷。
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

/** 仅扫描四个状态目录（排除 tmp），返回该 id 的记录副本。 */
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
  process.stdout.write('=== F02B · P0 · 领取临界窗口内暂停 / 崩溃（Windows 原生故障模拟）===\n');
  const sandbox = H.makeSandbox('f02b');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  const store = sandbox.store;

  // ---------- 变体 1：暂停在「link 成功、尚未 unlink」窗口 ----------
  await H.check('F02B.1 暂停窗口内并发领取 → 后者 EEXIST 跳过（单赢家），最终恰好一条且内容完整', async () => {
    const id = await enqueue(env, 'pause-window-instruction', 'sess-pause');
    H.assert(fs.existsSync(pendingPath(store, id)), '入队后 pending 文件缺失');

    // P1：picked 链接成功后暂停 4s。
    const p1 = new H.Client(faultEnv(env, 'pause', id, 4000));
    await p1.initialize();
    const p1Promise = p1.call('wb_pending_instructions', { limit: 10, markPicked: true });

    // 等 picked/<id> 出现 —— 证明 P1 已完成 link、正处暂停窗口。
    const appeared = await waitFor(() => fs.existsSync(pickedPath(store, id)), 3000);
    H.assert(appeared, '等待 P1 在窗口内创建 picked 文件超时');

    // 窗口确定：pending 与 picked 同时存在 ⇒ P2 的跳过必然是 EEXIST 路径，而非 GONE。
    const bothPresent = fs.existsSync(pendingPath(store, id)) && fs.existsSync(pickedPath(store, id));
    H.assert(bothPresent, '窗口内未同时存在 pending 与 picked（暂停窗口未生效），无法证明 EEXIST 路径');

    // P2：并发领取同一 id。
    const p2 = new H.Client(env);
    await p2.initialize();
    const t2 = H.parseTool(await p2.call('wb_pending_instructions', { limit: 10, markPicked: true }));
    const t1 = H.parseTool(await p1Promise);
    await p2.close();
    await p1.close();

    H.assert(t1.ok, `P1 领取失败: ${JSON.stringify(t1).slice(0, 300)}`);
    H.assert(t2.ok, `P2 领取失败: ${JSON.stringify(t2).slice(0, 300)}`);
    const ids1 = (t1.payload.instructions || []).map((x) => x.id);
    const ids2 = (t2.payload.instructions || []).map((x) => x.id);
    H.assert(ids1.includes(id), 'P1 未领取到目标指令');
    H.assert(!ids2.includes(id), `P2 也领取到同一指令（双赢家）: ${ids2.join(',')}`);

    const recs = stateRecords(store, id);
    H.assert(recs.length === 1, `最终该 id 状态记录数 ${recs.length}（应为恰好 1）: ${recs.map((r) => r.dir).join(',')}`);
    H.assert(recs[0].dir === 'picked', `最终记录应在 picked，实际在 ${recs[0].dir}`);
    H.assert(recs[0].record && recs[0].record.instruction === 'pause-window-instruction', '记录内容不完整');
  });

  // ---------- 变体 2：崩溃在「link 成功、尚未 unlink」窗口 ----------
  await H.check('F02B.2 崩溃于窗口内 → 记录不丢失（picked 完整可读）且后续领取不重复投递', async () => {
    const id = await enqueue(env, 'crash-window-instruction', 'sess-crash');

    // P1：picked 链接成功后立即 exit(9)。
    const p1 = new H.Client(faultEnv(env, 'crash', id));
    await p1.initialize();
    p1.call('wb_pending_instructions', { limit: 10, markPicked: true }); // 不 await：进程即将崩溃
    const exit = await p1.exited;
    await p1.close();
    H.assert(exit && exit.code === 9, `模拟的崩溃未按预期发生（exit code=${exit && exit.code}）`);

    // 不丢失：picked/<id> 必须存在且内容完整可读。
    H.assert(fs.existsSync(pickedPath(store, id)), '崩溃后 picked 记录丢失（数据丢失）');
    let crashed = null;
    try { crashed = JSON.parse(fs.readFileSync(pickedPath(store, id), 'utf8')); } catch (_e) { crashed = null; }
    H.assert(crashed && crashed.instruction === 'crash-window-instruction', '崩溃后 picked 记录内容不完整/不可读');

    const recs = stateRecords(store, id);
    H.assert(recs.length >= 1, '崩溃后状态目录中找不到该记录（丢失）');

    // 后续消费者领取同一 id → 不得重复投递（不得成功）。
    const p2 = new H.Client(env);
    await p2.initialize();
    const t2 = H.parseTool(await p2.call('wb_pending_instructions', { limit: 10, markPicked: true }));
    await p2.close();
    H.assert(t2.ok, `后续消费者领取返回错误: ${JSON.stringify(t2).slice(0, 300)}`);
    const ids2 = (t2.payload.instructions || []).map((x) => x.id);
    H.assert(!ids2.includes(id), `崩溃窗口内同一记录被重复投递（后续消费者也领取成功）: ${ids2.join(',')}`);
  });

  // ---------- 判别力自证 ----------
  await H.check('F02B.3 判别力自证：互斥原语被破坏（幻影成功）时必须检出双赢家', async () => {
    const id = await enqueue(env, 'phantom-selfproof-instruction', 'sess-phantom');
    // P1 暂停制造窗口；P2 用 phantom 使「第二个领取者也成功」。
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
    H.assert(
      overlap.length > 0,
      '判别力自证失败：即使把互斥原语破坏为「幻影成功」，也未观察到双赢家 —— 本用例抓不到该缺陷',
    );
  });

  H.finish('F02B', '模拟经 NODE_OPTIONS 预载，仅作用于测试子进程');
})().catch((e) => { H.fail('F02B harness', (e && e.stack) || String(e)); H.finish('F02B'); });
