'use strict';

/**
 * F08 · P2 · 尾读起点恰好在完整行边界时仍丢弃第一条记录
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   覆盖行首、行中、换行符处、连续空行、CRLF、UTF-8 多字节边界；
 *   完整行不丢、残行按约定计数或标记，搜索与精读一致。
 *
 * 复现构造：两条消息的 JSONL，maxBytes 正好等于第二行完整字节数，
 *   使采样窗口起点恰好落在完整行首 → 第二行不得被丢弃。
 *
 * 本用例既做库级精确断言（lib/jsonl.js readRecords），也做端到端搜索断言
 *   （wb_search_sessions），两者必须一致。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const NEEDLE = 'TAIL_NEEDLE_F08';

/** 生成两条消息的 JSONL：line1 + '\n' + line2。 */
function buildTwoLine(rec1, rec2) {
  return `${JSON.stringify(rec1)}\n${JSON.stringify(rec2)}`;
}

(async () => {
  process.stdout.write('=== F08 · P2 · 尾读窗口边界 ===\n');
  const sandbox = H.makeSandbox('f08');

  const rec1 = { type: 'message', role: 'user', content: 'FIRST_LINE_FILLER_F08', timestamp: 1 };
  const rec2 = { type: 'message', role: 'assistant', content: `containing ${NEEDLE}`, timestamp: 2 };
  const fileBody = buildTwoLine(rec1, rec2);
  const bytes2 = Buffer.byteLength(JSON.stringify(rec2), 'utf8');

  const probeDir = path.join(sandbox.root, 'probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const probeFile = path.join(probeDir, 'two-line.jsonl');
  fs.writeFileSync(probeFile, fileBody, 'utf8');

  // ---- 库级：readRecords，maxBytes 恰为第二行完整字节数 ----
  await H.check('F08.1 readRecords 尾窗起点落在行首时不得丢弃该完整行', () => {
    let jsonl;
    try {
      jsonl = require(path.join(H.PROJECT_ROOT, 'lib', 'jsonl.js'));
    } catch (e) {
      H.raiseEnv(`无法加载 lib/jsonl.js: ${e.message}`);
    }
    if (typeof jsonl.readRecords !== 'function') H.raiseEnv('lib/jsonl.js 未导出 readRecords');
    const parsed = jsonl.readRecords(probeFile, { maxBytes: bytes2, tail: true });
    const texts = parsed.records.map((r) => JSON.stringify(r.value));
    H.assert(texts.some((t) => t.includes(NEEDLE)),
      `尾窗完整行被丢弃: ${JSON.stringify({ records: parsed.records.length, partialFirstLine: parsed.partialFirstLine, bytesRead: parsed.bytesRead })}`);
  });

  await H.check('F08.2 readRecords 在窗口覆盖整行时 records 数量正确', () => {
    let jsonl;
    try {
      jsonl = require(path.join(H.PROJECT_ROOT, 'lib', 'jsonl.js'));
    } catch (e) {
      H.raiseEnv(`无法加载 lib/jsonl.js: ${e.message}`);
    }
    if (typeof jsonl.readRecords !== 'function') H.raiseEnv('lib/jsonl.js 未导出 readRecords');
    const parsed = jsonl.readRecords(probeFile, { maxBytes: bytes2, tail: true });
    H.assert(parsed.records.length === 1,
      `期望恰好 1 条完整记录，实际 ${parsed.records.length}（partialFirstLine=${parsed.partialFirstLine}）`);
    H.assert(parsed.partialFirstLine === false,
      `起点落在行首却标记为 partialFirstLine=true（导致丢行）`);
  });

  // ---- 端到端：搜索必须命中 ----
  await H.check('F08.3 wb_search_sessions 在同样尾窗下必须命中 NEEDLE', async () => {
    // 造一个会话文件与索引，使搜索经 tail 读取走到同一窗口
    const cid = 'f08-session';
    const slugDir = path.join(sandbox.projects, 'c-wbtest');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, `${cid}.jsonl`), fileBody, 'utf8');
    const appDir = path.join(sandbox.workbuddy, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ conversationId: cid, workDir: 'C:\\wbtest', startedAt: '2026-01-01T00:00:00.000Z', resumedAt: '2026-01-02T00:00:00.000Z' }],
    }));

    const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
    const client = new H.Client(env);
    try {
      await client.initialize();
      const res = await client.call('wb_search_sessions', { keyword: NEEDLE, maxBytesPerSession: bytes2, maxSessions: 5 });
      const t = H.parseTool(res);
      H.assert(t.ok, `搜索调用失败: ${JSON.stringify(t).slice(0, 300)}`);
      H.assert(t.payload.hitCount >= 1,
        `窗口内完整行未被搜索命中: ${JSON.stringify(t.payload).slice(0, 300)}`);
    } finally {
      await client.close();
    }
  });

  // ---- CRLF 边界 ----
  await H.check('F08.4 CRLF 行尾：完整行不丢', () => {
    let jsonl;
    try {
      jsonl = require(path.join(H.PROJECT_ROOT, 'lib', 'jsonl.js'));
    } catch (e) {
      H.raiseEnv(`无法加载 lib/jsonl.js: ${e.message}`);
    }
    if (typeof jsonl.readRecords !== 'function') H.raiseEnv('lib/jsonl.js 未导出 readRecords');
    const crlfFile = path.join(probeDir, 'crlf.jsonl');
    fs.writeFileSync(crlfFile, `${JSON.stringify(rec1)}\r\n${JSON.stringify(rec2)}`, 'utf8');
    const bytes2crlf = Buffer.byteLength(JSON.stringify(rec2), 'utf8');
    const parsed = jsonl.readRecords(crlfFile, { maxBytes: bytes2crlf, tail: true });
    H.assert(parsed.records.some((r) => JSON.stringify(r.value).includes(NEEDLE)),
      `CRLF 场景尾窗完整行被丢弃（records=${parsed.records.length}）`);
  });

  H.finish('F08', `第二行字节数=${bytes2}`);
})().catch((e) => { H.fail('F08 harness', (e && e.stack) || String(e)); H.finish('F08'); });
