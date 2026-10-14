'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：本脚本的隔离目录以 `WB_BRIDGE_STORE=<dir>/instructions.json`（单文件）为基准，
 *   新设计中 WB_BRIDGE_STORE 语义已变更为**队列根目录**且拒绝 .json；旧基准不再成立。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   等价保证（syscall 级只读边界）已由下列现行用例接管：
 *     test/qa-verify.js  A 组（write-audit.js 拦截写 syscall）
 *                        D12-2（stats / 预览零写入）、D12-3（损坏记录不被移动）
 *                        G1 / G2 / G3（真实目录零触碰 + 哨兵）
 *   （本脚本的方法论——用 write-audit.js 拦截写 syscall 而非 mtime 快照——已被 qa-verify.js 沿用。）
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-readonly：针对已删除的单文件 store 基准；等价保证见 test/qa-verify.js A 组 / D12-2 / D12-3 / G 组。\n');
  process.exit(0);
}

/**
 * QA 第2轮：只读边界审计（fs 写 syscall 级，非 mtime 快照）。
 *
 * 方法论说明（与第1轮一致，且刻意不用 mtime）：
 *   WorkBuddy 桌面端空闲 3 秒内就会自改 logs/*.log 与 workbuddy.db-wal，
 *   mtime 快照无法区分「被测进程写的」与「桌面端写的」，故该方法不成立。
 *   本脚本用 test/helpers/write-audit.js（monkey-patch fs 写函数 + 落审计日志）
 *   捕获**被测 bridge 进程自己执行过的写 syscall**，是确定性证据。
 *
 * 审计范围：
 *   1. 隔离模式（TASK=1 + WB_BRIDGE_STORE）：所有写 syscall 必须落在 %TEMP% 隔离目录内。
 *   2. 全部只读工具（list/read/search/info/stats）：零写 syscall。
 *   3. 真实 .workbuddy 目录零写入。
 *   4. 真实 .workbuddy\task-bridge 必须不存在。
 *
 * 运行：node test/helpers/qa2-readonly.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const AUDIT_PRELOAD = path.join(__dirname, 'write-audit.js');
const NODE_BIN = process.execPath;
const REAL_WB = path.join(process.env.USERPROFILE, '.workbuddy');
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-qa2-ro-'));

const results = [];
let currentGroup = '';

/**
 * 记录检查结果。
 *
 * @param {string} name 用例名。
 * @param {function(): (Promise<*>|void)} fn 用例体。
 * @return {Promise<void>} 完成。
 */
async function check(name, fn) {
  const label = `[${currentGroup}] ${name}`;
  try {
    const detail = await fn();
    results.push({ passed: true, name });
    process.stdout.write(`  PASS  ${label}${detail ? '  — ' + detail : ''}\n`);
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    results.push({ passed: false, name, error: msg });
    process.stdout.write(`  FAIL  ${label}\n          ${String(msg).split('\n').join('\n          ')}\n`);
  }
}

