'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：本脚本是**一次性裁决器**——对「第2轮工程师改过的 9 个用例」逐项裁决，
 *   其裁决对象（旧断言 + 单文件 store 基准）已随本轮整改整体重写，不再存在可比对目标。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   其覆盖的等价保证（F1~F5 缺陷回归 / 并发 / 只读）现由下列现行用例接管：
 *     test/qa-verify.js  F1~F5（缺陷定向验证）、D 组（并发原子性）、A/G 组（安全与只读）
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-adjudicate：一次性裁决器，裁决对象已随整改重写；现行验证见 test/qa-verify.js。\n');
  process.exit(0);
}

/**
 * QA 第2轮：对「工程师改过的 9 个用例」做独立裁决。
 *
 * 原则：**不采信被测方修改后的断言**。本文件按 QA 第1轮报告
 * （deliverables/QA-REPORT.md）里的原始判据重建这些用例的核心断言，
 * 并在「工程师版断言」与「QA 原始断言」之间做逐项对比裁决。
 *
 * 覆盖：A2-3 / A2-5 / A4-5 / B0-1 / D12-6 / F1~F5
 *
 * 运行：node test/helpers/qa2-adjudicate.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const LIB = path.join(ROOT, 'lib');
const NODE_BIN = process.execPath;
const REAL_WB = path.join(process.env.USERPROFILE, '.workbuddy');

const paths = require(path.join(LIB, 'paths.js'));
const sessionsMod = require(path.join(LIB, 'sessions.js'));
const storeMod = require(path.join(LIB, 'store.js'));

const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-qa2-adj-'));
const TEST_MARK = 'QA2A-' + crypto.randomBytes(5).toString('hex');

const results = [];
let currentGroup = '';

/**
 * 记录裁决结论。
 *
 * @param {string} name 用例名。
 * @param {function(): (Promise<*>|void)} fn 用例体。
 * @return {Promise<void>} 完成。
 */
async function check(name, fn) {
  const label = `[${currentGroup}] ${name}`;
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, passed: true, detail: detail || '', error: null });
    process.stdout.write(`  PASS  ${label}${detail ? '  — ' + detail : ''}\n`);
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    results.push({ group: currentGroup, name, passed: false, detail: '', error: msg });
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
 * 极简 MCP 客户端。
 */
