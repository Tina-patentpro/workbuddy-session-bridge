'use strict';

/**
 * 领取临界窗口故障模拟预载（仅供 test/acceptance/f02b、f02c 使用）。
 *
 * 目的：在**不修改生产源码**的前提下，把 `fs.linkSync`（maildir 领取的原子互斥锚点）
 * 包装为受控故障，从而在本机（Windows）真实复现审计方用「进程屏障 / 操作失败模拟」
 * 构造的临界窗口场景，替代不可用的 SIGSTOP：
 *
 *   WB_TEST_LINK_FAULT=pause   → 真实 link 成功后**阻塞** N 毫秒（模拟持锁者被暂停在
 *                                「link 成功、尚未 unlink 源名」之间）。
 *   WB_TEST_LINK_FAULT=crash   → 真实 link 成功后立即 `process.exit(9)`（模拟持锁者
 *                                崩溃在窗口内：目标已建、源名未删、tmp 未清理）。
 *   WB_TEST_LINK_FAULT=phantom → 目标已存在(EEXIST)时仍强行「成功」（先删目标再链接），
 *                                模拟「互斥原语退化为非原子」的旧行为，用于自证用例判别力。
 *
 * 触发范围由 WB_TEST_LINK_ID 限定：仅当目标文件 basename 为 `<id>.json` 时实施模拟，
 * 避免影响无关记录。仅 pause/crash 限定在 `picked/` 目录（领取目标），
 * 因为「领取临界窗口」发生在 pending → picked 的迁移。
 *
 * 该预载只经子进程 `NODE_OPTIONS=--require` 生效，测试主进程与生产源码均不感知。
 */

const fs = require('fs');
const path = require('path');

const origLinkSync = fs.linkSync;
const mode = process.env.WB_TEST_LINK_FAULT;
const targetId = process.env.WB_TEST_LINK_ID || '';
const pauseMs = Number(process.env.WB_TEST_LINK_PAUSE_MS || 4000);

/**
 * 同步阻塞睡眠（Atomics.wait），与 store.js 的 sleepSync 同法。
 *
 * @param {number} ms 毫秒。
 * @return {void}
 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** 目标是否位于 picked 目录（领取目标）。 */
function isPickedDest(dst) {
  return /[\\/]picked[\\/]/i.test(String(dst));
}

/** 目标文件名是否匹配受控 id。 */
function idMatches(dst) {
  if (targetId === '') return true;
  return path.basename(String(dst)) === `${targetId}.json`;
}

if (mode === 'pause' || mode === 'crash') {
  fs.linkSync = function patchedLinkSyncForWindow(src, dst) {
    // 先执行真实 link：失败（EEXIST/ENOENT）会在此抛出，不进入故障模拟。
    const result = origLinkSync.call(fs, src, dst);
    if (isPickedDest(dst) && idMatches(dst)) {
      if (mode === 'pause') sleepSync(pauseMs);
      else process.exit(9); // 崩溃在 link 后、unlink 前。
    }
    return result;
  };
} else if (mode === 'phantom') {
  fs.linkSync = function patchedLinkSyncPhantom(src, dst) {
    try {
      return origLinkSync.call(fs, src, dst);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        // 模拟「rename 幻影成功」：第二个领取者也「成功」，制造双赢家。
        try { fs.unlinkSync(dst); } catch (_e) { /* ignore */ }
        return origLinkSync.call(fs, src, dst);
      }
      throw error;
    }
  };
}

module.exports = {};
