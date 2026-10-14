'use strict';

/**
 * D11-2c 故障模拟预载 · removeSourceLink(pending/<id>) 失败。
 *
 * 仅用于测试子进程（NODE_OPTIONS=--require），**不修改生产源码**。
 * 模拟方式：对 `.../pending/<ID>.json` 的 `fs.unlinkSync` 永久抛 EPERM —— 模拟 Windows 上
 *       「源名被读端占用，删除退避重试耗尽」。
 *
 * 期望（修复后）：
 *   - 删除源失败时 `claimWithContent` 调用 `reconcileAbortedTransition` 收敛；
 *   - 静止状态该 id 恰一份（回退到 pending，由后续消费者干净领取并完成至 done），不得双份。
 */

const fs = require('fs');

const TARGET_ID = process.env.WB_TEST_UNLINK_ID || '';
const origUnlink = fs.unlinkSync;

fs.unlinkSync = function patchedUnlink(target) {
  const s = String(target);
  if (TARGET_ID && s.includes('pending') && s.endsWith(`${TARGET_ID}.json`)) {
    const error = new Error(`EPERM: simulated unlink failure for ${s}`);
    error.code = 'EPERM';
    throw error;
  }
  return origUnlink.call(fs, target);
};

module.exports = {};
