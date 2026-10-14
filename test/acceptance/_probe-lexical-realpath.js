'use strict';

/**
 * 判别力自证用 Node 预载脚本（仅供 test/acceptance/f04-link-boundary.js 使用）。
 *
 * 目的：把 `fs.realpathSync.native` 退化为「词法 path.resolve」，从而模拟一个
 * 「未做真实目标收口」的实现（即 F04 整改前的旧行为）。
 *
 * 用法：在子进程环境里设置
 *   NODE_OPTIONS=--require <本文件绝对路径>
 * 于是被测 server.js 启动时 `lib/paths.js` 的 `toCanonical()` 会走退化实现：
 *   - 真实包含判定退化为词法前缀比较；
 *   - 目录联接 / 符号链接指向根外时不再被发现。
 *
 * 期望：只有在退化后越界内容「确实出现」，F04 的越界断言才具备判别力；
 * 若退化后仍不出现，说明用例根本抓不到它声称要抓的缺陷。
 *
 * 注意：只覆盖 `realpathSync.native`，不覆盖 `fs.realpathSync` 本身，
 * 以免影响 Node 自身的模块加载路径解析。
 */

const fs = require('fs');
const path = require('path');

try {
  fs.realpathSync.native = function native(p) {
    return path.resolve(p);
  };
} catch (_error) {
  /* 若运行时不允许覆盖，则保持原样；F04 的自证检查会据此报告。 */
}

module.exports = {};
