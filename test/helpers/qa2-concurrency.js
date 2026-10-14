'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：新设计**彻底删除**了「单文件 instructions.json + lockfile 锁」，
 *   本脚本引用的 storePath / .lock / LOCK_TIMEOUT 均随之删除，旧逻辑无法再运行。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   等价保证已由下列现行用例接管：
 *     并发零丢失 / 无重复 / 状态机自洽
 *       → test/qa-verify.js  D11-1 / D11-2 / D11-3 / D12-1 / D12-5 / D12-6
 *       （maildir 每记录独立文件 + link/unlink 原子领取；逐条内容比对）
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-concurrency：针对已删除的 lockfile 设计；等价保证见 test/qa-verify.js D11/D12 组。\n');
  process.exit(0);
}

/**
 * QA 第2轮独立并发验证（不依赖工程师的 D12-6 脚本）。
 *
 * 目标：独立复现「多进程并发投递 + 并发读压力」下的 P0 修复是否真的有效。
 * 与工程师版本的差异（刻意加强）：
 *   - 进程数：4 写 + 2 读（工程师版仅 1 写 + 1 读）
 *   - 每进程投递：60 条（合计 240 条，远超 60）
 *   - 读压力：2 个裸 fs 忙轮询读者 + 1 个用 bridge 工具轮询的读者
 *   - 判据：零丢失 + id 无重复 + JSON 无损坏 + 队列内容与投递内容完全一致
 *
 * 额外检查：
 *   - 残留 .tmp 文件数（rename 失败会留 tmp）
 *   - 残留 .lock 文件
 *   - 每条指令内容都能在落盘 JSON 中找到（不只是数个数）
 *
 * 运行：node test/helpers/qa2-concurrency.js [rounds]
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const NODE_BIN = process.execPath;
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-qa2-conc-'));
const TEST_MARK = 'QA2C-' + crypto.randomBytes(4).toString('hex');

/** 写进程数。 */
const WRITERS = 4;
/** 每个写进程投递条数。 */
const PER_WRITER = 60;
/** 裸 fs 读者进程数。 */
const RAW_READERS = 2;

/**
 * 构造 bridge 客户端 worker 脚本。
 *
 * @param {string} store store 路径。
 * @param {string} body  worker 主体。
 * @return {string} 完整脚本。
 */
function bridgeWorkerScript(store, body) {
  return [
    "const { spawn } = require('child_process');",
    `const store = ${JSON.stringify(store)};`,
    'const child = spawn(process.execPath, [' + JSON.stringify(SERVER) + '], {',
    "  stdio: ['pipe','pipe','inherit'],",
    `  env: { ...process.env, TASK: '1', WB_BRIDGE_STORE: store, WB_BRIDGE_LOG: '0' },`,
    '});',
    'let buf = "";',
    "child.stdout.setEncoding('utf8');",
    "child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) emit(l); } });",
    'const pend = new Map();',
    'let nextId = 1;',
    'function emit(line) { let m; try { m = JSON.parse(line); } catch (_e) { return; } if (m.id !== undefined && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); r(m); } }',
    'function call(name, args) {',
    '  const id = nextId++;',
    "  return new Promise((res) => { pend.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\\n'); });",
    '}',
    'const out = {};',
    'function report(k, v) { out[k] = v; }',
    'async function main() {',
    body,
    '  try { child.kill(); } catch (_e) {}',
    '  process.stdout.write("@@@" + JSON.stringify(out));',
    '  process.exit(0);',
    '}',
    'main();',
  ].join('\n');
}

/**
 * 运行一个 worker 脚本并解析其 @@@ 报告。
 *
 * @param {string} script 脚本内容。
 * @return {Promise<Object>} 报告对象。
 */
function runWorker(script) {
  return new Promise((resolve) => {
    const p = spawn(NODE_BIN, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const i = out.indexOf('@@@');
      if (i === -1) {
        resolve({ __error: 'no report', stdout: out.slice(-800), stderr: err.slice(-800) });
        return;
      }
      try {
        resolve(JSON.parse(out.slice(i + 3)));
      } catch (e) {
        resolve({ __error: 'bad json: ' + e.message, raw: out.slice(i + 3, i + 300) });
      }
    });
  });
}

/**
 * 构造一个裸 fs 忙轮询读者脚本。
 *
 * @param {string} store store 路径。
 * @param {number} durationMs 持续时长。
 * @return {string} 脚本。
 */
