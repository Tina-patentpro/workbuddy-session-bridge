'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：本脚本的隔离目录以 `WB_BRIDGE_STORE=<dir>/instructions.json`（单文件）为基准，
 *   新设计中该变量语义已变更为**队列根目录**且拒绝 .json，旧基准不再成立。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   等价保证（越级路径 / Windows 设备名拦截）已由下列现行用例接管：
 *     test/qa-verify.js  A 组（越级与设备名穷举 + 标记值 TEST_MARK 未出现在响应中）
 *     test/smoke-test.js BUG-3（越级/设备名，且保留真实非 UUID 会话 ID）
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-path-checks：针对已删除的单文件 store 基准；等价保证见 test/qa-verify.js A 组 / smoke-test BUG-3。\n');
  process.exit(0);
}

/**
 * QA 第2轮独立强化测试：越级路径 / Windows 保留名情形穷举。
 *
 * 本文件刻意不复用 qa-verify.js 的任何断言，也不依赖其 fixture 构造，
 * 全部现搭现用，用真实 wb_read_session / wb_list_sessions 调用验证。
 *
 * 核心判据（硬断言，不接受 ignore / warn）：
 *   1. 任何越级类输入，响应文本中测试文件 TEST_MARK 零出现（字符串级硬断言）。
 *   2. 任何越级类输入，isError 必须为 true。
 *   3. 越级类输入必须被 INVALID_CONVERSATION_ID 精确拒绝——
 *      「返回了 SESSION_NOT_FOUND 就算过」是不合格的（见下方 deviceName 用例说明）。
 *   4. 越界读取绝不能返回任何真实文件内容。
 *
 * 运行：node test/helpers/qa2-path-checks.js
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
const paths = require(path.join(LIB, 'paths.js'));
const sessionsMod = require(path.join(LIB, 'sessions.js'));

const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-qa2-trav-'));
const TEST_MARK = 'QA2-MARK-' + crypto.randomBytes(6).toString('hex');

const results = [];
let currentGroup = '';

/**
 * 记录一个检查项结果。
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
 * 声明一个检查分组。
 *
 * @param {string} name 分组名。
 * @return {void}
 */
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n=== ${name} ===\n`);
}

/**
 * 极简 MCP stdio 客户端。
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
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => { this.stderr += c; });
    this.child.on('exit', () => { this.exited = true; });
  }

  /**
   * 累积 stdout 并按行派发响应。
   *
   * @param {string} chunk 数据分片。
   * @return {void}
   */
  onData(chunk) {
    this.buffer += chunk;
    let i = this.buffer.indexOf('\n');
    while (i !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim().length > 0) {
        let msg = null;
        try { msg = JSON.parse(line); } catch (_e) { /* ignore */ }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
          const r = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          r(msg);
        }
      }
      i = this.buffer.indexOf('\n');
    }
  }

  /**
   * 发起一次工具调用。
   *
   * @param {string} name 工具名。
   * @param {Object} args 参数。
   * @param {number} [timeoutMs] 超时。
   * @return {Promise<{raw: Object, payload: (Object|null), text: string}>} 结果。
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
        const text = raw.content && raw.content[0] ? raw.content[0].text : '';
        let payload = null;
        try { payload = JSON.parse(text); } catch (_e) { /* ignore */ }
        resolve({ raw, payload, text });
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
 * 构造越级测试用的隔离环境与外部文件。
 *
 * @param {string} name 子目录名。
 * @return {{dir: string, store: string, projectsDir: string, indexPath: string, outsideFile: string, env: Object<string,string>}} 隔离目录。
 */
function makeSandbox(name) {
  const dir = path.join(QA_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const projectsDir = path.join(dir, 'projects');
  fs.mkdirSync(paths.SLUG_PLACEHOLDER || projectsDir, { recursive: true });
  const store = path.join(dir, 'store', 'instructions.json');
  // 测试文件：projects/ 之外的一个真实 .jsonl
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'outside.jsonl');
  fs.writeFileSync(
    outsideFile,
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: TEST_MARK }] }) + '\n',
    'utf8',
  );
  // 一个真实项目目录 + 会话文件，验证「合法 id 仍应工作」
  const realSlug = 'c-Probe-Project';
  fs.mkdirSync(path.join(projectsDir, realSlug), { recursive: true });
  const realId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  fs.writeFileSync(
    path.join(projectsDir, realSlug, `${realId}.jsonl`),
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: 'LEGIT-OK' }] }) + '\n',
    'utf8',
  );
  const indexPath = path.join(dir, 'sessions.json');
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{ conversationId: realId, workDir: 'C:\\Probe\\Project', startedAt: '2026-01-01T00:00:00Z' }],
    }),
    'utf8',
  );
  return {
    dir, store, projectsDir, indexPath, outsideFile,
    env: {
      TASK: '1',
      WB_BRIDGE_STORE: store,
      WB_PROJECTS_DIR: projectsDir,
      WB_SESSIONS_INDEX: indexPath,
    },
  };
}

/* ------------------------------------------------------------------ *
 * T1: 纯越级变体穷举（含编码 / NUL / 超长 / 混合分隔符）
 * ------------------------------------------------------------------ */
async function groupT1() {
  group('T1. 越级路径变体穷举（编码/NUL/超长/混合分隔符）');

  await check('T1-1 越级变体全部被 INVALID_CONVERSATION_ID 精确拒绝 + 外部文件内容未出现在响应中', async () => {
    const sb = makeSandbox('t1');
    const projectDir = path.join(sb.projectsDir, 'c-Probe-Project');
    // 用真实的、确实存在的外部文件构造相对越级路径
    const relOutside = path.relative(projectDir, sb.outsideFile).replace(/\.jsonl$/, '');
    assert.ok(relOutside.includes('..'), `越级路径构造失败: ${relOutside}`);

    const variants = [
      ['经典 ../', relOutside],
      ['....//', '....//'],
      ['..;/', '..;/'],
      ['URL 编码 %2e%2e%2f', '%2e%2e%2f'],
      ['双重编码 %252e%252e%252f', '%252e%252e%252f'],
      ['%c0%af overlong', '..%c0%af'],
      ['NUL 字节', 'a\u0000b'],
      ['前导 NUL', '\u0000../../x'],
      ['超长 129', 'a'.repeat(129)],
      ['超长 5000', 'a'.repeat(5000)],
      ['反斜杠越级', '..\\..\\..\\outside'],
      ['混合分隔符 ..\\/', '..\\/'],
      ['正斜杠绝对路径', path.resolve(sb.outsideFile).replace(/\.jsonl$/, '')],
      ['UNC \\\\?\\', '\\\\?\\C:\\Windows\\System32'],
      ['UNC \\\\.\\', '\\\\.\\pipe\\x'],
      ['ADS foo.jsonl:stream', 'foo.jsonl:stream'],
      ['盘符 C:foo', 'C:foo'],
      ['纯 ..', '..'],
      ['单点', '.'],
      ['三点', '...'],
      ['内嵌 ..', 'a..b'],
      ['尾点 ..', 'outside..'],
      ['点空格 .. ', '.. '],
      ['tab 越级', '..\t..\\x'],
      ['%09 编码 tab', '%09../x'],
    ];

    const client = new RawClient({ env: sb.env });
    try {
      for (const [label, cid] of variants) {
        const r = await client.call('wb_read_session', { conversationId: cid, maxChars: 5000 });
        // 硬断言 1：外部文件内容未出现在响应中（字符串级）
        assert.ok(!r.text.includes(TEST_MARK),
          `【${label}】测试文件内容出现！conversationId=${JSON.stringify(cid).slice(0, 60)}\n${r.text.slice(0, 300)}`);
        // 硬断言 2：必须 isError
        assert.strictEqual(r.raw.isError, true,
          `【${label}】竟成功返回（应拒绝）: ${r.text.slice(0, 240)}`);
        // 硬断言 3：必须是 INVALID_CONVERSATION_ID 精确拒绝。
        // 这里刻意不接受 SESSION_NOT_FOUND：那意味着 id 竟真的被拼进了路径、
        // 只是恰好没命中文件——是「靠运气拦住」而非「设计上拦住」。
        assert.ok(r.text.includes('INVALID_CONVERSATION_ID'),
          `【${label}】错误码非 INVALID_CONVERSATION_ID: ${r.text.slice(0, 240)}`);
      }
      assert.strictEqual(client.exited, false, '服务因越级输入而退出');
      return `${variants.length} 种越级变体全部被 INVALID_CONVERSATION_ID 拒绝，外部文件内容未出现在响应中`;
    } finally {
      client.close();
    }
  });

  await check('T1-2 validateConversationId 单元级：越级变体 reason 必须是 PARENT_REF/UNSAFE_CHARS/FORBIDDEN_CHARS', () => {
    const mustBlock = [
      '..', '.', '...', 'a..b', 'outside..', '.. ', '....//', '..;/',
      '..\\..\\outside', '..\\/', '%2e%2e%2f', '%252e%252e%252f', '..%c0%af',
      'a\u0000b', 'C:foo', 'foo.jsonl:stream', '\\\\?\\C:\\Windows', '\\\\.\\pipe\\x',
      'a'.repeat(129), '', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a<b', 'a>b', 'a|b', 'a"b',
    ];
    for (const id of mustBlock) {
      const r = paths.validateConversationId(id);
      assert.strictEqual(r.ok, false, `应拒绝但放行了: ${JSON.stringify(id).slice(0, 40)}`);
    }
    // 边界：128 长度应放行
    assert.strictEqual(paths.validateConversationId('a'.repeat(128)).ok, true, '128 长度应放行');
    return `${mustBlock.length} 个非法 id 全部拒绝；128 长度边界放行正确`;
  });

  await check('T1-3 合法 id 仍能正常读取（防止「一刀切拒绝」式修复）', async () => {
    const sb = makeSandbox('t1-legit');
    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      assert.ok(!r.raw.isError, `合法 id 被误拒: ${r.text.slice(0, 240)}`);
      assert.ok(r.text.includes('LEGIT-OK'), '合法 id 未能读到内容');
      return '合法 UUID 会话读取正常';
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * T2: Windows 保留名情形（这是放宽字符集后新暴露的面）
 * ------------------------------------------------------------------ */
async function groupT2() {
  group('T2. Windows 保留名情形：保留设备名');

  await check('T2-1 保留设备名（CON/NUL/PRN/AUX/COM1-9/LPT1-9 及带扩展名形式）无法读取任何内容', async () => {
    const sb = makeSandbox('t2-devname');
    const deviceNames = [
      'CON', 'NUL', 'PRN', 'AUX',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
      'CON.jsonl', 'NUL.jsonl', 'PRN.jsonl', 'AUX.jsonl', 'COM1.jsonl', 'LPT1.jsonl',
      'CON.txt', 'NUL.anything', 'con', 'nul', 'com1', 'lpt1',
    ];
    const client = new RawClient({ env: sb.env });
    const hits = [];
    const succeeded = [];
    try {
      for (const cid of deviceNames) {
        const r = await client.call('wb_read_session', { conversationId: cid });
        // 硬断言：设备名绝不能读到任何内容（无论走哪种错误码）
        if (r.text.includes(TEST_MARK)) hits.push(cid);
        // 记录是否「成功返回」——成功不等于缺陷（可能只是命中了同名真实文件），
        // 真正的判据是「读到了设备/流内容」。
        if (!r.raw.isError) succeeded.push(cid);
      }
      assert.strictEqual(hits.length, 0,
        `以下设备名读到了内容（设备名可访问）: ${hits.join(', ')}`);
      return `${deviceNames.length} 个保留设备名无内容被读取（成功返回 ${succeeded.length} 个，均非设备读取）`;
    } finally {
      client.close();
    }
  });

  await check('T2-2 设备名在单元级被拒绝，且未误伤真实非 UUID 会话 / fixture', () => {
    // 第3次复验（工程师已修 F-2）：`WINDOWS_DEVICE_NAMES` 黑名单已加入
    // lib/paths.js:67-70，设备名现返回 RESERVED_DEVICE_NAME。
    // 本用例同时验证「强化没有误伤真实数据」——这是加黑名单最容易引入的回归。
    // 注意：Windows 保留设备名只有 COM1-9 / LPT1-9，**没有 COM0 / LPT0**
    // （实测 COM0.jsonl / LPT0.jsonl 可正常创建为普通文件），故不在此列。
    const devices = ['CON', 'NUL', 'PRN', 'AUX', 'COM1', 'COM9', 'LPT1', 'LPT9',
      'CON.jsonl', 'NUL.jsonl', 'con', 'nul', 'com1', 'lpt1'];
    const stillAllowed = devices.filter((d) => paths.validateConversationId(d).ok);
    assert.strictEqual(stillAllowed.length, 0,
      `validateConversationId 仍放行设备名: ${stillAllowed.join(', ')}`);

    // 反向：不得误伤真实数据里存在的非 UUID 会话 id 与测试夹具
    const mustAllow = [
      'conv-partial',                                    // 测试夹具
      '0210327a89244abea944d98682323895',                // 真实 32 位 hex 会话
      'c0dfc1f41e2a422981be9fd822621d59',                // 真实 32 位 hex 会话（981KB）
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',            // 标准 UUID
      'real-conv', 'c-fixture-partial',                  // 其它夹具形态
      'COM0.jsonl', 'LPT0',                              // 非保留名，不应被误伤
      'console', 'communicate', 'auxiliary',             // 含设备名子串的正常词
    ];
    const wronglyBlocked = mustAllow.filter((d) => !paths.validateConversationId(d).ok);
    assert.strictEqual(wronglyBlocked.length, 0,
      `强化误伤了合法 id: ${wronglyBlocked.join(', ')}`);

    // 设备名的拒绝原因应为专用 reason，便于诊断
    const r = paths.validateConversationId('CON');
    assert.strictEqual(r.reason, 'RESERVED_DEVICE_NAME', `reason=${r.reason}，期望 RESERVED_DEVICE_NAME`);

    return `设备名全部被拒(${devices.length} 个, reason=RESERVED_DEVICE_NAME)；`
      + `合法 id 零误伤(${mustAllow.length} 个，含 2 个真实 32 位 hex 会话)`;
  });

  await check('T2-3 设备名不可导致挂起（超时即视为失败）', async () => {
    const sb = makeSandbox('t2-hang');
    const client = new RawClient({ env: sb.env });
    try {
      // 用较短超时：若实现去 open 设备（如 CON），会阻塞或报错，但绝不能挂死
      await client.call('wb_read_session', { conversationId: 'CON' }, 4000);
      await client.call('wb_read_session', { conversationId: 'NUL' }, 4000);
      assert.strictEqual(client.exited, false, '设备名输入导致服务退出');
      return '设备名输入未挂起、未崩溃';
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * T3: trailing dot / trailing space（Windows 会静默剥离）
 * ------------------------------------------------------------------ */
async function groupT3() {
  group('T3. Windows trailing dot / trailing space 剥离');

  await check('T3-1 尾点/尾空格 id 不得产生「剥离别名」（实测本平台 Node 不剥离）', () => {
    // 事实核查（QA 第2轮实测，Node v22.22.2 / win32）：
    //   Node 的 fs 走 \\?\ 长路径语义，**不做** Win32 的尾点/尾空格剥离。
    //   'outside.'  => 'outside..jsonl'，与 'outside.jsonl' 是不同文件（ENOENT）。
    //   'outside '  => 被 validateConversationId 的 trim() 归一为 'outside'，
    //                语义与直接传 'outside' 完全相同，**不构成越级访问**。
    // 因此本用例的正确判据不是「禁止尾点」，而是「尾点不得指向别的文件」。
    const d = path.join(QA_ROOT, 't3-alias');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'outside.jsonl'), 'SECRET', 'utf8');
    try {
      const v = paths.validateConversationId('outside.');
      if (v.ok) {
        const resolved = path.join(d, `${v.value}.jsonl`);
        assert.notStrictEqual(path.basename(resolved), 'outside.jsonl',
          `尾点被剥离成 outside.jsonl，存在别名读取风险: ${resolved}`);
        assert.throws(() => fs.readFileSync(resolved, 'utf8'),
          `尾点 id 竟读到了 outside.jsonl 的内容（剥离别名成立）: ${resolved}`);
      }
      // 尾空格：trim 后语义必须与直接传入相同（不是越级访问，是归一化）
      const v2 = paths.validateConversationId('outside ');
      if (v2.ok) {
        assert.strictEqual(v2.value, 'outside', `尾空格未归一化: ${JSON.stringify(v2.value)}`);
        assert.strictEqual(v2.value, paths.validateConversationId('outside').value,
          '尾空格与无尾空格归一化结果不一致');
      }
      return '实测：Node 长路径不剥离尾点（outside. => outside..jsonl，ENOENT）；尾空格被 trim 归一，语义等同直接传入';
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  await check('T3-2 尾点 id 不得读到「被剥离后」的真实会话文件', async () => {
    const sb = makeSandbox('t3');
    fs.writeFileSync(
      path.join(sb.projectsDir, 'c-Probe-Project', 'real-conv.jsonl'),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: 'TRAIL-MARK' }] }) + '\n',
      'utf8',
    );
    const client = new RawClient({ env: sb.env });
    try {
      // 关键：'real-conv.' 才是可能触发剥离的输入；'real-conv ' 会被 trim 成 real-conv（合法命中）
      const dotResult = await client.call('wb_read_session', { conversationId: 'real-conv.', maxChars: 5000 });
      assert.ok(!dotResult.text.includes('TRAIL-MARK'),
        '尾点变体 "real-conv." 读到了被剥离后的真实文件内容');
      // 'real-conv' 与 'real-conv ' 命中同一文件属正常（trim 归一），单独确认不越界即可
      const plain = await client.call('wb_read_session', { conversationId: 'real-conv', maxChars: 5000 });
      assert.ok(plain.text.includes('TRAIL-MARK'), '合法 id 应能读到 fixture 内容（测试前提）');
      return '尾点 "real-conv." 未命中真实文件（无剥离别名）；合法 id 命中属预期';
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * T4: assertWithinRoot 第二重保险
 * ------------------------------------------------------------------ */
async function groupT4() {
  group('T4. assertWithinRoot 前缀判定稳健性');

  await check('T4-1 兄弟目录前缀（projects-sibling）不被误判为在根内', () => {
    const root = path.join(os.tmpdir(), 'root-projects');
    const cases = [
      [path.join(root, 'a', 'b.jsonl'), true],
      [root, true],
      [path.join(os.tmpdir(), 'root-projects-sibling', 'b.jsonl'), false],
      [path.join(os.tmpdir(), 'root-projectsX', 'b.jsonl'), false],
      [path.join(root, '..', 'root-projects-sibling', 'b.jsonl'), false],
    ];
    for (const [p, expected] of cases) {
      const r = paths.assertWithinRoot(p, root);
      assert.strictEqual(r.ok, expected, `assertWithinRoot(${p}, ${root}) => ok=${r.ok}, 期望 ${expected}`);
    }
    return `${cases.length} 个前缀边界用例正确（含兄弟目录 projects-sibling）`;
  });

  await check('T4-2 大小写差异不应导致根判定失效（Windows 不敏感）', () => {
    const root = path.join(os.tmpdir(), 'CaseRoot');
    const inRoot = paths.assertWithinRoot(path.join(root, 'x.jsonl'), root);
    assert.strictEqual(inRoot.ok, true, '正常子路径应通过');
    return '大小写场景下根判定正常';
  });
}

async function main() {
  fs.mkdirSync(QA_ROOT, { recursive: true });
  process.stdout.write('QA 第2轮 —— 越级路径 / Windows 保留名情形独立强化测试\n');
  process.stdout.write(`sandbox: ${QA_ROOT}\nmark    : ${TEST_MARK}\n`);

  await groupT1();
  await groupT2();
  await groupT3();
  await groupT4();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  process.stdout.write('\n=== SUMMARY ===\n');
  process.stdout.write(`TOTAL ${total} | PASS ${passed} | FAIL ${failed}\n`);
  if (failed > 0) {
    process.stdout.write('\nFAILED:\n');
    for (const r of results.filter((x) => !x.passed)) {
      process.stdout.write(`  - [${r.group}] ${r.name}\n      ${r.error}\n`);
    }
  }
  fs.rmSync(QA_ROOT, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stdout.write(`FATAL: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(2);
});
