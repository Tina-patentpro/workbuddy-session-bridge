'use strict';

/**
 * D11-2c 故障模拟预载 · 延迟 link(picked→done/<id>)（进程执行屏障）。
 *
 * 仅用于测试子进程（NODE_OPTIONS=--require），**不修改生产源码**。
 * 模拟方式：当 `fs.linkSync` 的目标为 `.../done/<ID>.json` 且为首次调用时，先睡 `WB_TEST_DELAY_MS`
 *       再执行真实 link —— 人为制造「B 读 picked 之后、写 done 之前的窗口」。
 *
 * 用途（D11-2c 变体3 判别）：验证当并发的 A 因 rename 失败而撤销/推进 picked 时，
 *   B 的 link(picked→done) 落入 ENOENT 后**不得误报终态**（done 不存在时须报可重试错误）。
 */

const fs = require('fs');
const path = require('path');

const ID = process.env.WB_TEST_DELAY_ID || '';
const DELAY_MS = Number(process.env.WB_TEST_DELAY_MS || 0);
let delayed = false;

/** 同步睡眠（Atomics 等待）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const origLink = fs.linkSync;
fs.linkSync = function patchedLink(src, dst) {
  const target = String(dst);
  const isDoneDest = /[\\/]done[\\/]/.test(target) && path.basename(target) === `${ID}.json`;
  if (ID && isDoneDest && !delayed) {
    delayed = true;
    if (DELAY_MS > 0) sleepSync(DELAY_MS);
  }
  return origLink.call(fs, src, dst);
};

module.exports = {};