function rawReaderScript(store, durationMs) {
  return [
    "const fs = require('fs');",
    `const p = ${JSON.stringify(store)};`,
    'let reads = 0, bad = 0, missing = 0;',
    'const t0 = Date.now();',
    `while (Date.now() - t0 < ${durationMs}) {`,
    '  reads++;',
    "  let raw;",
    "  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { missing++; continue; }",
    '  try { const j = JSON.parse(raw); if (!Array.isArray(j.instructions)) bad++; }',
    '  catch (e) { bad++; }',
    '}',
    "process.stdout.write('@@@' + JSON.stringify({ reads, bad, missing }));",
    'process.exit(0);',
  ].join('\n');
}

/**
 * 执行一轮并发验证。
 *
 * @param {number} round 轮次。
 * @return {Promise<Object>} 结果摘要。
 */
async function runRound(round) {
  const dir = path.join(QA_ROOT, `r${round}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = path.join(dir, 'store', 'instructions.json');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  // 预置一个空队列文件，避免首批 rename 时目标不存在带来的额外变量
  fs.writeFileSync(store, JSON.stringify({ version: 1, updatedAt: '', instructions: [] }, null, 2), 'utf8');

  const writerScript = (w) => bridgeWorkerScript(store, [
    'let ok = 0; const errs = []; const ids = []; const sent = [];',
    `for (let k = 0; k < ${PER_WRITER}; k++) {`,
    `  const text = 'w${w}-${TEST_MARK}-' + k;`,
    "  const r = await call('wb_send_instruction', { instruction: text, priority: k % 3 === 0 ? 'high' : (k % 3 === 1 ? 'normal' : 'low') });",
    '  if (r.result && r.result.isError) {',
    '    const e = JSON.parse(r.result.content[0].text).error;',
    "    errs.push(e.code + ' | ' + String(e.message).slice(0, 100));",
    '  } else { ok++; sent.push(text); ids.push(r.result.content[0].text ? JSON.parse(r.result.content[0].text).instructionId : null); }',
    '}',
    "report('ok', ok); report('errs', errs); report('ids', ids); report('sent', sent);",
  ].join('\n'));

  const toolReaderScript = bridgeWorkerScript(store, [
    'let polls = 0;',
    'for (let i = 0; i < 150; i++) {',
    "  await call('wb_instruction_stats', {});",
    "  await call('wb_pending_instructions', { limit: 5, markPicked: false });",
    '  polls++;',
    '}',
    "report('polls', polls);",
  ].join('\n'));

  const tasks = [];
  for (let w = 0; w < WRITERS; w += 1) tasks.push(runWorker(writerScript(w)));
  for (let r = 0; r < RAW_READERS; r += 1) tasks.push(runWorker(rawReaderScript(store, 5000)));
  tasks.push(runWorker(toolReaderScript));

  const reports = await Promise.all(tasks);
  const writers = reports.slice(0, WRITERS);
  const rawReaders = reports.slice(WRITERS, WRITERS + RAW_READERS);
  const toolReader = reports[WRITERS + RAW_READERS];

  const totalOk = writers.reduce((a, w) => a + (w.ok || 0), 0);
  const allErrs = writers.flatMap((w) => w.errs || []);
  const allIds = writers.flatMap((w) => w.ids || []);
  const expected = WRITERS * PER_WRITER;

  const final = JSON.parse(fs.readFileSync(store, 'utf8'));
  const persisted = final.instructions.length;

  // 残留文件检查
  const storeDir = path.dirname(store);
  const leftovers = fs.readdirSync(storeDir).filter((f) => f.includes('.tmp-') || f.endsWith('.lock'));

  // 内容完整性：**仅对「成功入队」的指令**要求其内容能在落盘 JSON 中找到。
  // 被显式拒绝（LOCK_TIMEOUT）的指令本就不应落盘，不能算作缺失。
  const texts = new Set(final.instructions.map((i) => i.instruction));
  const succeededTexts = writers.flatMap((w) => w.sent || []);
  const missingTexts = succeededTexts.filter((t) => !texts.has(t));
  // 指令 id 不得重复（crypto.randomUUID 碰撞 / 覆盖写会导致重复）
  const uniqueIds = new Set(allIds.filter(Boolean));
  const dupIds = allIds.filter(Boolean).length - uniqueIds.size;
  const readStats = rawReaders.map((r) => ({ reads: r.reads || 0, bad: r.bad || 0, missing: r.missing || 0 }));
  const totalRawReads = readStats.reduce((a, r) => a + r.reads, 0);

  return {
    round,
    expected,
    totalOk,
    persisted,
    allErrs,
    dupIds,
    missingTexts,
    leftovers,
    readStats,
    totalRawReads,
    toolPolls: toolReader.polls || 0,
    rawReportErrors: reports.filter((r) => r.__error),
  };
}

/**
 * 主流程。
 *
 * @return {Promise<void>} 完成。
 */
async function main() {
  const rounds = Number(process.argv[2]) || 3;
  fs.mkdirSync(QA_ROOT, { recursive: true });
  process.stdout.write('QA 第2轮 —— 独立并发验证\n');
  process.stdout.write(`配置: ${WRITERS} 写进程 x ${PER_WRITER} 条 = ${WRITERS * PER_WRITER} 投递 | `
    + `${RAW_READERS} 裸fs读者 + 1 bridge工具读者 | 轮次=${rounds}\n`);
  process.stdout.write(`mark: ${TEST_MARK}\n`);

  const summaries = [];
  let failed = 0;
  for (let r = 1; r <= rounds; r += 1) {
    // eslint-disable-next-line no-await-in-loop
    const s = await runRound(r);
    summaries.push(s);
    const problems = [];
    if (s.rawReportErrors.length) problems.push(`worker 异常: ${JSON.stringify(s.rawReportErrors).slice(0, 300)}`);
    // 判据 1（核心 P0）：绝不能有静默丢失 —— 落盘数必须 === 成功入队数。
    if (s.persisted !== s.totalOk) problems.push(`落盘 ${s.persisted} != 成功入队 ${s.totalOk}（静默丢失指令）`);
    // 判据 2：绝不能出现 STORE_WRITE_FAILED / STORE_RENAME_FAILED（原 P0 的失败码）。
    const silentCodes = s.allErrs.filter((e) => /STORE_WRITE_FAILED|STORE_RENAME_FAILED/.test(String(e)));
    if (silentCodes.length) problems.push(`出现静默丢失类错误 ${silentCodes.length} 次: ${silentCodes[0]}`);
    // 判据 3：成功入队的每一条内容都必须能在落盘 JSON 中找到。
    if (s.missingTexts.length) problems.push(`成功入队但内容缺失 ${s.missingTexts.length} 条，例: ${s.missingTexts.slice(0, 3).join(',')}`);
    // 判据 4：id 无重复、无残留 tmp/lock 文件。
    if (s.dupIds !== 0) problems.push(`instructionId 重复 ${s.dupIds} 个`);
    if (s.leftovers.length) problems.push(`残留文件: ${s.leftovers.join(', ')}`);
    // 判据 5：并发读永不看到半截 JSON。
    for (const [i, rstats] of s.readStats.entries()) {
      if (rstats.bad !== 0) problems.push(`裸fs读者#${i} 读到 ${rstats.bad} 次损坏 JSON`);
    }
    if (s.totalOk === 0) problems.push('全部投递失败，测试无效');
    // 显式可恢复失败（LOCK_TIMEOUT）不计入 problems，但要记录——它是调用方可见的失败。
    const lockTimeouts = s.allErrs.filter((e) => /LOCK_TIMEOUT/.test(String(e))).length;

    const errCodes = {};
    for (const e of s.allErrs) {
      const k = String(e).split('|')[0].trim();
      errCodes[k] = (errCodes[k] || 0) + 1;
    }
    const readsTotal = s.totalRawReads;
    if (problems.length === 0) {
      process.stdout.write(`  PASS  round ${r}: 落盘 ${s.persisted} === 成功入队 ${s.totalOk}（零静默丢失）；`
        + `裸fs读 ${readsTotal} 次 0 损坏；bridge轮询 ${s.toolPolls} 次；残留文件 0；`
        + `LOCK_TIMEOUT ${lockTimeouts} 次（显式可恢复）\n`);
    } else {
      failed += 1;
      process.stdout.write(`  FAIL  round ${r}:\n${problems.map((p) => '          - ' + p).join('\n')}\n`);
      if (s.allErrs.length) process.stdout.write(`          错误码分布: ${JSON.stringify(errCodes)}\n`);
    }
  }

  process.stdout.write('\n=== SUMMARY ===\n');
  process.stdout.write(`rounds=${rounds} | failed=${failed}\n`);
  const totReads = summaries.reduce((a, s) => a + s.totalRawReads, 0);
  const totOk = summaries.reduce((a, s) => a + s.totalOk, 0);
  const totExp = summaries.reduce((a, s) => a + s.expected, 0);
  process.stdout.write(`总投递 ${totExp} | 成功 ${totOk} | 总裸fs并发读 ${totReads} 次\n`);
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write(`FATAL: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(2);
});
