'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：本脚本测量「锁持有时长 vs 锁获取预算」，而新设计**已删除锁机制**
 *   （LOCK_RETRY / LOCK_STALE_MS / CRITICAL_SECTION_BUDGET_MS 的语义已改写）。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   等价保证已由下列现行用例接管：
 *     退避预算不变量（逐次取整上界、只计真实睡眠次数）
 *       → test/qa-verify.js  D12-7（RENAME_RETRY 逐次上界 = 238ms；预算链 238<400<30000<60000）
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-lockhold：针对已删除的 lockfile 设计；等价保证见 test/qa-verify.js D12-7。\n');
  process.exit(0);
}

/**
 * QA 第2轮诊断：测量 store 临界区（锁持有）实际时长 vs 锁获取预算。
 *
 * 目的：判定 qa2-concurrency 中偶发的 LOCK_TIMEOUT 是否为
 * 「rename 退避重试(P0修复)把锁持有时间拉长到超过其它进程等待预算」所致。
 *
 * 运行：node test/helpers/qa2-lockhold.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../lib/store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lockhold-'));
const storePath = path.join(dir, 'instructions.json');

// 统计临界区时长
const stats = {
  enqueueCalls: 0,
  failures: [],
  holdTimes: [],
  renameAttempts: 0,
  renameRetries: 0,
  renameMaxSpan: 0,
  storeWrites: 0,
};

// 包裹 renameSync：统计单次 rename 耗时（退避会在此期间持锁）
const origRename = fs.renameSync;
let currentRenameSpan = 0;
fs.renameSync = function patchedRename(from, to) {
  const t0 = Date.now();
  stats.renameAttempts += 1;
  try {
    return origRename.call(fs, from, to);
  } finally {
    const d = Date.now() - t0;
    currentRenameSpan += d;
    if (d > stats.renameMaxSpan) stats.renameMaxSpan = d;
  }
};

// 包裹 writeFileSync：观察 tmp 写入
const origWrite = fs.writeFileSync;
fs.writeFileSync = function patchedWrite(target, ...rest) {
  if (String(target).includes('.tmp-')) stats.storeWrites += 1;
  return origWrite.call(fs, target, ...rest);
};

const s = new store.InstructionStore({ storePath, bridgeDir: dir });

/**
 * 模拟「另一个进程持续读 store」造成的 rename 竞争。
 *
 * @param {number} n 投递条数。
 * @return {void}
 */
function post(n) {
  for (let i = 0; i < n; i += 1) {
    stats.enqueueCalls += 1;
    const t0 = Date.now();
    try {
      s.enqueue({ instruction: 'x' + i, sessionId: null, priority: 'normal', metadata: null });
    } catch (error) {
      stats.failures.push({ code: error.code, msg: String(error.message).slice(0, 80), ms: Date.now() - t0 });
    } finally {
      currentRenameSpan = 0;
      stats.holdTimes.push(Date.now() - t0);
    }
  }
}

// 无竞争基线
post(10);
const baseline = stats.holdTimes.slice(-10);
const baselineMax = Math.max(...baseline);
stats.holdTimes = [];

// 强竞争：一边持续读（模拟 WorkBuddy 侧读进程），一边投递
const iv = setInterval(() => {
  try { fs.readFileSync(storePath, 'utf8'); } catch (_e) { /* ignore */ }
}, 0);
post(40);
clearInterval(iv);

fs.renameSync = origRename;
fs.writeFileSync = origWrite;

const finalCount = JSON.parse(fs.readFileSync(storePath, 'utf8')).instructions.length;
const contended = stats.holdTimes;
const contendedMax = Math.max(...contended);
const over50 = contended.filter((t) => t > 50).length;
const overBudget = contended.filter((t) => t > 1000).length;

process.stdout.write('=== 锁持有时长诊断 ===\n');
process.stdout.write(`无竞争基线 enqueue: max=${baselineMax}ms  avg=${(baseline.reduce((a, b) => a + b, 0) / baseline.length).toFixed(1)}ms\n`);
process.stdout.write(`强竞争 enqueue: max=${contendedMax}ms  avg=${(contended.reduce((a, b) => a + b, 0) / contended.length).toFixed(1)}ms\n`);
process.stdout.write(`强竞争中 >50ms 的次数: ${over50}/${contended.length}\n`);
process.stdout.write(`强竞争中 >1000ms(锁获取预算) 的次数: ${overBudget}/${contended.length}\n`);
process.stdout.write(`单次 rename 最大耗时: ${stats.renameMaxSpan}ms | rename 总尝试: ${stats.renameAttempts} | tmp 写入: ${stats.storeWrites}\n`);
process.stdout.write(`失败: ${stats.failures.length} ${JSON.stringify(stats.failures.slice(0, 3))}\n`);
process.stdout.write(`落盘条数: ${finalCount} / 期望 ${10 + 40}\n`);

// 预算对比：锁等待总预算 vs 临界区内 rename 最坏退避。
// 注意 LOCK_RETRY 已改为指数退避 + 抖动（不再有单一 delayMs），
// 故用 store.totalBackoffBudget() 统一计算，与实现口径一致。
const lockBudget = typeof store.totalBackoffBudget === 'function'
  ? store.totalBackoffBudget(store.LOCK_RETRY)
  : store.LOCK_RETRY.attempts * store.LOCK_RETRY.delayMs;
const renameBudget = typeof store.totalBackoffBudget === 'function'
  ? store.totalBackoffBudget(store.RENAME_RETRY)
  : (() => {
    let sum = 0;
    for (let a = 0; a < store.RENAME_RETRY.attempts - 1; a += 1) {
      sum += Math.min(store.RENAME_RETRY.maxDelayMs, store.RENAME_RETRY.baseDelayMs * 2 ** a);
    }
    return sum;
  })();
const criticalBudget = store.CRITICAL_SECTION_BUDGET_MS;
process.stdout.write('\n=== 预算对比 ===\n');
process.stdout.write(`rename 最坏退避总时长 (RENAME_RETRY, 含抖动)     = ${renameBudget}ms\n`);
process.stdout.write(`临界区预算 (CRITICAL_SECTION_BUDGET_MS)        = ${criticalBudget}ms\n`);
process.stdout.write(`锁等待总预算 (LOCK_RETRY 指数退避, 含抖动)      = ${lockBudget}ms\n`);
process.stdout.write(`LOCK_STALE_MS                                = ${store.LOCK_STALE_MS}ms\n`);
process.stdout.write(renameBudget > criticalBudget || criticalBudget > lockBudget || lockBudget > store.LOCK_STALE_MS
  ? '>>> 结构性缺陷：预算链被破坏（rename < 临界区 < 锁预算 < LOCK_STALE_MS 必须成立）\n'
  : `>>> 预算充足：rename(${renameBudget}) < 临界区(${criticalBudget}) < 锁预算(${lockBudget}) < STALE(${store.LOCK_STALE_MS})，`
    + `比值 ${(lockBudget / renameBudget).toFixed(1)}x\n`);

fs.rmSync(dir, { recursive: true, force: true });