/**
 * 声明分组。
 *
 * @param {string} name 分组名。
 * @return {void}
 */
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n=== ${name} ===\n`);
}

/**
 * 极简 MCP 客户端（带 write-audit preload）。
 */
class AuditClient {
  /**
   * @param {{env: Object<string,string>, auditFile: string}} options 选项。
   */
  constructor(options) {
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.exited = false;
    this.env = { ...process.env, WB_BRIDGE_LOG: '0', ...options.env, WB_QA_AUDIT_FILE: options.auditFile };
    this.child = spawn(NODE_BIN, ['-r', AUDIT_PRELOAD, SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'], env: this.env,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this.onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => { this.stderr += c; });
    this.child.on('exit', () => { this.exited = true; });
  }

  /**
   * 按行派发响应。
   *
   * @param {string} c 分片。
   * @return {void}
   */
  onData(c) {
    this.buffer += c;
    let i = this.buffer.indexOf('\n');
    while (i !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim().length > 0) {
        let m = null;
        try { m = JSON.parse(line); } catch (_e) { /* ignore */ }
        if (m && m.id !== undefined && this.pending.has(m.id)) {
          const r = this.pending.get(m.id);
          this.pending.delete(m.id);
          r(m);
        }
      }
      i = this.buffer.indexOf('\n');
    }
  }

  /**
   * 发起工具调用。
   *
   * @param {string} name 工具名。
   * @param {Object} args 参数。
   * @return {Promise<Object>} 原始 result。
   */
  call(name, args = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`超时 ${name}: ${this.stderr.slice(-300)}`));
      }, 20000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m.result || {});
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
  }

  /**
   * 关闭子进程。
   *
   * @return {void}
   */
  close() {
    try { this.child.kill(); } catch (_e) { /* ignore */ }
  }
}

/**
 * 读取审计日志。
 *
 * @param {string} file 日志路径。
 * @return {Array<Object>} 审计条目。
 */
function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

/**
 * 判定 target 是否位于 root 之内（大小写不敏感，Windows 语义）。
 *
 * @param {string} target 目标路径。
 * @param {string} root 根目录。
 * @return {boolean} 是否在根内。
 */
function within(target, root) {
  const t = path.resolve(target).toLowerCase();
  const r = path.resolve(root).toLowerCase();
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

async function main() {
  fs.mkdirSync(QA_ROOT, { recursive: true });
  process.stdout.write('QA 第2轮 —— 只读边界审计（fs 写 syscall 级）\n');
  process.stdout.write(`真实 WorkBuddy 目录: ${REAL_WB}\n`);

  const realTaskBridge = path.join(REAL_WB, 'task-bridge');

  group('R1. 隔离模式：全部写 syscall 落在 %TEMP% 内');

  await check('R1-1 写操作（send/pending/complete）只写隔离目录，绝不触碰真实 .workbuddy', async () => {
    const dir = path.join(QA_ROOT, 'r1');
    const store = path.join(dir, 'store', 'instructions.json');
    const auditFile = path.join(dir, 'audit.log');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(auditFile, { force: true });
    const client = new AuditClient({
      env: { TASK: '1', WB_BRIDGE_STORE: store },
      auditFile,
    });
    try {
      const sent = await client.call('wb_send_instruction', { instruction: 'qa2 readonly probe' });
      const id = JSON.parse(sent.content[0].text).instructionId;
      await client.call('wb_pending_instructions', { limit: 5 });
      await client.call('wb_complete_instruction', { instructionId: id, result: { ok: 1 } });
      await client.call('wb_instruction_stats', {});
      const audit = readAudit(auditFile);
      assert.ok(audit.length > 0, '审计日志为空，无法证明写入边界');
      const outside = audit.filter((a) => !within(a.target, dir));
      assert.strictEqual(outside.length, 0,
        `隔离目录外发生 ${outside.length} 次写:\n${outside.slice(0, 8).map((v) => '    ' + v.op + ' -> ' + v.target).join('\n')}`);
      // 特别确认：没有任何一条指向真实 .workbuddy
      const touchedReal = audit.filter((a) => within(a.target, REAL_WB));
      assert.strictEqual(touchedReal.length, 0,
        `触碰了真实 .workbuddy ${touchedReal.length} 次:\n${touchedReal.slice(0, 5).map((v) => '    ' + v.op + ' -> ' + v.target).join('\n')}`);
      return `${audit.length} 次写 syscall 全部在隔离目录内，真实 .workbuddy 零触碰`;
    } finally {
      client.close();
    }
  });

  group('R2. 只读工具：零写 syscall');

  await check('R2-1 4 个只读/查询工具执行后审计日志为空（零写）', async () => {
    const dir = path.join(QA_ROOT, 'r2');
    const store = path.join(dir, 'store', 'instructions.json');
    const auditFile = path.join(dir, 'audit.log');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(auditFile, { force: true });
    // 预置 store，使 stats 有东西可读（排除「文件不存在所以没写」的干扰）
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ version: 1, updatedAt: '', instructions: [] }, null, 2), 'utf8');
    const client = new AuditClient({ env: { TASK: '1', WB_BRIDGE_STORE: store }, auditFile });
    try {
      await client.call('wb_list_sessions', { limit: 5, includeCounts: true });
      await client.call('wb_search_sessions', { keyword: 'the', limit: 3 });
      await client.call('wb_read_session', { conversationId: 'ef8a2f20-d32d-40ae-a66b-7b715b9ca0ab', maxMessages: 5 });
      await client.call('wb_instruction_stats', {});
      await client.call('wb_bridge_info', {});
      const audit = readAudit(auditFile);
      assert.strictEqual(audit.length, 0,
        `只读工具产生了 ${audit.length} 次写 syscall:\n${audit.slice(0, 10).map((v) => '    ' + v.op + ' -> ' + v.target).join('\n')}`);
      return 'list/search/read/stats/info 五个只读调用零写 syscall';
    } finally {
      client.close();
    }
  });

  group('R3. 真实 WorkBuddy 目录零写入');

  await check('R3-1 只读场景下真实 .workbuddy 零写 syscall', async () => {
    const dir = path.join(QA_ROOT, 'r3');
    const store = path.join(dir, 'store', 'instructions.json');
    const auditFile = path.join(dir, 'audit.log');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(auditFile, { force: true });
    // 故意不设 WB_PROJECTS_DIR / WB_SESSIONS_INDEX —— 让它读真实数据
    const client = new AuditClient({ env: { TASK: '1', WB_BRIDGE_STORE: store }, auditFile });
    try {
      await client.call('wb_list_sessions', { limit: 10 });
      await client.call('wb_read_session', { conversationId: 'ef8a2f20-d32d-40ae-a66b-7b715b9ca0ab', maxMessages: 3 });
      const audit = readAudit(auditFile);
      const real = audit.filter((a) => within(a.target, REAL_WB));
      assert.strictEqual(real.length, 0,
        `真实 .workbuddy 被写入 ${real.length} 次:\n${real.slice(0, 8).map((v) => '    ' + v.op + ' -> ' + v.target).join('\n')}`);
      return `审计 ${audit.length} 次写 syscall（均在隔离目录），真实 .workbuddy 零写入`;
    } finally {
      client.close();
    }
  });

  group('R4. 真实 task-bridge 目录必须不存在');

  await check('R4-1 C:\\Users\\TinaD\\.workbuddy\\task-bridge\\ 不存在', () => {
    assert.ok(!fs.existsSync(realTaskBridge),
      `真实 task-bridge 目录存在（应仅存在于 %TEMP% 隔离目录）: ${realTaskBridge}`);
    return '真实 task-bridge 不存在，未污染真实 WorkBuddy 目录';
  });

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  process.stdout.write('\n=== SUMMARY ===\n');
  process.stdout.write(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}\n`);
  for (const r of results.filter((x) => !x.passed)) {
    process.stdout.write(`  - ${r.name}\n      ${r.error}\n`);
  }
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  process.exit(total - passed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write(`FATAL: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(2);
});
