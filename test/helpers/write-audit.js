'use strict';

/**
 * QA 辅助：fs 写操作审计 preload（仅供 qa-verify.js 使用，不参与生产路径）。
 *
 * 用法：node -r ./test/helpers/write-audit.js server.js
 * 通过环境变量 WB_QA_AUDIT_FILE 指定审计日志路径（追加 JSON Lines）。
 *
 * 目的：以「被审计进程自己执行过的写 syscall」为证据判定写入边界，
 * 避免用 mtime 快照去比对一个正在被 WorkBuddy 自身持续写入的目录（噪声不可控）。
 */

const fs = require('fs');

const AUDIT_FILE = process.env.WB_QA_AUDIT_FILE;

if (AUDIT_FILE) {
  // 先抓住原始引用：审计器自身也要写文件，若用被包装后的 appendFileSync 会无限递归。
  const rawAppendFileSync = fs.appendFileSync.bind(fs);
  let recording = false;

  const record = (op, target) => {
    if (recording) return;
    recording = true;
    try {
      rawAppendFileSync(AUDIT_FILE, JSON.stringify({ op, target: String(target), pid: process.pid }) + '\n', 'utf8');
    } catch (_error) {
      /* 审计失败不影响被测进程 */
    } finally {
      recording = false;
    }
  };

  const wrap = (name) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function patched(...args) {
      record(name, args[0]);
      return original.apply(this, args);
    };
  };

  // 会创建/修改/删除文件或目录的写操作
  ['writeFileSync', 'appendFileSync', 'truncateSync', 'renameSync', 'unlinkSync',
    'rmSync', 'rmdirSync', 'copyFileSync', 'mkdirSync', 'chmodSync', 'utimesSync',
  ].forEach(wrap);

  // openSync 只有在含写标志时才记录
  const rawOpenSync = fs.openSync;
  fs.openSync = function patchedOpen(target, flags, ...rest) {
    const f = String(flags === undefined ? 'r' : flags);
    if (/[wax+]/.test(f)) record('openSync:' + f, target);
    return rawOpenSync.call(this, target, flags, ...rest);
  };

  // createWriteStream
  const rawCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function patchedCWS(target, ...rest) {
    record('createWriteStream', target);
    return rawCreateWriteStream.call(this, target, ...rest);
  };
}
