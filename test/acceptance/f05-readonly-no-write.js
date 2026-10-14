'use strict';

/**
 * F05 · P1 · 损坏恢复会使只读查询写文件，并移走后来提交的健康队列
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   分别覆盖损坏 JSON、结构错误 JSON、备份 rename 失败、旧损坏读者与新健康提交交错。
 *   只读调用前后目标、备份、临时文件、锁及目录都必须无写入变化。
 *   数据损坏不可被等价化为「正常空队列」。
 *
 * 目标语义：read 严格只读，只认 ENOENT 为空队列；损坏只计数上报
 *   （corruptCount / corruptFiles），**永不自动移动或修复**。
 *
 * 证据方式：store 目录整树快照（含目录项 + 文件哈希）前后比对。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 在 store 下准备 maildir 布局并返回关键路径。 */
function prepareStore(store) {
  const dirs = ['pending', 'picked', 'done', 'tmp'];
  for (const d of dirs) fs.mkdirSync(path.join(store, d), { recursive: true });
  return {
    pending: path.join(store, 'pending'),
    picked: path.join(store, 'picked'),
    done: path.join(store, 'done'),
    tmp: path.join(store, 'tmp'),
  };
}

(async () => {
  process.stdout.write('=== F05 · P1 · 只读零写入 + 损坏只计数不移走 ===\n');
  const sandbox = H.makeSandbox('f05');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  const paths = prepareStore(sandbox.store);

  // 一个合法 pending 指令 + 一个损坏 JSON + 一个结构错误 JSON
  const good = path.join(paths.pending, 'aaaaaaaa-0000-4000-8000-000000000001.json');
  fs.writeFileSync(good, JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'pending', instruction: 'GOOD-1', createdAt: '2026-01-01T00:00:00.000Z' }));
  const corrupt = path.join(paths.pending, 'aaaaaaaa-0000-4000-8000-000000000002.json');
  const corruptBytes = '{"id":"aaaa","status":"pending","instruction":';  // 不完整 JSON
  fs.writeFileSync(corrupt, corruptBytes);
  const structBad = path.join(paths.pending, 'aaaaaaaa-0000-4000-8000-000000000003.json');
  fs.writeFileSync(structBad, JSON.stringify({ instructions: { not: 'an array' }, weird: true }));

  const before = H.snapshotTree(sandbox.store);

  await H.check('F05.1 wb_instruction_stats 是严格只读（前后快照零变化）', async () => {
    const client = new H.Client(env);
    try {
      await client.initialize();
      const res = await client.call('wb_instruction_stats', {});
      const t = H.parseTool(res);
      H.assert(t.ok, `stats 调用失败: ${JSON.stringify(t).slice(0, 300)}`);
    } finally {
      await client.close();
    }
    const diffs = H.diffSnapshots(before, H.snapshotTree(sandbox.store));
    H.assert(diffs.length === 0, `只读 stats 产生了写入/移动:\n        ${diffs.join('\n        ')}`);
  });

  await H.check('F05.2 损坏文件被计数上报（corruptCount / corruptFiles），且未被移走', async () => {
    const client = new H.Client(env);
    let payload = null;
    try {
      await client.initialize();
      const res = await client.call('wb_instruction_stats', {});
      const t = H.parseTool(res);
      H.assert(t.ok, `stats 调用失败: ${JSON.stringify(t).slice(0, 300)}`);
      payload = t.payload || {};
    } finally {
      await client.close();
    }
    const cc = payload.corruptCount;
    const cf = payload.corruptFiles;
    const hasCount = typeof cc === 'number' && cc >= 1;
    const hasFiles = Array.isArray(cf) && cf.length >= 1;
    H.assert(hasCount || hasFiles,
      `损坏未被计数上报（期望 corruptCount>=1 或 corruptFiles 非空）: ${JSON.stringify(payload).slice(0, 300)}`);
    H.assert(fs.existsSync(corrupt), '损坏文件被移走/删除（应原地保留只计数）');
    H.assert(fs.readFileSync(corrupt, 'utf8') === corruptBytes, '损坏文件内容被改写');
  });

  await H.check('F05.3 损坏不被等价为「正常空队列」', async () => {
    const client = new H.Client(env);
    let payload = null;
    try {
      await client.initialize();
      const res = await client.call('wb_instruction_stats', {});
      const t = H.parseTool(res);
      payload = t.ok ? (t.payload || {}) : null;
    } finally {
      await client.close();
    }
    if (!payload) H.raiseSkip('stats 未返回可解析负载');
    const cc = payload.corruptCount;
    const cf = payload.corruptFiles;
    const indicatesCorruption = (typeof cc === 'number' && cc >= 1) || (Array.isArray(cf) && cf.length >= 1) || payload.corrupt === true;
    H.assert(indicatesCorruption, `stats 未以任何字段暴露损坏（不可能与正常空队列区分）: ${JSON.stringify(payload).slice(0, 300)}`);
  });

  await H.check('F05.4 markPicked:false 预览调用零写入', async () => {
    const client = new H.Client(env);
    const snap = H.snapshotTree(sandbox.store);
    try {
      await client.initialize();
      await client.call('wb_pending_instructions', { markPicked: false, limit: 5 });
    } finally {
      await client.close();
    }
    const diffs = H.diffSnapshots(snap, H.snapshotTree(sandbox.store));
    H.assert(diffs.length === 0, `只读预览产生了写入:\n        ${diffs.join('\n        ')}`);
  });

  await H.check('F05.5 无 .corrupt-* 备份残留（目标语义：损坏不自动移动）', () => {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(sandbox.store);
    const backups = files.filter((p) => /\.corrupt-/.test(p));
    H.assert(backups.length === 0, `发现自动备份残留: ${backups.join(', ')}`);
  });

  H.finish('F05');
})().catch((e) => { H.fail('F05 harness', (e && e.stack) || String(e)); H.finish('F05'); });
