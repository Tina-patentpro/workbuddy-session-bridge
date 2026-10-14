'use strict';

/**
 * D11-2c 故障模拟预载 · rename(tmp→picked/<id>) 失败。
 *
 * 仅用于测试子进程（经 NODE_OPTIONS=--require 预载），**不修改生产源码**。
 * 模拟方式：当 `fs.renameSync` 的目标为 `.../picked/<ID>.json` 时，首次先睡 `WB_TEST_RENAME_FAIL_SLEEP_MS`，
 *       其后（含重试）一律抛 EPERM —— 模拟 Windows 上「替换目标失败、退避重试耗尽」。
 *
 * 期望（修复后）：
 *   - 锚点 link(pending→picked) 成功后即视为「已领取」，rename 失败**不回滚**；
 *   - 静止状态该 id 恰一份（并发完成落 done），不得残留 pending + done 跨状态双份。
 */

const fs = require('fs');
const path = require('path');

const ID = process.env.WB_TEST_RENAME_FAIL_ID || '';
const SLEEP_MS = Number(process.env.WB_TEST_RENAME_FAIL_SLEEP_MS || 0);
let slept = false;

/** 同步睡眠（Node 无同步 sleep，用 Atomics 等待）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const origRename = fs.renameSync;
fs.renameSync = function patchedRename(from, to) {
  const target = String(to);
  const isPickedDest = /[\\/]picked[\\/]/.test(target) && path.basename(target) === `${ID}.json`;
  if (ID && isPickedDest) {
    if (!slept) { slept = true; if (SLEEP_MS > 0) sleepSync(SLEEP_MS); }
    const error = new Error(`EPERM: simulated rename failure: ${target}`);
    error.code = 'EPERM';
    throw error;
  }
  return origRename.call(fs, from, to);
};

module.exports = {};