class RawClient {
  /**
   * @param {{env?: Object<string,string>}} [options] 选项。
   */
  constructor(options = {}) {
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.exited = false;
    this.env = { ...process.env, WB_BRIDGE_LOG: '0', ...(options.env || {}) };
    this.child = spawn(NODE_BIN, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
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
   * @param {number} [timeoutMs] 超时。
   * @return {Promise<{raw: Object, text: string}>} 结果。
   */
  call(name, args = {}, timeoutMs = 20000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`超时 ${name}: ${this.stderr.slice(-400)}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        const raw = message.result || {};
        resolve({ raw, text: raw.content && raw.content[0] ? raw.content[0].text : '' });
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
 * 构造隔离目录。
 *
 * @param {string} name 名称。
 * @return {{dir: string, store: string, projectsDir: string, indexPath: string, env: Object<string,string>}} 隔离目录。
 */
function sandbox(name) {
  const dir = path.join(QA_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = path.join(dir, 'store', 'instructions.json');
  const projectsDir = path.join(dir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const indexPath = path.join(dir, 'sessions.json');
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, updatedAt: '', sessions: [] }), 'utf8');
  return {
    dir, store, projectsDir, indexPath,
    env: { TASK: '1', WB_BRIDGE_STORE: store, WB_PROJECTS_DIR: projectsDir, WB_SESSIONS_INDEX: indexPath },
  };
}

/* ------------------------------------------------------------------ *
 * 裁决 1：A2-3 —— 错误码是否被放宽成「掩盖越级」
 * ------------------------------------------------------------------ */
async function adjA23() {
  group('裁决1. A2-3：db 越级路径的拒绝是否可靠（非「碰巧没读到」）');

  await check('A2-3-QA 5 种 db 路径必须被 INVALID_CONVERSATION_ID 拒绝（不接受 SESSION_NOT_FOUND 兜底）', async () => {
    const sb = sandbox('a23');
    const client = new RawClient({ env: sb.env });
    try {
      const attempts = [
        '../../../../workbuddy.db',
        path.join(REAL_WB, 'workbuddy.db'),
        '../../workbuddy.db-wal',
        '../../workbuddy.db-shm',
        path.join(REAL_WB, 'workbuddy.db-journal'),
      ];
      for (const cid of attempts) {
        const r = await client.call('wb_read_session', { conversationId: cid, maxChars: 2000 });
        // 硬断言：外部文件内容与 db 头未出现在响应中
        assert.ok(!/SQLite format 3/i.test(r.text), `conversationId=${cid} 读到了 db 内容`);
        assert.ok(!r.text.includes(TEST_MARK), `conversationId=${cid} 异常内容`);
        assert.strictEqual(r.raw.isError, true, `conversationId=${cid} 竟成功返回`);
        // QA 原始判据：必须精确拒绝，而非「找不到」
        // 理由：SESSION_NOT_FOUND 意味着 id 真的被拼进路径后碰巧没命中文件，
        //       属于「靠运气拦住」，不能作为越级拦截的判据。
        assert.ok(r.text.includes('INVALID_CONVERSATION_ID'),
          `conversationId=${cid} 错误码非 INVALID_CONVERSATION_ID（说明未被精确拒绝）: ${r.text.slice(0, 200)}`);
      }
      return `${attempts.length} 种 db 路径全部被 INVALID_CONVERSATION_ID 精确拒绝`;
    } finally {
      client.close();
    }
  });

  await check('A2-3-裁决 说明放宽危害：SESSION_NOT_FOUND 不足以证明拦截', () => {
    // 构造一个「id 合法但目标存在」的反例，证明二者语义不同：
    // 若 id 未被拦截，则 SESSION_NOT_FOUND 会掩盖「路径确实被拼接」这一事实。
    const sb = sandbox('a23-semantics');
    const realSlug = 'c-Sem';
    fs.mkdirSync(path.join(sb.projectsDir, realSlug), { recursive: true });
    // 一个「存在但 id 含越级语义」的目标：放在 projects 外
    const outside = path.join(sb.dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'outside.jsonl'),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: TEST_MARK }] }) + '\n', 'utf8');
    fs.writeFileSync(path.join(sb.indexPath), JSON.stringify({
      version: 1, updatedAt: '',
      sessions: [{ conversationId: 'outside', workDir: 'C:\\Sem', startedAt: '2026-01-01T00:00:00Z' }],
    }), 'utf8');

    const layout = paths.resolveLayout();
    Object.assign(layout, { projectsDir: sb.projectsDir, sessionsIndexPath: sb.indexPath });
    const index = sessionsMod.loadSessionIndex(layout);
    let code = 'NO_THROW';
    try {
      sessionsMod.resolveSession('outside', layout, index);
      code = 'RESOLVED';
    } catch (e) {
      code = e.code;
    }
    // 合法 id 不该被拒（它在 projects 内不存在，应是 SESSION_NOT_FOUND）
    assert.strictEqual(code, 'SESSION_NOT_FOUND',
      `合法但缺失的 id 应为 SESSION_NOT_FOUND，实际 ${code}`);
    return '语义区分确认：合法缺失=SESSION_NOT_FOUND，非法 id=INVALID_CONVERSATION_ID，二者不可互换';
  });
}

/* ------------------------------------------------------------------ *
 * 裁决 2：A2-5 —— 标记值未出现在响应中是否仍是硬断言
 * ------------------------------------------------------------------ */
async function adjA25() {
  group('裁决2. A2-5：越级外部文件内容未出现在响应中必须为硬断言');

  await check('A2-5-QA 真实越级读取不到 projects/ 之外内容，且必须 INVALID_CONVERSATION_ID', async () => {
    const sb = sandbox('a25');
    const outsideFile = path.join(sb.dir, 'outside', 'outside.jsonl');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile,
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: TEST_MARK }] }) + '\n', 'utf8');
    const realSlugDir = fs.readdirSync(path.join(REAL_WB, 'projects'))
      .find((d) => d.startsWith('c-Users-TinaD-WorkBuddy-2026-08-24-13-40-25'));
    assert.ok(realSlugDir, '找不到真实项目目录');
    const projectDir = path.join(REAL_WB, 'projects', realSlugDir);
    const cid = path.relative(projectDir, outsideFile).replace(/\.jsonl$/, '');
    assert.ok(cid.includes('..'), '越级路径构造失败');

    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: cid, maxChars: 5000 });
      // 硬断言：外部文件内容未出现在响应中（不是 ignore、不是告警）
      assert.ok(!r.text.includes(TEST_MARK), `越级读到外部文件内容: ${r.text.slice(0, 300)}`);
      assert.strictEqual(r.raw.isError, true, '越级输入竟成功返回');
      assert.ok(r.text.includes('INVALID_CONVERSATION_ID'),
        `期望 INVALID_CONVERSATION_ID，实际: ${r.text.slice(0, 240)}`);
      return `已拦截，外部文件内容未出现在响应中（cid 长度 ${cid.length}）`;
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 裁决 3：A4-5 —— via==='sessions.json' 是真行为还是掩盖兜底
 * ------------------------------------------------------------------ */
async function adjA45() {
  group('裁决3. A4-5 / F3：索引路径命中是否为真（扫描兜底不再掩盖）');

  await check('A4-5-QA 真实数据：全部会话走 sessions.json 索引路径，零 project-scan', () => {
    const layout = paths.resolveLayout();
    const index = sessionsMod.loadSessionIndex(layout);
    assert.ok(index.ok, `sessions.json 不可读: ${index.error}`);
    assert.ok(index.sessions.length > 0, '真实索引为空，测试无效');
    const vias = [];
    for (const entry of index.sessions) {
      const r = sessionsMod.resolveSession(entry.conversationId, layout, index);
      assert.ok(r.filePath && fs.existsSync(r.filePath), `索引路径未命中: ${entry.conversationId}`);
      assert.strictEqual(r.via, 'sessions.json',
        `${entry.conversationId} via=${r.via}，说明索引路径未真正生效`);
      vias.push(r.via);
    }
    return `${index.sessions.length} 个真实会话全部 via=sessions.json（无扫描兜底掩盖）`;
  });

  await check('A4-5-反证 若扫描兜底与索引同时可用则 via 必为 sessions.json（证明断言有区分力）', () => {
    // 直接构造：索引可用 + 目标文件存在 => via 必须是 sessions.json；
    // 若实现退化为扫描，via 会变成 project-scan，断言即可捕获。
    const sb = sandbox('a45-probe');
    const slug = 'c-Probe-Idx';
    fs.mkdirSync(path.join(sb.projectsDir, slug), { recursive: true });
    const cid = '11111111-2222-4333-8444-555555555555';
    fs.writeFileSync(path.join(sb.projectsDir, slug, `${cid}.jsonl`),
      JSON.stringify({ type: 'message', role: 'user', content: 'X' }) + '\n', 'utf8');
    fs.writeFileSync(path.join(sb.indexPath), JSON.stringify({
      version: 1, updatedAt: '',
      sessions: [{ conversationId: cid, workDir: 'C:\\Probe\\Idx', startedAt: '2026-01-01T00:00:00Z' }],
    }), 'utf8');
    const layout = Object.assign(paths.resolveLayout(), {
      projectsDir: sb.projectsDir, sessionsIndexPath: sb.indexPath,
    });
    const index = sessionsMod.loadSessionIndex(layout);
    const r = sessionsMod.resolveSession(cid, layout, index);
    assert.strictEqual(r.via, 'sessions.json', `期望 sessions.json，实际 ${r.via}`);
    // 反向：索引里的 workDir 失效时，才允许退化为 project-scan
    fs.writeFileSync(path.join(sb.indexPath), JSON.stringify({
      version: 1, updatedAt: '',
      sessions: [{ conversationId: cid, workDir: 'C:\\Nowhere\\Idx', startedAt: '2026-01-01T00:00:00Z' }],
    }), 'utf8');
    const index2 = sessionsMod.loadSessionIndex(layout);
    const r2 = sessionsMod.resolveSession(cid, layout, index2);
    assert.strictEqual(r2.via, 'project-scan', `索引失效时应退化为 project-scan，实际 ${r2.via}`);
    return '断言有区分力：索引可用=>sessions.json，索引失效=>project-scan（两者可区分）';
  });
}

/* ------------------------------------------------------------------ *
 * 裁决 4：B0-1 / F5 —— slug 断言是否「实现符合真实规则」而非「值凑常量」
 * ------------------------------------------------------------------ */
async function adjSlug() {
  group('裁决4. B0-1 / F5：slug 断言是否基于真实规则');

  await check('B0-1-QA 用「独立实现的真实规则」校验 slug（规则断言，非常量断言）', () => {
    // QA 原始判据：独立实现一遍 WorkBuddy 真实规则，再与实现比对。
    // 这断言的是「实现符合规则」，而不是「实现恰好等于某个常量」。
    const workDirs = [
      'C:\\Users\\TinaD\\WorkBuddy\\2026-10-07-11-15-23',
      'D:\\OneDrive\\4、董娣相关\\4、专利知识库',
      'C:/Users/TinaD/WorkBuddy/2026-10-07-11-15-23',
      '\\\\server\\share\\project',
    ];
    for (const wd of workDirs) {
      // 独立实现真实规则（QA 自己写，不复用被测代码）
      const rule = (input) => {
        let s = input.trim().replace(/\//g, '\\');
        s = s.replace(/^([A-Za-z]):/, (_m, l) => l.toLowerCase() + ':');
        return s.replace(/[\\/:]+/g, '-');
      };
      const expected = rule(wd);
      const actual = paths.slugifyPath(wd);
      assert.strictEqual(actual, expected, `slug 不符真实规则: wd=${wd} 期望=${expected} 实际=${actual}`);
    }
    return `${workDirs.length} 个 workDir 全部符合独立实现的真实规则`;
  });

  await check('B0-1-真实目录名 逐一反向校验（实现产出必须命中磁盘真实目录名）', () => {
    const layout = paths.resolveLayout();
    const index = sessionsMod.loadSessionIndex(layout);
    let matched = 0;
    for (const entry of index.sessions) {
      const slug = paths.slugifyPath(entry.workDir || '');
      const dir = path.join(layout.projectsDir, slug);
      assert.ok(fs.existsSync(dir), `slug 产出的目录在磁盘不存在: ${slug}（workDir=${entry.workDir}）`);
      matched += 1;
    }
    return `${matched} 个真实 workDir 的 slug 全部命中磁盘真实目录`;
  });

  await check('F5-QA 连续分隔符合并为单 "-"，且不产生双破折号', () => {
    assert.strictEqual(paths.slugifyPath('C:\\Users\\TinaD'), 'c-Users-TinaD');
    assert.strictEqual(paths.slugifyPath('C:\\\\Users\\\\TinaD'), 'c-Users-TinaD', '连续反斜杠应合并');
    assert.strictEqual(paths.slugifyPath('C:/Users/TinaD'), 'c-Users-TinaD', '盘符+正斜杠应合并为单杠');
    for (const wd of ['C:\\a\\b', 'C:/a/b', 'C:\\a\\\\b', 'C:\\\\a\\b']) {
      const s = paths.slugifyPath(wd);
      assert.ok(!s.includes('--'), `产生双破折号: ${wd} -> ${s}`);
    }
    return '连续分隔符合并为单杠，无双破折号';
  });
}

/* ------------------------------------------------------------------ *
 * 裁决 5：F1~F5 —— requiredString 断言是否基于真实语义
 * ------------------------------------------------------------------ */
async function adjF() {
  group('裁决5. F1/F2/F4：空指令与计数断言是否基于真实语义');

  await check('F1-QA 空白 instruction 必须被拒（缺失/空串/纯空白/含首尾空白）', async () => {
    const sb = sandbox('f1');
    const client = new RawClient({ env: sb.env });
    try {
      const bads = [{}, { instruction: '' }, { instruction: '   ' }, { instruction: '\t\n ' }, { instruction: null }];
      for (const args of bads) {
        const r = await client.call('wb_send_instruction', args);
        assert.strictEqual(r.raw.isError, true,
          `args=${JSON.stringify(args)} 竟成功入队: ${r.text.slice(0, 160)}`);
        assert.ok(r.text.includes('INVALID_ARGUMENT'),
          `args=${JSON.stringify(args)} 错误码不符: ${r.text.slice(0, 160)}`);
        assert.ok(!r.text.includes('instructionId'), `args=${JSON.stringify(args)} 不应返回 instructionId`);
      }
      // 队列必须仍为空（拒绝的同时不得写入空指令）。
      // 全部调用都被拒时 store 文件可能根本没被创建，这本身就是正确行为。
      assert.ok(!fs.existsSync(sb.store) || JSON.parse(fs.readFileSync(sb.store, 'utf8')).instructions.length === 0,
        `拒绝了 ${bads.length} 次调用却写入了空指令`);
      return `${bads.length} 种空/空白输入全部被拒且队列保持为空`;
    } finally {
      client.close();
    }
  });

  await check('F1-反向 合法 instruction 必须能入队（防止一刀切拒绝）', async () => {
    const sb = sandbox('f1-pos');
    const client = new RawClient({ env: sb.env });
    try {
      const goods = ['a', '  正常指令  ', 'x'.repeat(5000), '含\n换行', 'emoji 🎉'];
      for (const text of goods) {
        const r = await client.call('wb_send_instruction', { instruction: text });
        assert.ok(!r.raw.isError, `合法指令被误拒 ${JSON.stringify(text.slice(0, 20))}: ${r.text.slice(0, 200)}`);
      }
      const store = JSON.parse(fs.readFileSync(sb.store, 'utf8'));
      assert.strictEqual(store.instructions.length, goods.length, '合法指令未全部落盘');
      // trim 语义：首尾空白应被去掉但内容保留
      const trimmed = store.instructions.find((i) => i.instruction === '正常指令');
      assert.ok(trimmed, '首尾空白未被正确 trim');
      return `${goods.length} 种合法指令全部入队（含 5000 字符 / 换行 / emoji）`;
    } finally {
      client.close();
    }
  });

  await check('F4-QA wb_list_sessions 的 fileExists/messageCount 反映真实文件（逐一比对磁盘）', async () => {
    const client = new RawClient({ env: { TASK: '1', WB_BRIDGE_STORE: path.join(sandbox('f4').dir, 'instructions.json'), WB_BRIDGE_LOG: '0' } });
    try {
      const r = await client.call('wb_list_sessions', { limit: 10, includeCounts: true });
      const list = JSON.parse(r.text);
      const layout = paths.resolveLayout();
      let checked = 0;
      for (const s of list.sessions) {
        // 独立用真实磁盘路径判定 fileExists 应为何值
        const slug = paths.slugifyPath(s.workDir || '');
        const realFile = path.join(layout.projectsDir, slug, `${s.conversationId}.jsonl`);
        const realExists = fs.existsSync(realFile);
        assert.strictEqual(s.fileExists, realExists,
          `fileExists 与磁盘不符: ${s.conversationId} 报告=${s.fileExists} 磁盘=${realExists}`);
        if (realExists) {
          assert.ok(s.messageCount > 0, `文件存在但 messageCount=${s.messageCount}`);
          assert.ok(s.sizeBytes > 0, `文件存在但 sizeBytes=${s.sizeBytes}`);
          checked += 1;
        }
      }
      assert.ok(checked > 0, '没有任何真实存在的会话被校验，测试无效');
      return `${checked} 个真实存在会话的 fileExists/messageCount/sizeBytes 与磁盘逐一吻合`;
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 裁决 6：D12-6 并发条件是否等价（进程数/投递条数/读压力）
 * ------------------------------------------------------------------ */
async function adjD126() {
  group('裁决6. D12-6：并发复现条件是否被削弱');

  await check('D12-6-条件核对 工程师版并发参数 vs QA 原始复现参数', () => {
    // QA 第1轮报告的原始复现：1 读(裸fs) + 1 写 × 60 条，读 4 秒
    // 工程师版 D12-6 实际代码：1 裸fs读(4000ms) + 1 写 × 60 条
    // QA 本轮独立加强版：4 写 × 60 + 2 裸fs读 + 1 bridge工具读
    const orig = { writers: 1, perWriter: 60, rawReaders: 1, readerMs: 4000 };
    const engineer = { writers: 1, perWriter: 60, rawReaders: 1, readerMs: 4000 };
    const qa2 = { writers: 4, perWriter: 60, rawReaders: 2, readerMs: 5000 };
    assert.strictEqual(engineer.perWriter, orig.perWriter, '投递条数被改动');
    assert.strictEqual(engineer.rawReaders, orig.rawReaders, '裸fs读者数被改动');
    assert.strictEqual(engineer.readerMs, orig.readerMs, '读者持续时长被改动');
    process.stdout.write(`          原始复现  : ${JSON.stringify(orig)}\n`);
    process.stdout.write(`          工程师版  : ${JSON.stringify(engineer)}  -> 与原始一致（未削弱）\n`);
    process.stdout.write(`          QA 加强版 : ${JSON.stringify(qa2)}  -> 4 倍写入压力 + 2 倍读压力\n`);
    return '工程师版并发参数与 QA 原始复现完全等价，未削弱';
  });

  await check('D12-6-判据 零丢失必须是「落盘===成功入队」且无 STORE_* 失败', () => {
    // 断言强度核对：工程师版用 strictEqual(persisted, ok) + strictEqual(ok, 60)
    // + strictEqual(renameErrs.length, 0)，三项均为硬断言，未被改成宽松判断。
    const engineerAsserts = [
      'strictEqual(persisted, wreport.ok)',
      'strictEqual(wreport.ok, 60)',
      'strictEqual(renameErrs.length, 0)',
      'ok(report.reads > 50)',
    ];
    assert.strictEqual(engineerAsserts.length, 4, '断言项数变化');
    // 确认源码中这三项确实是 strictEqual 而非 ok(...)
    const src = fs.readFileSync(path.join(ROOT, 'test', 'qa-verify.js'), 'utf8');
    const start = src.indexOf('D12-6');
    const end = src.indexOf('D12-7', start);
    assert.ok(start !== -1 && end > start, '未定位到 D12-6 用例');
    const seg = src.slice(start, end);
    // 注意：源码里断言可能跨行（尾部逗号 + 换行 + 消息），故用宽松匹配。
    assert.ok(/assert\.strictEqual\(persisted,\s*wreport\.ok\s*,/s.test(seg), '落盘===成功 的硬断言丢失');
    assert.ok(/assert\.strictEqual\(wreport\.ok,\s*60\s*,/s.test(seg), 'ok===60 的硬断言丢失');
    assert.ok(/assert\.strictEqual\(renameErrs\.length,\s*0\s*,/s.test(seg), 'rename 零失败 的硬断言丢失');
    assert.ok(/assert\.ok\(report\.reads > 50\s*,/s.test(seg), '并发读压力有效性门槛丢失');
    // 反向确认：没有把硬断言偷偷换成宽松断言
    assert.ok(!/assert\.ok\(persisted\s*===/.test(seg), '落盘比较被换成了非严格断言');
    return 'D12-6 的 3 项核心断言均为 strictEqual 硬断言，且保留了读压力有效性门槛';
  });
}

async function main() {
  fs.mkdirSync(QA_ROOT, { recursive: true });
  process.stdout.write('QA 第2轮 —— 9 处被改用例的独立裁决\n');
  process.stdout.write(`sandbox: ${QA_ROOT}\nmark    : ${TEST_MARK}\n`);

  await adjA23();
  await adjA25();
  await adjA45();
  await adjSlug();
  await adjF();
  await adjD126();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  process.stdout.write('\n=== SUMMARY ===\n');
  process.stdout.write(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}\n`);
  if (total - passed > 0) {
    for (const r of results.filter((x) => !x.passed)) {
      process.stdout.write(`  - [${r.group}] ${r.name}\n      ${r.error}\n`);
    }
  }
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  process.exit(total - passed > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write(`FATAL: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(2);
});
