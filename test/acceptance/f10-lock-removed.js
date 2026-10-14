'use strict';

/**
 * F10 · P2 · 锁状态查询的瞬态错误被当成锁已消失，导致空转超时
 *
 * 目标语义（主理人已定死）：**彻底移除 lockfile / LOCK_* / 陈旧锁抢占逻辑**。
 *   因此 F10 的闭合方式 = 取消「锁状态查询」这一整类分支：不再有 stat/unlink 的
 *   陈旧锁判断，也就不会因瞬态 errno 被误判为「锁已消失」而零等待耗尽预算。
 *
 * 本用例验证「无锁」这一目标语义是否落地：
 *   (a) lib/store.js 源码不再含陈旧锁 / 加解锁相关符号；
 *   (b) 运行时不再产生任何 .lock 文件（故障模拟式：跑一轮读写并监测）。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 陈旧锁 / 加解锁相关符号（出现即视为未移除）。 */
const LOCK_SYMBOLS = ['LOCK_STALE_MS', 'breakStaleLock', 'acquireLock', 'releaseLock', 'lockPath'];

/** 递归收集文件。 */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

(async () => {
  process.stdout.write('=== F10 · P2 · 锁机制移除验证 ===\n');
  const sandbox = H.makeSandbox('f10');

  const storeSrcPath = path.join(H.PROJECT_ROOT, 'lib', 'store.js');

  await H.check('F10.1 lib/store.js 不再含陈旧锁 / 加解锁符号', () => {
    if (!fs.existsSync(storeSrcPath)) H.raiseEnv('lib/store.js 不存在');
    const src = fs.readFileSync(storeSrcPath, 'utf8');
    const found = LOCK_SYMBOLS.filter((s) => src.includes(s));
    H.assert(found.length === 0, `仍存在锁相关符号（目标语义要求彻底移除）: ${found.join(', ')}`);
  });

  await H.check('F10.2 运行时不再产生任何 .lock 文件', async () => {
    const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
    const client = new H.Client(env);
    try {
      await client.initialize();
      // 一轮读写，制造潜在的加锁窗口
      const send = H.parseTool(await client.call('wb_send_instruction', { instruction: 'F10-PROBE' }));
      await client.call('wb_instruction_stats', {});
      if (send.ok && send.payload && send.payload.instructionId) {
        await client.call('wb_complete_instruction', { instructionId: send.payload.instructionId, status: 'done', result: { ok: true } });
      }
    } finally {
      await client.close();
    }
    const locks = listFiles(sandbox.root).filter((p) => /\.lock$/.test(p));
    H.assert(locks.length === 0, `发现 .lock 文件: ${locks.join(', ')}`);
  });

  H.finish('F10');
})().catch((e) => { H.fail('F10 harness', (e && e.stack) || String(e)); H.finish('F10'); });
