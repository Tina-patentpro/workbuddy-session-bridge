'use strict';

/**
 * QA 独立验证套件（workbuddy-session-bridge）
 *
 * 与 test/smoke-test.js 完全独立：不复用其断言，改为自行 spawn server 子进程、
 * 手写原始 JSON-RPC 帧、构造畸形数据、比对真实 WorkBuddy 磁盘布局。
 *
 * 隔离原则：
 *   - 所有写操作经 WB_BRIDGE_STORE（**目录**语义）指向 %TEMP% 下独立目录。
 *   - 真实 WorkBuddy 目录（默认 `~/.workbuddy`，跨平台自适应；可用 WB_REAL_WB 覆盖）全程
 *     **只读**，任何用例都不得写它。
 *   - 默认写路径用例（A1-1）通过 WB_WORKBUDDY_DIR 把 WorkBuddy 根重定向到一个本次
 *     mkdtemp 创建的隔离目录，因此**完全不触碰真实用户目录**（F01 整改）。
 *   - A0 哨兵保护：在任何写入用例之前，先在临时目录放置哨兵文件并记录哈希；
 *     全套用例结束后（G3）断言哨兵未被删除/改写——证明清理逻辑绝不触碰既有文件。
 *
 * 可移植性（审计 §7「可移植功能测试应与真实部署验收分开」）：
 *   - 少数用例的**前置条件**依赖本机真实部署（读真实 projects/ / sessions.json / 真实会话）。
 *   - 当真实部署不存在（WB_REAL_WB 指向空目录，或默认路径不存在；如 Linux 审计机）时，
 *     这些用例记 **SKIP**（打印原因），既不计 PASS 也不计 FAIL，**绝不伪装通过、绝不改弱断言**。
 *   - 当真实部署存在（本机默认）时，这些用例**行为不变**，真实断言真实执行（判别力保持）。
 *   - 覆盖真实部署位置：`WB_REAL_WB=<dir> node test/qa-verify.js`。
 *
 * 运行：node test/qa-verify.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const LIB = path.join(ROOT, 'lib');
const NODE_BIN = process.execPath;

const paths = require(path.join(LIB, 'paths.js'));
const jsonl = require(path.join(LIB, 'jsonl.js'));
const sessionsMod = require(path.join(LIB, 'sessions.js'));
const storeMod = require(path.join(LIB, 'store.js'));
const { PROTOCOL_VERSION, JSONRPC_ERRORS } = require(path.join(LIB, 'protocol.js'));

// 隔离根目录：**每次运行唯一**（mkdtempSync）。
// 固定路径（如 'wb-bridge-qa-verify'）会让两个并发实例在 sandbox() 里互相 rmSync/mkdir
// 对方的目录 → 并发互踩（表现为随机 FAIL）。唯一路径彻底消除该问题。
const QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-qa-verify-'));
const TEST_MARK = 'QA-MARK-' + crypto.randomBytes(6).toString('hex');

const results = [];
let currentGroup = '';

/**
 * 环境限制（既不计入 PASS，也不计入 FAIL）。
 *
 * 用于「仅与本机环境有关」的前置条件，例如 README 片段记录的 Node 安装路径在本机不存在——
 * 这是环境差异，不是产品缺陷；但也**绝不伪装成 PASS**（与软件缺陷的 FAIL 严格区分）。
 * 对应审计意见：「可移植功能测试应与真实部署验收分开」。
 */
class EnvLimited extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvLimited';
    this.__env = true;
  }
}

/**
 * 抛出环境限制；由 check() 记录为 ENV。
 *
 * @param {string} message 说明。
 * @return {void}
 */
function raiseEnv(message) {
  throw new EnvLimited(message);
}

/**
 * 跳过（SKIP）：用例前置条件依赖本机真实 WorkBuddy 部署，而当前环境不具备。
 *
 * 既不计入 PASS 也不计入 FAIL —— **绝不伪装成 PASS，也绝不因环境差异误报为产品缺陷的 FAIL**。
 * 与软件缺陷的 FAIL、与机器差异的 ENV 三者严格区分。
 * 对应审计 §7：「可移植功能测试应与真实部署验收分开」。
 */
class SkipCase extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipCase';
    this.__skip = true;
  }
}

/**
 * 抛出跳过；由 check() 记录为 SKIP。
 *
 * @param {string} message 跳过原因（须写明前置条件与恢复方式）。
 * @return {void}
 */
function skipCase(message) {
  throw new SkipCase(message);
}

/* ------------------------------------------------------------------ *
 * 迷你断言框架
 * ------------------------------------------------------------------ */

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
    results.push({ group: currentGroup, name, passed: true, env: false, skipped: false, detail: detail || '', error: null });
    process.stdout.write(`  PASS  ${label}${detail ? '  — ' + detail : ''}\n`);
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    if (error && error.__env) {
      results.push({ group: currentGroup, name, passed: false, env: true, skipped: false, detail: '', error: msg });
      process.stdout.write(`  ENV   ${label}  — ${msg}\n`);
      return;
    }
    if (error && error.__skip) {
      results.push({ group: currentGroup, name, passed: false, env: false, skipped: true, detail: '', error: msg });
      process.stdout.write(`  SKIP  ${label}  — ${msg}\n`);
      return;
    }
    results.push({ group: currentGroup, name, passed: false, env: false, skipped: false, detail: '', error: msg });
    process.stdout.write(`  FAIL  ${label}\n          ${String(msg).split('\n').join('\n          ')}\n`);
  }
}

/**
 * 声明一个检查分组。
 *
 * @param {string} group 分组名。
 * @return {void}
 */
function group(group) {
  currentGroup = group;
  process.stdout.write(`\n=== ${group} ===\n`);
}

/* ------------------------------------------------------------------ *
 * MCP stdio 客户端（手写原始帧）
 * ------------------------------------------------------------------ */

/**
 * 极简 MCP 客户端：记录原始 stdout 字节，用于协议流污染检测。
 */
class RawClient {
  /**
   * @param {{env?: Object<string, string>, replaceEnv?: boolean, nodeBin?: string, preload?: string}} [options] 选项。
   *   replaceEnv=true 时以 env 完整替换继承来的环境（用于验证「无 TASK/无 STORE」的默认布局）。
   */
  constructor(options = {}) {
    this.buffer = '';
    this.rawChunks = [];
    this.lines = [];
    this.unparsableLines = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.exited = false;
    this.exitInfo = null;
    const base = options.replaceEnv ? {} : { ...process.env };
    this.env = { ...base, WB_BRIDGE_LOG: '0', ...(options.env || {}) };
    const nodeArgs = [];
    if (options.preload) {
      nodeArgs.push('-r', options.preload);
    }
    nodeArgs.push(SERVER);
    this.child = spawn(options.nodeBin || NODE_BIN, nodeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
    });
    this.child.on('error', (error) => {
      this.stderr += `\n[spawn error] ${error.message}`;
    });
  }

  /**
   * 累积 stdout 并按行切分。
   *
   * @param {string} chunk 数据分片。
   * @return {void}
   */
  onData(chunk) {
    this.rawChunks.push(chunk);
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        this.lines.push(line);
        let message = null;
        try {
          message = JSON.parse(line);
        } catch (_error) {
          this.unparsableLines.push(line);
        }
        if (message && message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
          const resolver = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolver(message);
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  /**
   * 发送一条原始帧（调用方自行保证是合法 JSON 文本）。
   *
   * @param {string} raw 原始文本（不含换行）。
   * @return {void}
   */
  writeRaw(raw) {
    this.child.stdin.write(raw + '\n');
  }

  /**
   * 发送一个 JSON-RPC 请求。
   *
   * @param {string} method 方法名。
   * @param {Object} [params] 参数。
   * @param {number} [timeoutMs] 超时。
   * @return {Promise<Object>} 响应。
   */
  request(method, params, timeoutMs = 20000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时 ${method} (id=${id})\nstderr: ${this.stderr.slice(-600)}`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * 调用工具并解析文本负载。
   *
   * @param {string} name 工具名。
   * @param {Object} [args] 参数。
   * @param {number} [timeoutMs] 超时。
   * @return {Promise<{raw: Object, payload: (Object|null), response: Object}>} 结果。
   */
  async call(name, args = {}, timeoutMs = 20000) {
    const response = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    assert.ok(response.result, `tools/call ${name} 无 result: ${JSON.stringify(response).slice(0, 400)}`);
    const text = response.result.content[0].text;
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = null;
    }
    return { raw: response.result, payload, response };
  }

  /**
   * 等待一小段时间（用于并发/竞态场景）。
   *
   * @param {number} ms 毫秒。
   * @return {Promise<void>} 完成。
   */
  static wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 关闭子进程。
   *
   * @return {void}
   */
  close() {
    try {
      this.child.stdin.end();
    } catch (_error) {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch (_error) {
      /* ignore */
    }
  }
}

/**
 * 创建隔离的 store 环境变量。
 *
 * @param {string} name 子目录名。
 * @return {{dir: string, store: string, env: Object<string,string>}} 环境描述。
 */
function sandbox(name) {
  const dir = path.join(QA_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // maildir 语义：WB_BRIDGE_STORE 指向**队列根目录**（不再是单个 .json 文件）。
  const store = path.join(dir, 'store');
  return { dir, store, env: { TASK: '1', WB_BRIDGE_STORE: store, WB_BRIDGE_LOG: '0' } };
}

/**
 * 读取 maildir 队列根目录下的全部记录（跨 pending/picked/done/failed）。
 *
 * @param {string} storeRoot 队列根目录。
 * @return {{records: Object[], byStatus: Object<string, Object[]>, leftovers: string[]}} 记录汇总。
 */
function readMaildir(storeRoot) {
  const byStatus = { pending: [], picked: [], done: [], failed: [] };
  const records = [];
  for (const status of Object.keys(byStatus)) {
    const dir = path.join(storeRoot, status);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_e) { names = []; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      rec.status = status;
      byStatus[status].push(rec);
      records.push(rec);
    }
  }
  let leftovers = [];
  try {
    const tmpFiles = fs.readdirSync(path.join(storeRoot, 'tmp'));
    leftovers = tmpFiles.filter((f) => f.endsWith('.tmp'));
  } catch (_e) { leftovers = []; }
  return { records, byStatus, leftovers };
}

/* ------------------------------------------------------------------ *
 * 真实 WorkBuddy 布局（只读）
 * ------------------------------------------------------------------ */

const REAL_WB = process.env.WB_REAL_WB || path.join(os.homedir(), '.workbuddy');
/** 真实部署的关键路径（只读）：项目会话目录 + 会话索引。 */
const REAL_WB_PROJECTS = path.join(REAL_WB, 'projects');
const REAL_WB_INDEX = path.join(REAL_WB, 'app', 'sessions.json');

/**
 * 只读枚举真实 projects/ 下的会话（供需要「任意真实会话」的用例动态选材）。
 *
 * 【M3 修复 · 测试跨平台】旧用例把 WinPC 专属的项目目录名（`c-Users-TinaD-WorkBuddy-2026-08-24-…`）
 * 与真实会话 ID 硬编码在断言里，换机（Mac）后必然取不到，只能整例跳过。
 * 改为在运行时**发现**真实素材，使同一条断言在任何平台上都真正执行。
 *
 * @return {Array<{slug: string, projectDir: string, conversationId: string, filePath: string}>} 会话清单。
 */
function discoverRealSessions() {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(REAL_WB_PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_error) {
    return found;
  }
  for (const dirEntry of dirs) {
    const projectDir = path.join(REAL_WB_PROJECTS, dirEntry.name);
    let files = [];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith('.jsonl'));
    } catch (_error) {
      continue;
    }
    for (const file of files) {
      found.push({
        slug: dirEntry.name,
        projectDir,
        conversationId: file.slice(0, -'.jsonl'.length),
        filePath: path.join(projectDir, file),
      });
    }
  }
  return found;
}

/** 真实会话清单（惰性一次性扫描，只读）。 */
const REAL_SESSIONS = discoverRealSessions();

/**
 * 真实部署 `task-bridge` 队列的只读快照（存在性 + 递归条目集合 + 各文件大小）。
 *
 * 【M3 修复】旧断言写作「该目录必须**不存在**」，但连接器的**默认**队列根就是
 * `<WORKBUDDY_DIR>/task-bridge` —— 真实部署本来就会创建它（Mac 上实测已存在）。
 * 「目录不存在」并不是本组要守的不变量；真正要守的是「本套件**零触碰**真实目录」。
 * 故改为套件运行前后快照比对：存在性、条目集合、各条目大小任一变化即判失败。
 *
 * 只读：仅 `stat` / `readdir`，不创建、不写入、不删除。
 *
 * @param {string} dir 目录。
 * @return {{exists: boolean, entries: string[]}} 快照。
 */
function snapshotDir(dir) {
  const snapshot = { exists: false, entries: [] };
  let stats = null;
  try {
    stats = fs.statSync(dir);
  } catch (_error) {
    return snapshot;
  }
  if (!stats.isDirectory()) return snapshot;
  snapshot.exists = true;
  const walk = (base, rel) => {
    let items = [];
    try {
      items = fs.readdirSync(base, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const item of items) {
      const abs = path.join(base, item.name);
      const entryRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(abs, entryRel);
        continue;
      }
      let fileStats = null;
      try {
        fileStats = fs.statSync(abs);
      } catch (_error) {
        fileStats = null;
      }
      snapshot.entries.push(`${entryRel}|${fileStats ? fileStats.size : '?'}`);
    }
  };
  walk(dir, '');
  snapshot.entries.sort();
  return snapshot;
}

/** 真实队列根（连接器默认 store）。 */
const REAL_TASK_BRIDGE = path.join(REAL_WB, 'task-bridge');
/** 套件启动时的真实队列快照（用于 G1/G2 的前后比对）。 */
const REAL_TASK_BRIDGE_BEFORE = snapshotDir(REAL_TASK_BRIDGE);
/** 套件启动时的真实 projects/ 顶层目录名快照。 */
const REAL_PROJECTS_BEFORE = (() => {
  try {
    return fs.readdirSync(REAL_WB_PROJECTS).sort();
  } catch (_error) {
    return null;
  }
})();

/**
 * 挑一个**确实含 `<system-reminder>` 附加块**的真实会话（取文件头部 64KB 探测）。
 *
 * @return {(Object|null)} 会话条目；找不到返回 null。
 */
function pickSessionWithSystemReminder() {
  for (const item of REAL_SESSIONS) {
    let head = '';
    try {
      const fd = fs.openSync(item.filePath, 'r');
      try {
        const buf = Buffer.alloc(65536);
        const read = fs.readSync(fd, buf, 0, 65536, 0);
        head = buf.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (_error) {
      continue;
    }
    if (head.includes('<system-reminder')) return item;
  }
  return null;
}

/** 真实 projects/ 下是否存在可用会话数据。 */
const HAS_REAL_PROJECTS = REAL_SESSIONS.length > 0;
/** 真实 sessions.json 索引是否可用。 */
const HAS_REAL_INDEX = fs.existsSync(REAL_WB_INDEX);

/**
 * 是否具备**完整**真实 WorkBuddy 部署（projects/ 与 sessions.json 二者俱在）。
 *
 * 注意：**不能**只用 `fs.existsSync(REAL_WB)` —— 一个**空的**目录同样「存在」，
 * 但其中没有任何真实数据；故以「projects/ 与 sessions.json 二者俱在」作为完整部署的判据。
 *
 * 但**并非所有**真实数据用例都需要索引：Mac 客户端不生成 `app/sessions.json`，
 * 而 `projects/<slug>/*.jsonl` 照常存在且可读。故门禁按用例的真实前置条件拆分：
 *   - 只需真实会话文件   → `HAS_REAL_PROJECTS`
 *   - 需要索引路径语义   → `HAS_REAL_INDEX`
 */
const HAS_REAL_DEPLOY = HAS_REAL_PROJECTS && HAS_REAL_INDEX;

/** 真实部署完全缺失时的统一跳过原因。 */
const SKIP_NO_REAL_DEPLOY =
  `本机无真实 WorkBuddy 部署数据（REAL_WB=${REAL_WB} 不存在、或为空目录/缺 projects、sessions.json）；` +
  '按审计 §7「可移植功能测试应与真实部署验收分开」跳过；' +
  '在本机默认环境或设 WB_REAL_WB 指向真实部署目录后，本用例会真实执行（断言不弱化）。';

/** 缺真实会话文件时的跳过原因（只需 projects/ 的用例）。 */
const SKIP_NO_REAL_PROJECTS =
  `本机 ${REAL_WB_PROJECTS} 下没有可读的会话 jsonl（REAL_WB=${REAL_WB}）；` +
  '本用例只需真实会话文件、不需要 sessions.json 索引；' +
  '设 WB_REAL_WB 指向含 projects/ 的真实部署目录后即会真实执行（断言不弱化）。';

/**
 * 缺 sessions.json 索引时的跳过原因。
 *
 * 本连接器已支持「索引缺失 → 只读目录扫描」兜底（见 lib/sessions.js），但**本组用例断言的是
 * 索引路径本身的语义**（slug 命中、resolvedVia='sessions.json'），扫描兜底无法替代该断言，
 * 故仍如实跳过，而不是把断言改弱成「能读到就算过」。
 */
const SKIP_NO_REAL_INDEX =
  `本机缺 sessions.json 索引（${REAL_WB_INDEX} 不存在；Mac 客户端不生成该文件）；` +
  '本组用例断言的是**索引路径语义**（slug 命中 / resolvedVia=sessions.json），扫描兜底不能替代该断言，' +
  '故如实跳过而不改弱断言；在 WinPC 或设 WB_REAL_WB 指向含 app/sessions.json 的部署后可真实执行。';

/**
 * 在「真实部署 = WorkBuddy 根」的进程内环境下运行 fn（临时设置 WB_WORKBUDDY_DIR）。
 *
 * 使进程内 resolveLayout() 与真实部署测量（HAS_REAL_DEPLOY）保持一致：
 * 即便 HOME/USERPROFILE 被重定向，也能让依赖真实数据的进程内用例读到 REAL_WB。
 *
 * @param {function(): *} fn 用例体。
 * @return {*} fn 的返回值。
 */
function withRealWorkbuddyDir(fn) {
  const prev = process.env.WB_WORKBUDDY_DIR;
  process.env.WB_WORKBUDDY_DIR = REAL_WB;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WB_WORKBUDDY_DIR;
    else process.env.WB_WORKBUDDY_DIR = prev;
  }
}

/**
 * F01 哨兵保护：在任何写入用例之前，把哨兵文件放入一个「既有」目录并记录哈希。
 * A1-2 / G3 断言这些文件在整个测试过程中从未被删除或改写。
 *
 * @return {{dir: string, files: Array<{path: string, hash: string}>}} 哨兵信息。
 */
function createSentinels() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-qa-sentinel-'));
  const files = [];
  for (const name of ['KEEP-EXISTING-QUEUE.txt', 'keep-2.json', 'keep-3.txt']) {
    const p = path.join(dir, name);
    const body = `SENTINEL-${name}-${TEST_MARK}`;
    fs.writeFileSync(p, body, 'utf8');
    files.push({ path: p, hash: crypto.createHash('sha256').update(body).digest('hex') });
  }
  return { dir, files };
}

/** 哨兵信息（在 main 开头初始化）。 */
let SENTINELS = null;

/**
 * 校验全部哨兵文件仍存在且哈希未变（内容未被改写）。
 *
 * @return {void}
 * @throws {Error} 任一哨兵缺失或内容变化时抛出。
 */
function assertSentinelsIntact() {
  if (!SENTINELS) throw new Error('哨兵未初始化');
  for (const item of SENTINELS.files) {
    if (!fs.existsSync(item.path)) throw new Error(`哨兵文件被删除: ${item.path}`);
    const body = fs.readFileSync(item.path, 'utf8');
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (hash !== item.hash) throw new Error(`哨兵文件被改写: ${item.path}`);
  }
}

/* ------------------------------------------------------------------ *
 * A. 可靠性
 * ------------------------------------------------------------------ */

/**
 * 以「被审计进程自己执行过的写 syscall」为证据，判定它写了哪些路径。
 * 比 mtime 快照可靠：WorkBuddy 自身会持续写 .workbuddy（logs/*.log、workbuddy.db-wal 等），
 * mtime 快照无法区分噪声与本连接器的写入。
 *
 * @param {string} auditFile 审计日志路径。
 * @return {Array<{op: string, target: string}>} 写操作记录。
 */
function readAudit(auditFile) {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function groupA() {
  group('A. 可靠性（写入边界 / 受保护文件 / 附加块处理 / slug 规则）');

  const AUDIT_PRELOAD = path.join(__dirname, 'helpers', 'write-audit.js');

  // --- A0: 哨兵保护（在任何写入用例之前）---
  await check('A0 哨兵文件已就位（2 个以上既有文件，记录哈希）', () => {
    assertSentinelsIntact();
    return `${SENTINELS.files.length} 个哨兵文件就位，目录 ${SENTINELS.dir}`;
  });

  // --- A1: 写入边界（用 syscall 审计，而非 mtime 快照）---
  // F01 整改：默认写路径用例不再使用真实用户目录，而是通过 WB_WORKBUDDY_DIR 把
  // WorkBuddy 根重定向到一个本次 mkdtemp 创建的隔离目录。清理只针对**本次创建**的路径。
  /**
   * 所有权标记（ownership marker）——只有路径含此前缀、且由本次运行 `mkdtempSync` 创建的隔离目录
   * 才被允许清理；任何「测试前已存在」的目录一律不碰（F01 修复的核心）。
   * 静态验收（F01.2）依赖此命名存在。
   */
  const OWNERSHIP_MARKER = 'wb-qa-home-';
  let a1OwnedBridgeDir = null;
  await check('A1-1 默认布局（隔离 WB_WORKBUDDY_DIR）下，全部写 syscall 落在 <wb>/task-bridge 内', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), OWNERSHIP_MARKER));
    const fakeWb = path.join(fakeHome, '.workbuddy');
    fs.mkdirSync(fakeWb, { recursive: true });
    const expectedBridge = path.join(fakeWb, 'task-bridge');
    assert.ok(!fs.existsSync(expectedBridge), '前置条件不满足：隔离目录的 task-bridge 已存在');

    const auditFile = path.join(QA_ROOT, 'audit-default.log');
    fs.rmSync(auditFile, { force: true });
    // replaceEnv + 只给这些变量：确保 TASK / WB_BRIDGE_STORE / WB_BRIDGE_DIR 不存在，
    // 但 WB_WORKBUDDY_DIR 指向隔离目录 -> 服务走「默认布局」，且绝不触真实 .workbuddy。
    const client = new RawClient({
      env: { WB_BRIDGE_LOG: '0', WB_QA_AUDIT_FILE: auditFile, WB_WORKBUDDY_DIR: fakeWb, PATH: process.env.PATH || '' },
      replaceEnv: true,
      preload: AUDIT_PRELOAD,
    });
    try {
      const info = await client.call('wb_bridge_info');
      assert.strictEqual(info.payload.sandboxed, false, 'sandboxed 应为 false（未设 TASK/STORE）');
      assert.strictEqual(info.payload.pathSources.store, 'default', `store 来源=${info.payload.pathSources.store}，应为 default`);
      assert.strictEqual(info.payload.paths.workbuddyDir, fakeWb, 'workbuddyDir 未指向隔离目录');
      const sent = await client.call('wb_send_instruction', { instruction: `qa-verify ${TEST_MARK}` });
      assert.ok(!sent.raw.isError, `入队失败: ${sent.raw.content[0].text.slice(0, 300)}`);
      const audit = readAudit(auditFile);
      assert.ok(audit.length > 0, '审计日志为空，无法证明写入边界（审计未生效？）');
      const bridgeDirLower = expectedBridge.toLowerCase();
      const violations = audit.filter((a) => {
        const t = path.resolve(a.target).toLowerCase();
        const inside = t === bridgeDirLower || t.startsWith(bridgeDirLower + path.sep);
        return !inside;
      });
      assert.strictEqual(violations.length, 0,
        `task-bridge 之外发生 ${violations.length} 次写操作:\n` +
        violations.slice(0, 10).map((v) => `    ${v.op} -> ${v.target}`).join('\n'));
      assert.ok(fs.existsSync(path.join(expectedBridge, 'pending')), '默认路径下未创建 task-bridge/pending/');
      const md = readMaildir(expectedBridge);
      assert.strictEqual(md.records.length, 1, '默认路径下未成功写入 1 条指令');
      // 仅当本用例确实创建了该隔离目录时才登记为「本次拥有」。
      a1OwnedBridgeDir = expectedBridge;
      return `审计到 ${audit.length} 次写 syscall（sandboxed=false, store 来源=default），全部在隔离 task-bridge/ 内`;
    } finally {
      client.close();
    }
  });

  await check('A1-2 清理 A1-1 本次创建的隔离 task-bridge（仅当本用例拥有所有权）', () => {
    if (!a1OwnedBridgeDir) {
      // 前置条件未满足 / A1-1 异常时**禁止进入清理**（F01 根因）。
      return 'SKIP：A1-1 未登记所有权，按设计跳过清理（绝不删除既有目录）';
    }
    const ownLower = a1OwnedBridgeDir.toLowerCase();
    assert.ok(ownLower.includes(OWNERSHIP_MARKER), `拒绝清理非本用例拥有的路径: ${a1OwnedBridgeDir}`);
    if (fs.existsSync(a1OwnedBridgeDir)) fs.rmSync(a1OwnedBridgeDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(a1OwnedBridgeDir), '隔离 task-bridge 未能清理');
    // 清理之后哨兵必须原封不动。
    assertSentinelsIntact();
    return '已删除本次创建的隔离 task-bridge/，哨兵完好';
  });

  await check('A1-3 隔离模式(TASK=1+STORE)下，全部写 syscall 均落在 %TEMP% 内', async () => {
    const sb = sandbox('a1-sandboxed');
    const auditFile = path.join(QA_ROOT, 'audit-sandbox.log');
    fs.rmSync(auditFile, { force: true });
    const client = new RawClient({ env: { ...sb.env, WB_QA_AUDIT_FILE: auditFile }, preload: AUDIT_PRELOAD });
    try {
      await client.call('wb_send_instruction', { instruction: `qa-verify ${TEST_MARK}` });
      await client.call('wb_pending_instructions', { limit: 5 });
      await client.call('wb_instruction_stats');
      const audit = readAudit(auditFile);
      assert.ok(audit.length > 0, '审计日志为空');
      const sandboxLower = path.resolve(sb.dir).toLowerCase();
      const outside = audit.filter((a) => {
        const t = path.resolve(a.target).toLowerCase();
        return !(t === sandboxLower || t.startsWith(sandboxLower + path.sep));
      });
      assert.strictEqual(outside.length, 0,
        `隔离模式下写入 %TEMP% 之外 ${outside.length} 次:\n` +
        outside.slice(0, 10).map((v) => `    ${v.op} -> ${v.target}`).join('\n'));
      assert.ok(fs.existsSync(path.join(sb.store, 'pending')), '隔离目录 store 未生成 pending/');
      return `${audit.length} 次写 syscall 全部在 ${sb.dir}`;
    } finally {
      client.close();
    }
  });

  await check('A1-4 全部读操作（真实数据）均为只读：审计中无 workbuddy.db 相关写操作', async () => {
    const sb = sandbox('a1-readonly');
    const auditFile = path.join(QA_ROOT, 'audit-readonly.log');
    fs.rmSync(auditFile, { force: true });
    const client = new RawClient({ env: { ...sb.env, WB_QA_AUDIT_FILE: auditFile }, preload: AUDIT_PRELOAD });
    try {
      await client.call('wb_list_sessions', { limit: 5, includeCounts: true });
      await client.call('wb_read_session', { conversationId: 'ef8a2f20-d32d-40ae-a66b-7b715b9ca0ab', maxMessages: 2, maxChars: 500, includeSubagents: true });
      await client.call('wb_search_sessions', { keyword: 'WorkBuddy', maxSessions: 2 });
      await client.call('wb_bridge_info');
      const audit = readAudit(auditFile);
      const dbWrites = audit.filter((a) => /workbuddy\.db/i.test(a.target));
      assert.strictEqual(dbWrites.length, 0,
        `出现对 workbuddy.db 的写操作:\n${dbWrites.map((v) => `    ${v.op} -> ${v.target}`).join('\n')}`);
      const realDataWrites = audit.filter((a) => {
        const t = path.resolve(a.target).toLowerCase();
        return t.startsWith(path.join(REAL_WB, 'projects').toLowerCase())
          || t === path.join(REAL_WB, 'app', 'sessions.json').toLowerCase();
      });
      assert.strictEqual(realDataWrites.length, 0,
        `出现对 WorkBuddy 真实会话数据的写操作 ${realDataWrites.length} 次:\n` +
        realDataWrites.slice(0, 10).map((v) => `    ${v.op} -> ${v.target}`).join('\n'));
      return `读取 4 个工具共 ${audit.length} 次写 syscall，真实数据与 db 均 0 写入`;
    } finally {
      client.close();
    }
  });

  // --- A2: 受保护文件 ---
  await check('A2-1 assertSafeReadable 拦截 workbuddy.db 及 -wal/-shm/-journal', () => {
    for (const base of paths.FORBIDDEN_BASENAMES) {
      const r = paths.assertSafeReadable(path.join(REAL_WB, base));
      assert.strictEqual(r.ok, false, `${base} 未被拦截`);
      assert.ok(r.reason.includes('FORBIDDEN_PATH'), `${base} 拒绝原因非 FORBIDDEN_PATH: ${r.reason}`);
    }
    return `拦截 ${paths.FORBIDDEN_BASENAMES.length} 个受保护 basename`;
  });

  await check('A2-2 大小写/变体形式（WORKBUDDY.DB、Workbuddy.Db-Wal）仍被拦截', () => {
    for (const variant of ['WORKBUDDY.DB', 'Workbuddy.Db-Wal', 'workbuddy.DB-shm', 'WORKBUDDY.db-Journal']) {
      const r = paths.assertSafeReadable(path.join(REAL_WB, variant));
      assert.strictEqual(r.ok, false, `${variant} 越过大小写检查`);
      assert.ok(r.reason.includes('FORBIDDEN_PATH'), `${variant} 原因异常: ${r.reason}`);
    }
    return '大小写变体全部拦截';
  });

  await check('A2-3 经 wb_read_session 用 conversationId 传 db 路径不被读取', async () => {
    const sb = sandbox('a2-db');
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
        const text = r.raw.content[0].text;
        assert.ok(!/SQLite format 3/i.test(text), `conversationId=${cid} 读到了 db 二进制内容`);
        assert.ok(!text.includes(TEST_MARK), `conversationId=${cid} 异常返回内容`);
        assert.ok(r.raw.isError === true, `conversationId=${cid} 竟成功返回（应被拒绝）`);
        // 修复 BUG-3 后，含路径分隔符的输入走 INVALID_CONVERSATION_ID（更精确的拒绝）；
        // 不含分隔符但不存在的安全 ID 走 SESSION_NOT_FOUND。两者都是有效拒绝。
        assert.ok(
          text.includes('INVALID_CONVERSATION_ID') || text.includes('SESSION_NOT_FOUND'),
          `conversationId=${cid} 错误码既非 INVALID_CONVERSATION_ID 也非 SESSION_NOT_FOUND: ${text.slice(0, 200)}`,
        );
      }
      return `${attempts.length} 种 db 路径全部拒绝，未读到任何内容`;
    } finally {
      client.close();
    }
  });

  await check('A2-4 assertSafeReadable 在文件不存在时安全失败（非抛异常）', () => {
    // 用隔离目录自证「安全失败」，不依赖真实部署（Linux 审计机同样适用）。
    const sb = sandbox('a2-safe');
    const r = paths.assertSafeReadable(path.join(sb.dir, 'definitely-not-here-12345.jsonl'));
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.startsWith('NOT_FOUND'), r.reason);
    const r2 = paths.assertSafeReadable(sb.dir); // 真实存在的目录 -> NOT_A_FILE
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.reason.startsWith('NOT_A_FILE'), r2.reason);
    return 'NOT_FOUND / NOT_A_FILE 均安全失败（隔离目录，位置无关）';
  });

  await check('A2-5 【已修复】conversationId 越级路径被拦截，读不到 projects/ 之外的 .jsonl', async () => {
    if (!HAS_REAL_PROJECTS) skipCase(SKIP_NO_REAL_PROJECTS);
    const sb = sandbox('a2-path-checks');
    const outsideFile = path.join(sb.dir, 'outside', 'outside.jsonl');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile,
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: TEST_MARK }] }) + '\n', 'utf8');

    // 【M3】真实项目目录改为运行时发现，不再硬编码 WinPC 目录名。
    const fixture = REAL_SESSIONS[0];
    const projectDir = fixture.projectDir;
    const cid = path.relative(projectDir, outsideFile).replace(/\.jsonl$/, '');
    assert.ok(cid.includes('..'), '越级路径构造失败');

    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: cid, maxChars: 5000 });
      const text = r.raw.content[0].text;
      // 修复后：越级输入必须被拒绝，且外部文件内容（TEST_MARK）未出现在响应中。
      assert.ok(!text.includes(TEST_MARK), `越级路径仍能读到 projects/ 之外的内容: ${text.slice(0, 300)}`);
      assert.strictEqual(r.raw.isError, true, '越级输入竟成功返回（应被拒绝）');
      assert.ok(text.includes('INVALID_CONVERSATION_ID'),
        `期望 INVALID_CONVERSATION_ID，实际: ${text.slice(0, 240)}`);
      return `已拦截：conversationId='${cid}' 被拒绝，外部文件内容未出现在响应中`;
    } finally {
      client.close();
    }
  });

  await check('A2-6 越级受限于 .jsonl 后缀（不能读任意扩展名文件）', async () => {
    const sb = sandbox('a2-ext');
    const txt = path.join(sb.dir, 'outside', 'secret.txt');
    fs.mkdirSync(path.dirname(txt), { recursive: true });
    fs.writeFileSync(txt, 'PLAINTEXT-MARK-77ab', 'utf8');
    // 【M3】基准项目目录改为运行时发现（有真实会话时用真实目录，否则退回纯相对路径构造）。
    const baseProjectDir = HAS_REAL_PROJECTS
      ? REAL_SESSIONS[0].projectDir
      : path.join(REAL_WB_PROJECTS, 'nonexistent-project');
    const projectDir = baseProjectDir;
    // 只能命中 <path>.jsonl
    const cid = path.relative(projectDir, txt).replace(/\.txt$/, '.jsonl');
    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: cid });
      assert.ok(r.raw.isError === true, '竟成功读取');
      assert.ok(!r.raw.content[0].text.includes('PLAINTEXT-MARK-77ab'), '出现了非 .jsonl 文件内容');
      return '受 .jsonl 后缀限制，非 jsonl 文件无法被越级读取';
    } finally {
      client.close();
    }
  });

  await check('A2-7 subagents 越级路径（includeSubagents + 异常 conversationId）', async () => {
    const sb = sandbox('a2-subagents');
    // 造一个假的 <dir>/<convId>/subagents 结构，convId 用越级值
    const fakeRoot = path.join(sb.dir, 'fake', 'subagents');
    const outsideConv = path.join(sb.dir, 'outside');
    fs.mkdirSync(path.join(outsideConv, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(outsideConv, 'subagents', 'agent-x.jsonl'),
      JSON.stringify({ type: 'message', role: 'user', content: 'SUBAGENT-MARK-5511' }) + '\n', 'utf8');
    void fakeRoot;
    // 【M3】基准项目目录改为运行时发现。
    const projectDir = HAS_REAL_PROJECTS
      ? REAL_SESSIONS[0].projectDir
      : path.join(REAL_WB_PROJECTS, 'nonexistent-project');
    // 指向该外部目录下的 <convId>.jsonl（不存在）——确认不会因越级而崩溃即可
    const cid = path.relative(projectDir, path.join(outsideConv, 'nope')).replace(/\.jsonl$/, '');
    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: cid, includeSubagents: true });
      assert.ok(!r.raw.content[0].text.includes('SUBAGENT-MARK-5511'), '越级读取到了 subagents 内容');
      assert.strictEqual(client.exited, false, '服务因越级输入而退出');
      return '越级输入被安全拒绝，服务存活';
    } finally {
      client.close();
    }
  });

  // --- A3: 附加块处理 ---
  await check('A3-1 includeSystemReminders=true 返回原文；默认 false 剥离系统附加块（仅检查 messages）', async () => {
    if (!HAS_REAL_PROJECTS) skipCase(SKIP_NO_REAL_PROJECTS);
    // 【M3】不再硬编码 WinPC 的真实会话 ID：运行时挑一个确实含 <system-reminder> 的真实会话。
    const fixture = pickSessionWithSystemReminder();
    if (!fixture) skipCase(`真实 projects/ 下的会话文件头部 64KB 内均未出现 <system-reminder>（REAL_WB=${REAL_WB}）；本用例需要含附加块的真实会话作为素材。`);
    const sb = sandbox('a3-reminder');
    // 显式把服务端指向 REAL_WB，使其与真实素材的测量对象一致（不受 HOME 重定向影响）。
    const client = new RawClient({ env: { ...sb.env, WB_WORKBUDDY_DIR: REAL_WB } });
    try {
      // <system-reminder> 通常只出现在首条消息，故必须读全量（maxMessages 设大），否则尾部窗口取不到。
      const realId = fixture.conversationId;
      const args = { conversationId: realId, maxMessages: 1000, maxChars: 500000 };
      const on = await client.call('wb_read_session', { ...args, includeSystemReminders: true });
      const off = await client.call('wb_read_session', { ...args, includeSystemReminders: false });
      // 只检查 messages[]：notes[] 里本来就有 '<system-reminder>' 这个词（说明文案），属正常。
      const onHas = on.payload.messages.some((m) => m.text.includes('<system-reminder'));
      const offHas = off.payload.messages.some((m) => m.text.includes('<system-reminder'));
      assert.strictEqual(onHas, true, `includeSystemReminders=true 未返回 system-reminder 原文（共 ${on.payload.messages.length} 条消息）`);
      assert.strictEqual(offHas, false, '默认(off)的 messages 中仍含 system-reminder 原文');
      assert.ok(off.payload.removedSystemReminderMessages >= 1,
        `removedSystemReminderMessages=${off.payload.removedSystemReminderMessages}，应为 >=1`);
      const onLen = on.payload.messages.reduce((s, m) => s + m.textLength, 0);
      const offLen = off.payload.messages.reduce((s, m) => s + m.textLength, 0);
      assert.ok(onLen > offLen, `开启后文本未变多：on=${onLen} off=${offLen}`);
      return `${fixture.conversationId}（slug=${fixture.slug}）：全量 ${on.payload.messages.length} 条，on ${onLen} 字符 / off ${offLen} 字符，剥离 ${off.payload.removedSystemReminderMessages} 条`;
    } finally {
      client.close();
    }
  });

  await check('A3-2 剥离后不残留 identity 敏感标记（SOUL.md/IDENTITY.md/USER.md 路径）', async () => {
    if (!HAS_REAL_PROJECTS) skipCase(SKIP_NO_REAL_PROJECTS);
    const fixture = REAL_SESSIONS[0];
    const sb = sandbox('a3-strip');
    const client = new RawClient({ env: { ...sb.env, WB_WORKBUDDY_DIR: REAL_WB } });
    try {
      const r = await client.call('wb_read_session', {
        conversationId: fixture.conversationId,
        maxMessages: 3, maxChars: 200000, includeSystemReminders: false,
      });
      const text = r.raw.content[0].text;
      // identity 文件内容整体位于 <system-reminder> 内，默认剥离后不应出现其正文标记。
      const bodyHasSoul = /# SOUL\.md - Who You Are/.test(text);
      assert.ok(!bodyHasSoul, '默认返回中仍含 SOUL.md 正文，剥离不彻底');
      return `SOUL.md 正文未出现（素材 ${fixture.conversationId}）`;
    } finally {
      client.close();
    }
  });

  await check('A3-3 异常会话文本（含仿造 system-reminder）被默认剥离', () => {
    const sample = 'before<system-reminder data-role="system">HIDDEN-BLOCK-CONTENT</system-reminder>after';
    const stripped = jsonl.stripSystemReminders(sample);
    assert.strictEqual(stripped.removed, true, '未识别为已移除');
    assert.ok(!stripped.text.includes('HIDDEN-BLOCK-CONTENT'),
      `附加块内容残留: ${stripped.text}`);
    assert.ok(stripped.text.includes('before') && stripped.text.includes('after'), '误删正常内容');
    return '附加块被剥离，前后文保留';
  });

  await check('A3-4 未闭合 system-reminder（真实截断场景）也被剥离', () => {
    const truncated = 'text<system-reminder data-role="user-context">\n<user_info>IDENTITY-BLOB-EXAMPLE';
    const stripped = jsonl.stripSystemReminders(truncated);
    assert.ok(stripped.text.includes('text'), '正常前缀被误删');
    assert.ok(!stripped.text.includes('IDENTITY-BLOB-EXAMPLE'), '未闭合附加块内容出现在输出中');
    return '未闭合附加块已剥离';
  });

  await check('A3-5 附加块风险评估：默认关闭可过滤附加块，但缺少提示词层强化（P2 记录）', () => {
    // 不断言失败，仅记录事实：返回体没有任何来源标注/边界标记。
    const r = jsonl.toMessage(
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'SAMPLE-RETURN-TEXT' }] },
      { includeSystemReminders: false, maxChars: 4000 },
    );
    assert.strictEqual(r.text, 'SAMPLE-RETURN-TEXT');
    // 事实记录：会话原文无任何 untrusted/来源标注字段。
    assert.ok(!('provenance' in r) && !('untrusted' in r), '意外存在来源标注字段');
    return '事实记录：会话文本无来源标注，附加内容风险依赖外部 agent 自身判断（P2）';
  });

  // --- A4: slug 规则 ---
  await check('A4-1 slugifyPath 输出与真实 projects/ 目录名逐一比对（真实数据）', () => {
    if (!HAS_REAL_INDEX) skipCase(SKIP_NO_REAL_INDEX);
    const projectsDir = REAL_WB_PROJECTS;
    const index = JSON.parse(fs.readFileSync(REAL_WB_INDEX, 'utf8'));
    const checked = [];
    for (const entry of index.sessions) {
      if (typeof entry.workDir !== 'string') continue;
      const slug = paths.slugifyPath(entry.workDir);
      const real = fs.readdirSync(projectsDir).find((d) => entry.workDir.replace(/[\\/:]/g, '-').toLowerCase().includes(path.basename(slug).slice(-12).toLowerCase()));
      checked.push({ workDir: entry.workDir, slug, exists: fs.existsSync(path.join(projectsDir, slug)) });
    }
    const missing = checked.filter((c) => !c.exists);
    assert.strictEqual(missing.length, 0,
      `slugifyPath 生成的目录在真实磁盘上不存在（双破折号 bug）:\n` +
      missing.map((m) => `    workDir=${m.workDir}\n    slug   =${m.slug}`).join('\n'));
    return `${checked.length} 个真实会话 slug 全部命中`;
  });

  await check('A4-2 中文/空格/盘符路径 slug 与 WorkBuddy 真实命名一致', () => {
    // 【M3】拆分：规则断言（纯单元）恒执行；「与真实目录名比对」部分仅在真实素材可用时执行。
    // 旧实现把整例门禁在「WinPC 特定目录名存在」上，换机后连**规则本身**都没被验证过。
    const sample = 'D:\\OneDrive\\4、董娣相关\\4、专利知识库';
    const expected = 'd-OneDrive-4、董娣相关-4、专利知识库';
    const got = paths.slugifyPath(sample);
    assert.strictEqual(got, expected,
      `中文路径 slug 不符：期望 ${expected}，实际 ${got}（冒号与反斜杠各产生一个 '-'）`);

    if (!HAS_REAL_PROJECTS) {
      return `规则断言通过（${sample} -> ${got}）；本机无真实 projects/ 素材，跳过与真实目录名的比对`;
    }
    const realDirs = fs.readdirSync(REAL_WB_PROJECTS);
    const cn = realDirs.filter((d) => /[一-龥]/.test(d));
    assert.ok(cn.length > 0, '真实数据中没有中文目录，无法验证');
    // 真实素材若恰好包含该样例目录（WinPC 部署），额外做一次「规则可复现真实目录名」的强断言。
    if (cn.includes(expected)) {
      return `规则断言通过 + 真实目录命中：${got}`;
    }
    // Mac 等部署下目录名不同：改为对**每个真实中文目录**做「无双破折号」不变量校验。
    const doubled = cn.filter((d) => d.includes('--'));
    assert.strictEqual(doubled.length, 0, `真实中文目录名含双破折号（slug 规则可能回退）: ${doubled.join(', ')}`);
    return `规则断言通过（${got}）；本机 ${cn.length} 个真实中文目录名均无双破折号（无 WinPC 样例目录，未做同名字符串比对）`;
  });

  await check('A4-3 正斜杠路径归一化后仍产生双破折号（同一 bug 面）', () => {
    const got = paths.slugifyPath('C:/Users/TinaD/WorkBuddy/2026-10-07-11-15-23');
    const expected = 'c-Users-TinaD-WorkBuddy-2026-10-07-11-15-23';
    assert.strictEqual(got, expected, `正斜杠路径 slug 不符：期望 ${expected}，实际 ${got}`);
    return 'OK';
  });

  await check('A4-4 空/异常输入返回空串而不抛异常', () => {
    for (const bad of ['', null, undefined, 123, {}]) {
      assert.strictEqual(paths.slugifyPath(bad), '', `输入 ${JSON.stringify(bad)} 未返回空串`);
    }
    return '6 种异常输入安全';
  });

  await check('A4-5 【已修复】resolveSession 走 sessions.json 索引路径命中（slug 修复后不再依赖扫描兜底）', () => {
    if (!HAS_REAL_INDEX) skipCase(SKIP_NO_REAL_INDEX);
    return withRealWorkbuddyDir(() => {
      const sb = sandbox('a4-scan');
      process.env.WB_BRIDGE_STORE = sb.store;
      const layout = paths.resolveLayout();
      const index = sessionsMod.loadSessionIndex(layout);
      const cid = index.sessions[0].conversationId;
      const resolved = sessionsMod.resolveSession(cid, layout, index);
      assert.ok(resolved.filePath && fs.existsSync(resolved.filePath), '索引路径未命中');
      assert.strictEqual(resolved.via, 'sessions.json',
        `via=${resolved.via}，预期 sessions.json（slug 修复后索引路径应直接可用）`);
      return `via=${resolved.via}（索引路径直接命中，无需扫描兜底）`;
    });
  });
}

/* ------------------------------------------------------------------ *
 * B. 真实数据鲁棒性（全部使用 %TEMP% 下的合成 fixture）
 * ------------------------------------------------------------------ */

/**
 * 构造一个隔离的 projects + sessions.json fixture 环境。
 *
 * @param {string} name 子目录名。
 * @return {{dir: string, store: string, projectsDir: string, indexPath: string, env: Object<string,string>}} fixture。
 */
function makeFixture(name) {
  const base = sandbox(name);
  const projectsDir = path.join(base.dir, 'projects');
  const indexPath = path.join(base.dir, 'sessions.json');
  fs.mkdirSync(projectsDir, { recursive: true });
  return {
    dir: base.dir,
    store: base.store,
    projectsDir,
    indexPath,
    env: {
      TASK: '1',
      WB_BRIDGE_STORE: base.store,
      WB_BRIDGE_LOG: '0',
      WB_PROJECTS_DIR: projectsDir,
      WB_SESSIONS_INDEX: indexPath,
    },
  };
}

/**
 * 向 fixture 写入一个会话。
 *
 * 默认让 workDir 与目录名按 WorkBuddy 的「单破折号」真实规则保持一致，
 * 这样工具级用例才能验证工具本身；slug 规则本身的正确性由 A4 组单独验证。
 *
 * @param {Object} fixture fixture。
 * @param {string} slug 项目目录名（须等于真实规则下的 slug）。
 * @param {string} conversationId 会话 ID。
 * @param {string[]} lines 原始行数组。
 * @param {Object} [meta] 追加到 sessions.json 的字段。
 * @return {string} jsonl 路径。
 */
function writeSession(fixture, slug, conversationId, lines, meta = {}) {
  const dir = path.join(fixture.projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${conversationId}.jsonl`);
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  const raw = JSON.parse(fs.existsSync(fixture.indexPath) ? fs.readFileSync(fixture.indexPath, 'utf8') : '{"version":1,"sessions":[]}');
  // 反推一个能 slug 化为 slug 的 workDir：按 WorkBuddy 真实规则，slug 以 'c-' 开头
  // 对应 'C:\'，故 workDir = 'C:\' + slug.slice(2).split('-').join('\\') 之前的原始片段。
  // 由于 slug 本身由 makeWorkDir 生成，这里直接用 segments 还原。
  const segments = meta.segments || slug.replace(/^c-/, '').split('-');
  const workDir = meta.workDir || `C:\\${segments.join('\\')}`;
  raw.sessions.push({ conversationId, workDir, startedAt: '2026-01-01T00:00:00.000Z', resumedAt: '2026-01-02T00:00:00.000Z', ...meta });
  delete raw.sessions[raw.sessions.length - 1].segments;
  fs.writeFileSync(fixture.indexPath, JSON.stringify(raw, null, 2), 'utf8');
  return file;
}

/**
 * 生成一个符合 WorkBuddy 真实命名规则的 fixture slug 与其反推 workDir。
 *
 * 真实规则：盘符首字母小写，「盘符冒号 + 分隔符」合并为单个 '-'，其余分隔符各为 '-'。
 * 例：`C:\fixture\tools` -> `c-fixture-tools`。
 *
 * @param {string[]} segments 路径片段（不含盘符）。
 * @return {{slug: string, workDir: string}} slug 与 workDir。
 */
function makeWorkDir(segments) {
  const workDir = `C:\\${segments.join('\\')}`;
  const slug = `c-${segments.join('-')}`;
  return { slug, workDir };
}

/**
 * 构造一条 message 行。
 *
 * @param {string} text 文本。
 * @param {string} [role] 角色。
 * @return {string} JSON 行。
 */
function msgLine(text, role = 'user') {
  return JSON.stringify({ id: crypto.randomUUID(), timestamp: 1767225600000, type: 'message', role, content: [{ type: 'input_text', text }] });
}

async function groupB() {
  group('B. 真实数据鲁棒性（半截行 / 畸形数据 / 截断与协议流）');

  await check('B0-0 自检：fixture 的 workDir<->slug 往返符合 WorkBuddy 真实规则', () => {
    // 保证后续 B/C/E 组用例验证的是「工具行为」而非「slug bug」。
    const samples = [['fixture', 'empty'], ['fixture', 'meta'], ['fx', 'tool'], ['a', 'b', 'c']];
    for (const segments of samples) {
      const { slug, workDir } = makeWorkDir(segments);
      // 用「正确规则」独立实现一遍 slug 化（连续分隔符合并为单个 '-'）
      const correct = workDir.replace(/^([A-Za-z]):/, (_m, l) => l.toLowerCase() + ':').replace(/[\\/:]+/g, '-');
      assert.strictEqual(correct, slug,
        `往返不一致: workDir=${workDir} 规则输出=${correct} 期望=${slug}`);
    }
    return `${samples.length} 组往返一致（真实规则：分隔符合并为单 '-'）`;
  });

  await check('B0-1 【已修复】slugifyPath 与 WorkBuddy 真实规则一致（分隔符合并为单 "-"）', () => {
    const { slug, workDir } = makeWorkDir(['fixture', 'tool']);
    const correct = workDir.replace(/^([A-Za-z]):/, (_m, l) => l.toLowerCase() + ':').replace(/[\\/:]+/g, '-');
    const actual = paths.slugifyPath(workDir);
    assert.strictEqual(actual, correct,
      `实现仍与真实规则不一致：actual='${actual}' 正确规则='${correct}'`);
    assert.ok(!actual.includes('--'), `slug 仍含双破折号: ${actual}`);
    return `实现已对齐真实规则：'${workDir}' -> '${actual}'`;
  });

  // --- B5: 半截 JSON 行 ---
  await check('B5-1 末行截断的 jsonl：wb_read_session 不崩溃且 skipped 计数正确', async () => {
    const fx = makeFixture('b5-partial');
    const slug = 'c-fixture-partial';
    writeSession(fx, slug, 'conv-partial', [
      msgLine('第一行完整'),
      msgLine('第二行完整'),
      '{"type":"message","role":"assistant","content":[{"type":"text","text":"半截未闭合',
    ]);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-partial' });
      assert.ok(!r.raw.isError, `读取失败: ${r.raw.content[0].text.slice(0, 300)}`);
      assert.strictEqual(r.payload.skipped, 1, `skipped=${r.payload.skipped}，应为 1`);
      assert.strictEqual(r.payload.totalMessages, 2, `totalMessages=${r.payload.totalMessages}，应为 2`);
      assert.strictEqual(r.payload.returnedMessages, 2);
      assert.strictEqual(client.exited, false, '服务因半截行而退出');
      return `skipped=${r.payload.skipped}, totalMessages=${r.payload.totalMessages}`;
    } finally {
      client.close();
    }
  });

  await check('B5-2 末行截断的 jsonl：wb_search_sessions 不崩溃', async () => {
    const fx = makeFixture('b5-search');
    const slug = 'c-fixture-search';
    writeSession(fx, slug, 'conv-search', [
      msgLine('关键 needle 出现在这里'),
      msgLine('后续内容'),
      '{"type":"message","role":"assistant","content":[{"type":"text","text":"截断',
    ]);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_search_sessions', { keyword: 'needle' });
      assert.ok(!r.raw.isError, `搜索失败: ${r.raw.content[0].text.slice(0, 300)}`);
      assert.ok(r.payload.hitCount >= 1, `未命中，scope=${JSON.stringify(r.payload.scope)}`);
      assert.strictEqual(client.exited, false);
      return `hitCount=${r.payload.hitCount}`;
    } finally {
      client.close();
    }
  });

  await check('B5-3 readRecords 的 partialFirstLine 仅在尾部读取时为 true', () => {
    const fx = makeFixture('b5-pfl');
    const file = writeSession(fx, 'c-fx', 'conv', [msgLine('a'.repeat(500)), msgLine('b'.repeat(500)), msgLine('c'.repeat(500))]);
    const full = jsonl.readRecords(file);
    assert.strictEqual(full.partialFirstLine, false, '全量读取不应标记 partialFirstLine');
    const tail = jsonl.readRecords(file, { maxBytes: 200, tail: true });
    assert.strictEqual(tail.partialFirstLine, true, '尾部读取应标记 partialFirstLine');
    assert.strictEqual(tail.truncated, true);
    return `full.skipped=${full.skipped}, tail.partialFirstLine=${tail.partialFirstLine}`;
  });

  // --- B6: 畸形数据 ---
  await check('B6-1 空文件会话', async () => {
    const fx = makeFixture('b6-empty');
    writeSession(fx, 'c-fx-empty', 'conv-empty', []);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-empty' });
      assert.ok(!r.raw.isError, `空文件读取失败: ${r.raw.content[0].text.slice(0, 200)}`);
      assert.strictEqual(r.payload.totalMessages, 0);
      assert.deepStrictEqual(r.payload.messages, []);
      return 'totalMessages=0';
    } finally {
      client.close();
    }
  });

  await check('B6-2 只有 session-meta（非 message 行）', async () => {
    const fx = makeFixture('b6-meta');
    writeSession(fx, 'c-fx-meta', 'conv-meta', [
      JSON.stringify({ type: 'session-meta', id: 'x', timestamp: 1 }),
      JSON.stringify({ type: 'summary', summary: 'x' }),
    ]);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-meta' });
      assert.ok(!r.raw.isError);
      assert.strictEqual(r.payload.totalMessages, 0, '非 message 行被误当消息');
      assert.strictEqual(r.payload.skipped, 0, '合法非消息行不应计入 skipped');
      return '非消息行被正确忽略';
    } finally {
      client.close();
    }
  });

  await check('B6-3 缺字段 / 未知 content type / 混合非法行', async () => {
    const fx = makeFixture('b6-weird');
    writeSession(fx, 'c-fx-weird', 'conv-weird', [
      JSON.stringify({ type: 'message' }),
      JSON.stringify({ type: 'message', role: 'assistant' }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'image', data: 'xxx' }] }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'unknown_future_type', text: '未知类型' }] }),
      JSON.stringify({ type: 'message', role: 'user', content: [] }),
      'not json at all',
      '[1,2,3]',
      '"just a string"',
      '12345',
      'null',
      msgLine('正常行'),
    ]);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-weird' });
      assert.ok(!r.raw.isError, `畸形数据导致失败: ${r.raw.content[0].text.slice(0, 300)}`);
      assert.ok(Array.isArray(r.payload.messages));
      for (const m of r.payload.messages) {
        assert.strictEqual(typeof m.role, 'string');
        assert.strictEqual(typeof m.text, 'string');
        assert.ok(m.time === null || typeof m.time === 'string', 'time 字段类型异常');
      }
      assert.strictEqual(client.exited, false, '服务因畸形数据退出');
      return `messages=${r.payload.messages.length}, skipped=${r.payload.skipped}`;
    } finally {
      client.close();
    }
  });

  await check('B6-4 content 为字符串 / 嵌套 content / null 均安全', () => {
    const opts = { includeSystemReminders: false, maxChars: 4000 };
    const cases = [
      { type: 'message', role: 'user', content: 'plain string' },
      { type: 'message', role: 'user', content: { text: 'obj text' } },
      { type: 'message', role: 'user', content: { content: [{ type: 'text', text: 'nested' }] } },
      { type: 'message', role: 'user', content: null },
      { type: 'message', role: 'user' },
    ];
    for (const c of cases) {
      const m = jsonl.toMessage(c, opts);
      assert.ok(m, `toMessage 返回 null: ${JSON.stringify(c)}`);
      assert.strictEqual(typeof m.text, 'string');
    }
    return `${cases.length} 种 content 形态均安全`;
  });

  await check('B6-5 sessions.json 损坏 / 缺失时安全降级', async () => {
    const fx = makeFixture('b6-badindex');
    fs.writeFileSync(fx.indexPath, '{ this is not json', 'utf8');
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_list_sessions', { limit: 5 });
      assert.ok(!r.raw.isError, '索引损坏导致工具报错');
      assert.strictEqual(r.payload.indexReadable, false);
      assert.ok(r.payload.indexError.includes('JSON_PARSE_ERROR'), r.payload.indexError);
      return `indexError=${r.payload.indexError.slice(0, 40)}`;
    } finally {
      client.close();
    }
  });

  // --- B7: 截断 + 协议流 ---
  await check('B7-1 maxChars 截断生效且 truncated/textLength 正确', async () => {
    const fx = makeFixture('b7-trunc');
    const big = 'X'.repeat(50000);
    writeSession(fx, 'c-fx-big', 'conv-big', [msgLine(big)]);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-big', maxChars: 100 });
      const m = r.payload.messages[0];
      assert.strictEqual(m.truncated, true, 'truncated 未标记');
      assert.strictEqual(m.textLength, 50000, `textLength=${m.textLength}，应为原始长度 50000`);
      assert.ok(m.text.startsWith('X'.repeat(100)), '未按 maxChars 截断');
      assert.ok(m.text.includes('[truncated 49900 chars]'), `截断标记异常: ${m.text.slice(-40)}`);
      return `text 长度=${m.text.length}, originalLength=${m.textLength}`;
    } finally {
      client.close();
    }
  });

  await check('B7-2 【关键】含裸 \\n / \\r\\n / " / \\ 的文本不破坏 JSON-RPC 单行流', async () => {
    const fx = makeFixture('b7-newlines');
    const nasty = [
      'line1\nline2',
      'crlf1\r\ncrlf2',
      'quote " and backslash \\ and combo \\"',
      'unicode 中文 🎯 emoji',
      'tab\there',
      'json-ish {"a":1,"b":[2,3]}',
    ].join(' ');
    writeSession(fx, 'c-fx-nasty', 'conv-nasty', [msgLine(nasty)]);
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      const r = await client.call('wb_read_session', { conversationId: 'conv-nasty', maxChars: 100000 });
      assert.ok(!r.raw.isError);
      // 服务端只应产生 1 行 stdout（一条响应），且无不可解析行。
      const produced = client.lines.length - before;
      assert.strictEqual(produced, 1, `期望 1 行响应，实际 ${produced} 行（换行被写进协议流）`);
      assert.strictEqual(client.unparsableLines.length, 0,
        `出现不可解析的 stdout 行: ${JSON.stringify(client.unparsableLines.slice(0, 2)).slice(0, 300)}`);
      // 文本内容应被 JSON 正确转义后原样还原
      assert.ok(r.payload.messages[0].text.includes('line1\nline2'), '换行未正确转义/还原');
      assert.ok(r.payload.messages[0].text.includes('crlf1\r\ncrlf2'), 'CRLF 未正确转义/还原');
      assert.ok(r.payload.messages[0].text.includes('quote " and backslash \\'), '引号/反斜杠未正确还原');
      return '1 行响应，JSON 转义正确，内容完整还原';
    } finally {
      client.close();
    }
  });

  await check('B7-3 8 条含换行的大消息：响应仍是单行且可解析', async () => {
    const fx = makeFixture('b7-multi');
    const lines = [];
    for (let i = 0; i < 8; i += 1) {
      lines.push(msgLine(`msg${i} 第一行\n第二行\r\n第三行 "quoted" \\slash\\ ${'填充'.repeat(500)}`));
    }
    writeSession(fx, 'c-fx-multi', 'conv-multi', lines);
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      const r = await client.call('wb_read_session', { conversationId: 'conv-multi', maxChars: 100000 });
      assert.strictEqual(client.lines.length - before, 1, '响应被拆成多行');
      assert.strictEqual(client.unparsableLines.length, 0);
      assert.strictEqual(r.payload.totalMessages, 8);
      for (const m of r.payload.messages) {
        assert.ok(m.text.includes('\n'), '换行丢失');
        assert.ok(m.text.includes('\r\n'), 'CRLF 丢失');
      }
      const bytes = Buffer.byteLength(client.rawChunks.join(''), 'utf8');
      return `8 条消息，响应 ${bytes} 字节，仍为单行`;
    } finally {
      client.close();
    }
  });

  await check('B7-4 单条超大消息（~800KB）截断后仍为合法单行 JSON', async () => {
    const fx = makeFixture('b7-huge');
    const huge = 'A'.repeat(400000) + '\n换行\n' + 'B'.repeat(400000);
    writeSession(fx, 'c-fx-huge', 'conv-huge', [msgLine(huge)]);
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      const r = await client.call('wb_read_session', { conversationId: 'conv-huge', maxChars: 1000 }, 60000);
      assert.strictEqual(client.lines.length - before, 1, '超大响应被拆成多行');
      assert.strictEqual(client.unparsableLines.length, 0, '超大响应出现不可解析行');
      assert.ok(r.payload.messages[0].truncated, '未截断');
      return `原始 ${huge.length} 字符 -> 响应 ${client.lines[client.lines.length - 1].length} 字节，单行合法`;
    } finally {
      client.close();
    }
  });

  await check('B7-5 maxMessages 取末尾且 truncatedTail 标记正确', async () => {
    const fx = makeFixture('b7-tail');
    const lines = [];
    for (let i = 0; i < 30; i += 1) lines.push(msgLine(`消息编号${i}`));
    writeSession(fx, 'c-fx-tail', 'conv-tail', lines);
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.call('wb_read_session', { conversationId: 'conv-tail', maxMessages: 5 });
      assert.strictEqual(r.payload.truncatedTail, true);
      assert.strictEqual(r.payload.returnedMessages, 5);
      assert.strictEqual(r.payload.totalMessages, 30);
      assert.ok(r.payload.messages[4].text.includes('消息编号29'), '未取到末尾消息');
      return `返回末尾 ${r.payload.returnedMessages}/30`;
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * C. MCP 协议合规性
 * ------------------------------------------------------------------ */

async function groupC() {
  group('C. MCP 协议合规性');

  const fx = makeFixture('c-proto');

  await check('C8-1 stdout 全程只有 JSON-RPC 消息（日志走 stderr）', async () => {
    const client = new RawClient({ env: { ...fx.env, WB_BRIDGE_LOG: '1' } });
    try {
      await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qa', version: '1' } });
      await client.request('tools/list', {});
      await client.call('wb_list_sessions', { limit: 2, includeCounts: false });
      await client.call('wb_send_instruction', { instruction: TEST_MARK });
      assert.strictEqual(client.unparsableLines.length, 0,
        `stdout 混入非协议输出: ${JSON.stringify(client.unparsableLines.slice(0, 3)).slice(0, 400)}`);
      for (const line of client.lines) {
        const msg = JSON.parse(line);
        assert.strictEqual(msg.jsonrpc, '2.0', `非法 jsonrpc 字段: ${line.slice(0, 120)}`);
      }
      assert.ok(client.stderr.includes('[workbuddy-session-bridge]'), '启用日志时 stderr 无输出');
      return `${client.lines.length} 行全部合法 JSON-RPC，stderr 有日志`;
    } finally {
      client.close();
    }
  });

  await check('C9-1 非法 JSON 行 -> -32700 且服务存活', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      client.writeRaw('{ this is not valid json');
      await RawClient.wait(600);
      assert.strictEqual(client.lines.length - before, 1, `期望 1 行错误响应，实际 ${client.lines.length - before} 行`);
      const msg = JSON.parse(client.lines[client.lines.length - 1]);
      assert.ok(msg.error, '响应无 error 字段');
      assert.strictEqual(msg.error.code, JSONRPC_ERRORS.PARSE_ERROR, `code=${msg.error.code}，应为 -32700`);
      assert.strictEqual(msg.id, null, `无 id 请求应回 id=null，实际 ${JSON.stringify(msg.id)}`);
      const pong = await client.request('ping', {});
      assert.deepStrictEqual(pong.result, {}, '服务未存活');
      return 'code=-32700, id=null，服务存活';
    } finally {
      client.close();
    }
  });

  await check('C9-2 空行 / 纯空白输入被忽略且不产生响应', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      client.writeRaw('');
      client.writeRaw('   ');
      client.writeRaw('\t');
      await RawClient.wait(600);
      assert.strictEqual(client.lines.length - before, 0, '空输入产生了响应');
      const pong = await client.request('ping', {});
      assert.deepStrictEqual(pong.result, {});
      return '空输入静默忽略，服务正常';
    } finally {
      client.close();
    }
  });

  await check('C9-3 批量请求 -> -32600', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      client.writeRaw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
      await RawClient.wait(600);
      assert.strictEqual(client.lines.length - before, 1, '批量请求未返回单条错误');
      const msg = JSON.parse(client.lines[client.lines.length - 1]);
      assert.strictEqual(msg.error.code, JSONRPC_ERRORS.INVALID_REQUEST, `code=${msg.error.code}`);
      const pong = await client.request('ping', {});
      assert.ok(pong.result);
      return 'code=-32600，服务存活';
    } finally {
      client.close();
    }
  });

  await check('C9-4 缺 method -> -32600；缺 params 的 ping 仍可用', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r1 = await client.request('__missing__method__', {});
      assert.strictEqual(r1.error.code, JSONRPC_ERRORS.METHOD_NOT_FOUND, `code=${r1.error.code}`);
      const before = client.lines.length;
      client.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 777001 }));
      await RawClient.wait(500);
      const msg = JSON.parse(client.lines[client.lines.length - 1]);
      assert.strictEqual(msg.error.code, JSONRPC_ERRORS.INVALID_REQUEST, `缺 method code=${msg.error.code}`);
      assert.strictEqual(client.lines.length - before, 1);
      const pong = await client.request('ping');
      assert.deepStrictEqual(pong.result, {}, '缺 params 的 ping 失败');
      return '-32601 / -32600 / 无参 ping 均正确';
    } finally {
      client.close();
    }
  });

  await check('C9-5 通知（无 id）不产生响应', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const before = client.lines.length;
      client.writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      client.writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'no/such/method' }));
      await client.request('ping', {});
      await RawClient.wait(300);
      const after = client.lines.length;
      // 只有 ping 的 1 条响应
      assert.strictEqual(after - before, 1, `通知产生了额外输出（${after - before} 行）`);
      return '2 个通知 + 1 个 ping -> 仅 1 行响应';
    } finally {
      client.close();
    }
  });

  await check('C9-6 tools/call 缺 name -> -32602', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.request('tools/call', { arguments: {} });
      assert.ok(r.error, '缺 name 未返回错误');
      assert.strictEqual(r.error.code, JSONRPC_ERRORS.INVALID_PARAMS, `code=${r.error.code}`);
      return 'code=-32602';
    } finally {
      client.close();
    }
  });

  await check('C9-7 tools/call 未知工具名 -> -32602 协议级错误（含 UNKNOWN_TOOL）', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.request('tools/call', { name: 'wb_definitely_not_a_tool', arguments: {} });
      // F07 整改：未知工具属于协议层错误，映射为 -32602（不再是 result.isError）。
      assert.ok(r.error, `未知工具未返回 JSON-RPC error: ${JSON.stringify(r).slice(0, 200)}`);
      assert.strictEqual(r.error.code, JSONRPC_ERRORS.INVALID_PARAMS, `code=${r.error.code}，应为 -32602`);
      assert.ok(String(r.error.message).includes('UNKNOWN_TOOL'), `message 未含 UNKNOWN_TOOL: ${r.error.message}`);
      return 'code=-32602 + UNKNOWN_TOOL';
    } finally {
      client.close();
    }
  });

  await check('C9-8 参数类型错误（该传数字传字符串等）-> -32602 协议级错误且不崩溃', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const cases = [
        ['wb_list_sessions', { limit: 'abc' }],
        ['wb_read_session', { conversationId: 'x', maxMessages: '10' }],
        ['wb_read_session', { conversationId: 'x', maxChars: 'abc' }],
        ['wb_pending_instructions', { limit: 'five' }],
        ['wb_read_session', { conversationId: 123 }],
        ['wb_send_instruction', { instruction: 'x', priority: 'urgent' }],
        ['wb_send_instruction', { instruction: 'x', priority: 1 }],
        ['wb_complete_instruction', { instructionId: 'x', status: 'weird' }],
        ['wb_search_sessions', { keyword: '' }],
        ['wb_search_sessions', {}],
        ['wb_pending_instructions', { markPicked: 'false' }],
        ['wb_pending_instructions', { limit: 0.5 }],
        ['wb_send_instruction', { instruction: 'x', metadata: [1, 2] }],
        ['wb_list_sessions', { bogusKey: 1 }],
      ];
      for (const [name, args] of cases) {
        const r = await client.request('tools/call', { name, arguments: args });
        // F06/F07 整改：Schema/类型错误在协议层返回 -32602。
        assert.ok(r.error, `${name} ${JSON.stringify(args)} 未返回 JSON-RPC error: ${JSON.stringify(r).slice(0, 200)}`);
        assert.strictEqual(r.error.code, JSONRPC_ERRORS.INVALID_PARAMS,
          `${name} ${JSON.stringify(args)} code=${r.error.code}，应为 -32602`);
        assert.ok(String(r.error.message).length > 0, `${name} 错误 message 为空`);
      }
      assert.strictEqual(client.exited, false, '服务因类型错误退出');
      const pong = await client.request('ping', {});
      assert.ok(pong.result);
      return `${cases.length} 种类型/结构错误全部按 -32602 返回，服务存活`;
    } finally {
      client.close();
    }
  });

  await check('C9-9 连续 20 次畸形输入后服务仍健康（无内存/句柄崩溃）', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const junk = [
        '{', '}', '[]', 'null', 'true', '123', '"str"', '{}',
        '{"jsonrpc":"1.0","id":1,"method":"ping"}',
        '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
        '{"jsonrpc":"2.0","id":1,"method":123}',
        '{"jsonrpc":"2.0","id":1}',
        JSON.stringify([1, 2, 3]),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 123 } }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_read_session', arguments: 'not-an-object' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: 'string-params' }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_search_sessions', arguments: { keyword: { nested: true } } } }),
      ];
      for (let i = 0; i < 20; i += 1) client.writeRaw(junk[i % junk.length]);
      await RawClient.wait(1200);
      assert.strictEqual(client.exited, false, `服务退出: ${JSON.stringify(client.exitInfo)}`);
      const pong = await client.request('ping', {});
      assert.deepStrictEqual(pong.result, {}, '服务不健康');
      assert.strictEqual(client.unparsableLines.length, 0,
        `响应流被污染: ${JSON.stringify(client.unparsableLines.slice(0, 2)).slice(0, 200)}`);
      return '20 次畸形输入后 ping 正常';
    } finally {
      client.close();
    }
  });

  await check('C9-10 字符串 id 与超长 id 均能正确关联响应', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const p1 = client.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 'string-id-abc', method: 'ping' }));
      void p1;
      await RawClient.wait(400);
      const line = client.lines[client.lines.length - 1];
      const msg = JSON.parse(line);
      assert.strictEqual(msg.id, 'string-id-abc', `id 关联错误: ${line.slice(0, 120)}`);
      const longId = 'x'.repeat(500);
      client.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: longId, method: 'ping' }));
      await RawClient.wait(400);
      const msg2 = JSON.parse(client.lines[client.lines.length - 1]);
      assert.strictEqual(msg2.id, longId);
      return '字符串 id / 500 字符 id 均正确回显';
    } finally {
      client.close();
    }
  });

  await check('C10-1 initialize 响应三段齐全且符合 MCP 规范', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qa-verify', version: '1.0.0' },
      });
      assert.ok(r.result, '无 result');
      assert.strictEqual(r.result.protocolVersion, PROTOCOL_VERSION,
        `protocolVersion=${r.result.protocolVersion}，客户端请求 ${PROTOCOL_VERSION} 却回了别的`);
      assert.ok(r.result.capabilities && typeof r.result.capabilities === 'object', '缺 capabilities');
      assert.ok(r.result.capabilities.tools && r.result.capabilities.tools.listChanged === false,
        `capabilities.tools 不合规: ${JSON.stringify(r.result.capabilities)}`);
      assert.ok(r.result.serverInfo && typeof r.result.serverInfo.name === 'string' && typeof r.result.serverInfo.version === 'string',
        'serverInfo 不合规');
      assert.strictEqual(r.result.serverInfo.name, 'workbuddy-session-bridge');
      assert.ok(typeof r.result.instructions === 'string' && r.result.instructions.length > 10, '缺 instructions');
      return `protocolVersion=${r.result.protocolVersion}, serverInfo=${r.result.serverInfo.name}@${r.result.serverInfo.version}`;
    } finally {
      client.close();
    }
  });

  await check('C10-2 initialize 对未知 protocolVersion 返回服务端支持版本（不原样回显）', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
      assert.ok(r.result, '无 result');
      // F07 整改：MCP 版本协商——不支持的版本必须回退到服务端支持版本，绝不回显。
      assert.strictEqual(r.result.protocolVersion, PROTOCOL_VERSION,
        `未知版本被回显为 ${r.result.protocolVersion}，应回退到 ${PROTOCOL_VERSION}`);
      const ok = await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
      assert.strictEqual(ok.result.protocolVersion, PROTOCOL_VERSION, '支持版本未被采用');
      return `未知版本 1999-01-01 -> 回退 ${r.result.protocolVersion}；支持版本原样采用`;
    } finally {
      client.close();
    }
  });

  await check('C10-3b 【F07】JSON-RPC 信封校验矩阵 + 原型链方法名不被分发', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      // 冷启动预热：子进程首次 require/建表可能 >120ms，先以带 id 的请求同步等待服务就绪，
      // 否则「首个矩阵项」会在固定 sleep 内拿不到响应而误判（曾导致「缺 jsonrpc 期望 1 行实际 0」）。
      await client.request('ping', {}, 10000);
      const matrix = [
        // [原始行, 期望错误码, 期望 id, 说明]
        [JSON.stringify({ method: 'ping', id: 1 }), JSONRPC_ERRORS.INVALID_REQUEST, 1, '缺 jsonrpc'],
        [JSON.stringify({ jsonrpc: '1.0', method: 'ping', id: 2 }), JSONRPC_ERRORS.INVALID_REQUEST, 2, 'jsonrpc 错误'],
        [JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: { a: 1 } }), JSONRPC_ERRORS.INVALID_REQUEST, null, '对象 id'],
        [JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 3, params: 42 }), JSONRPC_ERRORS.INVALID_REQUEST, 3, '标量 params'],
        [JSON.stringify({ jsonrpc: '2.0', id: 4 }), JSONRPC_ERRORS.INVALID_REQUEST, 4, '缺 method'],
        [JSON.stringify({ jsonrpc: '2.0', method: 'toString', id: 5 }), JSONRPC_ERRORS.METHOD_NOT_FOUND, 5, 'toString 原型名'],
        [JSON.stringify({ jsonrpc: '2.0', method: 'constructor', id: 6 }), JSONRPC_ERRORS.METHOD_NOT_FOUND, 6, 'constructor 原型名'],
        [JSON.stringify({ jsonrpc: '2.0', method: '__proto__', id: 7 }), JSONRPC_ERRORS.METHOD_NOT_FOUND, 7, '__proto__ 原型名'],
        // 非法无 id 请求也必须回错误（id=null）
        [JSON.stringify({ method: 'ping' }), JSONRPC_ERRORS.INVALID_REQUEST, null, '缺 jsonrpc 且无 id'],
        [JSON.stringify(3), JSONRPC_ERRORS.INVALID_REQUEST, null, '标量请求'],
        [JSON.stringify(null), JSONRPC_ERRORS.INVALID_REQUEST, null, 'null 请求'],
      ];
      for (const [raw, expectCode, expectId, label] of matrix) {
        const before = client.lines.length;
        client.writeRaw(raw);
        // 轮询等待响应（最多 4s），避免固定 sleep 在慢机上误判。
        const deadline = Date.now() + 4000;
        while (client.lines.length - before < 1 && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await RawClient.wait(20);
        }
        const produced = client.lines.length - before;
        assert.strictEqual(produced, 1, `${label}: 期望 1 行响应，实际 ${produced}`);
        const msg = JSON.parse(client.lines[client.lines.length - 1]);
        assert.ok(msg.error, `${label}: 未返回 error`);
        assert.strictEqual(msg.error.code, expectCode, `${label}: code=${msg.error.code}，期望 ${expectCode}`);
        assert.strictEqual(msg.id, expectId, `${label}: id=${JSON.stringify(msg.id)}，期望 ${JSON.stringify(expectId)}`);
      }
      const pong = await client.request('ping', {});
      assert.deepStrictEqual(pong.result, {}, '信封矩阵后服务未存活');
      return `${matrix.length} 种信封/原型名输入全部按预期返回且服务存活`;
    } finally {
      client.close();
    }
  });

  await check('C10-3 tools/list 返回 8 个工具且 schema 结构完整', async () => {
    const client = new RawClient({ env: fx.env });
    try {
      const r = await client.request('tools/list', {});
      const tools = r.result.tools;
      assert.strictEqual(tools.length, 8, `工具数=${tools.length}`);
      for (const t of tools) {
        assert.strictEqual(typeof t.name, 'string');
        assert.ok(t.description && t.description.length > 10, `${t.name} 描述过短`);
        assert.strictEqual(t.inputSchema.type, 'object', `${t.name} schema.type 非 object`);
        // properties 是 JSON Schema 的对象（可为空对象），不是数组
        assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object'
          && !Array.isArray(t.inputSchema.properties), `${t.name} properties 必须是对象`);
        assert.strictEqual(t.inputSchema.additionalProperties, false, `${t.name} 未声明 additionalProperties=false`);
      }
      const names = tools.map((t) => t.name).sort();
      const expected = ['wb_bridge_info', 'wb_complete_instruction', 'wb_instruction_stats', 'wb_list_sessions',
        'wb_pending_instructions', 'wb_read_session', 'wb_search_sessions', 'wb_send_instruction'];
      assert.deepStrictEqual(names, expected, `工具名不符: ${names.join(',')}`);
      return '8 个工具 schema 完整';
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * D. 并发与原子性
 * ------------------------------------------------------------------ */

/**
 * 生成一个「拉起 bridge 子进程并跑 body」的 worker 脚本。
 *
 * 刻意用函数拼装而非嵌套模板字面量：worker 内部需要 ${} 插值，
 * 若与外层模板混用会因作用域遮蔽产生难查的 ReferenceError。
 *
 * @param {string} store store 路径。
 * @param {string} body worker 内部要执行的代码，可使用 call() 与 report()。
 * @return {string} 完整脚本。
 */
function bridgeWorkerScript(store, body) {
  return [
    "const { spawn } = require('child_process');",
    `const child = spawn(${JSON.stringify(NODE_BIN)}, [${JSON.stringify(SERVER)}], {`,
    "  stdio: ['pipe','pipe','pipe'],",
    `  env: { ...process.env, TASK: '1', WB_BRIDGE_STORE: ${JSON.stringify(store)}, WB_BRIDGE_LOG: '0' },`,
    '});',
    "let buf = ''; const pend = new Map(); let id = 1;",
    "child.stdout.setEncoding('utf8');",
    "child.stdout.on('data', (c) => { buf += c; let i = buf.indexOf('\\n');",
    '  while (i !== -1) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    "    if (line.trim()) { try { const m = JSON.parse(line); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } catch (_e) {} }",
    "    i = buf.indexOf('\\n');",
    '  } });',
    'const call = (name, args) => new Promise((res) => { const rid = id++; pend.set(rid, res);',
    "  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\\n'); });",
    'const out = {};',
    'const report = (k, v) => { out[k] = v; };',
    '(async () => {',
    '  try {',
    body,
    '  } catch (e) { out.fatal = String(e && e.stack || e); }',
    '  child.stdin.end();',
    '  process.stdout.write(JSON.stringify(out));',
    '  process.exit(0);',
    '})();',
  ].join('\n');
}

/**
 * 运行一个 worker 脚本并解析其 JSON 输出。
 *
 * @param {string} script 脚本。
 * @return {Promise<Object>} 输出。
 */
function runWorker(script) {
  return new Promise((resolve) => {
    const proc = spawn(NODE_BIN, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('exit', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (_e) { resolve({ fatal: out.slice(0, 300) }); }
    });
  });
}

/**
 * 统计错误码分布。
 *
 * @param {string[]} codes 错误码数组。
 * @return {Object<string, number>} 分布。
 */
function countCodes(codes) {
  return codes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});
}

async function groupD() {
  group('D. 并发与原子性');

  await check('D11-1 6 进程 x 8 条并发入队：无丢失、无重复、无残留', async () => {
    const sb = sandbox('d11-concurrent');
    const PROCS = 6;
    const PER = 8;
    const reports = await Promise.all(
      Array.from({ length: PROCS }, (_v, p) => runWorker(bridgeWorkerScript(sb.store, [
        'let ok = 0; const errs = [];',
        `for (let k = 0; k < ${PER}; k++) {`,
        `  const r = await call('wb_send_instruction', { instruction: ${JSON.stringify(`p${p}-i`)} + k + '-' + ${JSON.stringify(TEST_MARK)} });`,
        '  if (r.error) { errs.push(r.error.code); }',
        '  else if (r.result && !r.result.isError) ok++;',
        '  else { const pj = JSON.parse(r.result.content[0].text); errs.push(pj.error && pj.error.code); }',
        '}',
        "report('ok', ok); report('errs', errs);",
      ].join('\n')))),
    );
    for (const r of reports) {
      assert.ok(!r.fatal, `worker 异常退出: ${r.fatal}`);
    }
    const totalOk = reports.reduce((s, r) => s + (r.ok || 0), 0);
    const allErrs = reports.flatMap((r) => r.errs || []);

    const md = readMaildir(sb.store);
    const list = md.records;
    // 成功入队的必须全部落盘（不多不少）——这是「无静默丢数据」的核心判据。
    assert.strictEqual(list.length, totalOk,
      `落盘 ${list.length} 条 != 成功入队 ${totalOk} 条（成功却丢数据）；错误码=${JSON.stringify(countCodes(allErrs))}`);
    assert.strictEqual(totalOk, PROCS * PER,
      `入队成功 ${totalOk}/${PROCS * PER}；错误码分布=${JSON.stringify(countCodes(allErrs))}`);
    const ids = new Set(list.map((i) => i.id));
    assert.strictEqual(ids.size, list.length, `存在重复 id：${list.length - ids.size} 个`);
    for (let p = 0; p < PROCS; p += 1) {
      for (let k = 0; k < PER; k += 1) {
        assert.ok(list.some((i) => i.instruction === `p${p}-i${k}-${TEST_MARK}`), `丢失指令 p${p}-i${k}`);
      }
    }
    assert.strictEqual(md.leftovers.length, 0, `残留 tmp 文件: ${md.leftovers.join(',')}`);
    return `${PROCS}x${PER}=${totalOk} 条全部入队，id 唯一，无残留`;
  });

  await check('D11-2 8 进程并发混合读写：状态机自洽、无重复、无非法状态', async () => {
    const sb = sandbox('d11-mixed');
    const reports = await Promise.all(
      Array.from({ length: 8 }, (_v, w) => runWorker(bridgeWorkerScript(sb.store, [
        'const errs = []; const sent = [];',
        'for (let k = 0; k < 5; k++) {',
        `  const r = await call('wb_send_instruction', { instruction: 'w${w}-' + k + '-' + ${JSON.stringify(TEST_MARK)} });`,
        '  const pj = JSON.parse(r.result.content[0].text);',
        '  if (r.result.isError) errs.push(pj.error && pj.error.code);',
        '  else sent.push(pj.instructionId);',
        '}',
        "const pr = await call('wb_pending_instructions', { limit: 3 });",
        "const pp = JSON.parse(pr.result.content[0].text);",
        "if (pr.result.isError) errs.push(pp.error && pp.error.code);",
        "await call('wb_instruction_stats', {});",
        'let completed = 0;',
        'if (sent[0]) {',
        "  const cr = await call('wb_complete_instruction', { instructionId: sent[0], result: { ok: true } });",
        '  if (cr.result.isError) { const cj = JSON.parse(cr.result.content[0].text); errs.push(cj.error && cj.error.code); }',
        '  else completed = 1;',
        '}',
        "report('sent', sent.length); report('pulled', pp.count); report('completed', completed); report('errs', errs);",
      ].join('\n')))),
    );
    for (const r of reports) {
      assert.ok(!r.fatal, `worker 异常退出: ${r.fatal}`);
    }
    const totalSent = reports.reduce((s, r) => s + (r.sent || 0), 0);
    const totalCompleted = reports.reduce((s, r) => s + (r.completed || 0), 0);
    const allErrs = reports.flatMap((r) => r.errs || []);

    const md = readMaildir(sb.store);
    // 判据 1：成功入队数 == 落盘数（无静默丢数据）
    assert.strictEqual(md.records.length, totalSent,
      `落盘 ${md.records.length} != 成功入队 ${totalSent}；错误码=${JSON.stringify(countCodes(allErrs))}`);
    // 判据 2：id 唯一
    const ids = new Set(md.records.map((i) => i.id));
    assert.strictEqual(ids.size, md.records.length, `存在重复 id：${md.records.length - ids.size} 个`);
    // 判据 3：状态机合法（状态由所在目录权威决定）
    for (const item of md.records) {
      assert.ok(['pending', 'picked', 'done', 'failed'].includes(item.status),
        `非法状态 ${item.status}（id=${item.id}）`);
      if (item.status === 'done' || item.status === 'failed') {
        assert.ok(item.completedAt, `终态指令缺 completedAt（id=${item.id}）`);
      }
      if (item.status === 'picked') {
        assert.ok(item.pickedAt, `picked 指令缺 pickedAt（id=${item.id}）`);
      }
    }
    // 判据 4：成功回填数 == done 目录中的记录数
    const done = md.byStatus.done;
    assert.strictEqual(totalCompleted, done.length,
      `成功回填 ${totalCompleted} 条，store 中 done=${done.length} 条`);
    assert.strictEqual(md.leftovers.length, 0, `残留 tmp 文件: ${md.leftovers.join(',')}`);
    const warn = allErrs.length ? `；期间有 ${allErrs.length} 次可恢复失败 ${JSON.stringify(countCodes(allErrs))}` : '';
    return `入队 ${totalSent} 条全部落盘，done=${done.length}，状态机自洽${warn}`;
  });

  await check('D11-3 8 进程竞争下写失败出现率（记录性指标，零静默丢失为硬判据）', async () => {
    const sb = sandbox('d11-contended');
    const N = 8;
    const reports = await Promise.all(
      Array.from({ length: N }, (_v, w) => runWorker(bridgeWorkerScript(sb.store, [
        'const errs = []; let ok = 0;',
        'for (let k = 0; k < 6; k++) {',
        `  const r = await call('wb_send_instruction', { instruction: 'lr${w}-' + k + '-' + ${JSON.stringify(TEST_MARK)} });`,
        '  if (r.error) errs.push(r.error.code);',
        '  else if (r.result.isError) errs.push(JSON.parse(r.result.content[0].text).error.code);',
        '  else ok++;',
        '}',
        "report('ok', ok); report('errs', errs);",
      ].join('\n')))),
    );
    const allErrs = reports.flatMap((r) => r.errs || []);
    const totalOk = reports.reduce((s, r) => s + (r.ok || 0), 0);
    const dist = countCodes(allErrs);
    const md = readMaildir(sb.store);
    // 硬判据：成功入队数 == 落盘数（maildir 每记录独立文件，写入即持久，不存在锁丢失路径）。
    assert.strictEqual(md.records.length, totalOk,
      `落盘 ${md.records.length} != 成功 ${totalOk}：存在静默丢数据`);
    return `${N * 6} 次入队，成功 ${totalOk}，失败分布=${JSON.stringify(dist)}（maildir 每记录原子写入，无需锁；rename 退避最坏 ${storeMod.totalBackoffBudget(storeMod.RENAME_RETRY)}ms）`;
  });

  await check('D12-1 并发领取唯一性：多进程同时领取同一批指令，无重复领取', async () => {
    const sb = sandbox('d12-claim');
    // 预置 20 条 pending（单进程投递）
    const seeder = new RawClient({ env: sb.env });
    const seededIds = new Set();
    try {
      for (let i = 0; i < 20; i += 1) {
        const s = await seeder.call('wb_send_instruction', { instruction: `claim-${TEST_MARK}-${i}` });
        seededIds.add(s.payload.instructionId);
      }
    } finally {
      seeder.close();
    }
    // 4 个进程并发领取（每个循环领取直到自己拿到 10 条或队列被抢空），合计恰好 20 且无重复——
    // 验证原子 link 领取的唯一性：正确互斥下，一次 takePending 只领取「我方抢到的」子集，
    // 竞争失败者不会重复领取同一条；因此消费者需循环拉取，最终不重不漏。
    //
    // 【为什么「空轮」不能直接 break（并发互踩修复要点）】takePending(limit=10) 只扫描队列的
    // 「前 limit 条」候选。当 1 号进程一次抢走前 10 条后，其余进程本轮扫描到的仍是同一批「前 10 条」，
    // 因已被抢走而全部落空 → 本轮返回空数组。此时队列里其实还压着后 10 条（pending 计数 > 0）。
    // 若把「空数组」等同于「队列已空」而 break，后 10 条将永远无人领取（合计只领到 10）。
    // 正确语义：空轮后必须回读 pending 计数——确为 0 才是真抢空（可安全退出）；否则重扫下一批。
    const reports = await Promise.all(Array.from({ length: 4 }, () => runWorker(bridgeWorkerScript(sb.store, [
      'const seen = []; const dup = [];',
      'for (let round = 0; round < 40 && seen.length < 10; round++) {',
      "  const r = await call('wb_pending_instructions', { limit: 10, markPicked: true });",
      "  const p = JSON.parse(r.result.content[0].text);",
      "  const got = (p.instructions || []).map((x) => x.id);",
      '  if (got.length === 0) {',
      "    const st = await call('wb_instruction_stats', {});",
      "    if (JSON.parse(st.result.content[0].text).counts.pending === 0) break;",
      '    continue;',
      '  }',
      '  for (const id of got) { if (seen.includes(id)) dup.push(id); seen.push(id); }',
      '}',
      "report('claimed', seen); report('dupWithinWorker', dup);",
    ].join('\n')))));
    const claimed = reports.flatMap((r) => r.claimed || []);
    const dupWithin = reports.flatMap((r) => r.dupWithinWorker || []);
    const uniq = new Set(claimed);
    assert.strictEqual(dupWithin.length, 0, `同一 worker 内重复领取（自相矛盾）：${dupWithin.join(',')}`);
    assert.strictEqual(uniq.size, claimed.length, `跨进程重复领取：${claimed.length} 次领取中 ${claimed.length - uniq.size} 个重复`);
    assert.strictEqual(uniq.size, 20, `合计领取 ${uniq.size}，期望 20（不重不漏）`);
    for (const id of claimed) assert.ok(seededIds.has(id), `领取到未知 id: ${id}`);
    const md = readMaildir(sb.store);
    assert.strictEqual(md.byStatus.picked.length, 20, `picked 目录应有 20 条，实际 ${md.byStatus.picked.length}`);
    assert.strictEqual(md.byStatus.pending.length, 0, 'pending 目录应清空');
    assert.strictEqual(md.records.length, 20, `落盘总数应为 20，实际 ${md.records.length}（不应出现跨状态重复）`);
    assert.strictEqual(md.leftovers.length, 0, `残留 tmp 文件: ${md.leftovers.join(',')}`);
    return `4 进程并发领取 20 条：${claimed.length} 次领取零重复，picked=20`;
  });

  await check('D12-2 只读操作（stats / markPicked=false 预览）零写入：目录快照前后一致', async () => {
    const sb = sandbox('d12-readonly');
    const client = new RawClient({ env: sb.env });
    const snap = (root) => {
      const out = {};
      for (const status of ['pending', 'picked', 'done', 'failed', 'tmp']) {
        const dir = path.join(root, status);
        let names = [];
        try { names = fs.readdirSync(dir).sort(); } catch (_e) { names = []; }
        out[status] = names.map((n) => {
          const body = fs.readFileSync(path.join(dir, n));
          return `${n}:${crypto.createHash('sha256').update(body).digest('hex')}`;
        });
      }
      return out;
    };
    try {
      await client.call('wb_send_instruction', { instruction: `ro-${TEST_MARK}` });
      const before = snap(sb.store);
      await client.call('wb_instruction_stats');
      await client.call('wb_pending_instructions', { limit: 5, markPicked: false });
      await client.call('wb_instruction_stats');
      const after = snap(sb.store);
      assert.deepStrictEqual(after, before, '只读操作改写了队列（违反 F05 只读边界）');
      assert.strictEqual(before.pending.length, 1, 'pending 应仍为 1 条');
      return 'stats/preview 前后队列字节完全一致，零写入';
    } finally {
      client.close();
    }
  });

  await check('D12-3 【F05】损坏记录不被移动/删除，被显式计数而非当作空队列', async () => {
    const sb = sandbox('d12-corrupt');
    fs.mkdirSync(path.join(sb.store, 'pending'), { recursive: true });
    const corruptPath = path.join(sb.store, 'pending', 'corrupt-1.json');
    fs.writeFileSync(corruptPath, '{ broken json', 'utf8');
    const origHash = crypto.createHash('sha256').update(fs.readFileSync(corruptPath)).digest('hex');
    const client = new RawClient({ env: sb.env });
    try {
      const r = await client.call('wb_instruction_stats');
      assert.strictEqual(r.payload.corruptDetected, true, '未检测到损坏');
      assert.ok(r.payload.corrupt >= 1, `corrupt=${r.payload.corrupt}`);
      assert.ok(fs.existsSync(corruptPath), '损坏记录被移动/删除了（违反只读边界）');
      const nowHash = crypto.createHash('sha256').update(fs.readFileSync(corruptPath)).digest('hex');
      assert.strictEqual(nowHash, origHash, '损坏记录被改写');
      const files = fs.readdirSync(path.join(sb.store, 'pending'));
      assert.ok(!files.some((f) => f.includes('.corrupt-')), '出现了隐式 .corrupt 备份（不应发生）');
      assert.strictEqual(r.payload.corruptFiles[0].file, 'corrupt-1.json', '损坏文件未被上报');
      return `损坏记录保持原位、被计数 corrupt=${r.payload.corrupt}`;
    } finally {
      client.close();
    }
  });

  await check('D12-4 原子写有效性：并发读者遍历 pending 目录永不看到半截 JSON', async () => {
    const sb = sandbox('d12-atomic');
    const readerScript = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(path.join(sb.store, 'pending'))};`,
      'let bad = 0, reads = 0;',
      'const t0 = Date.now();',
      'while (Date.now() - t0 < 3000) {',
      '  let names = []; try { names = fs.readdirSync(dir); } catch (e) { continue; }',
      '  for (const n of names) {',
      '    if (!n.endsWith(".json")) continue;',
      '    reads++;',
      '    try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); if (typeof j.id !== "string") bad++; } catch (e) { bad++; }',
      '  }',
      '}',
      'process.stdout.write(JSON.stringify({ reads, bad }));',
      'process.exit(0);',
    ].join('\n');
    const writerScript = bridgeWorkerScript(sb.store, [
      'let ok = 0; const errs = [];',
      'for (let k = 0; k < 60; k++) {',
      `  const r = await call('wb_send_instruction', { instruction: 'atomic-${TEST_MARK}-' + k });`,
      '  if (r.error) errs.push(r.error.code); else if (r.result.isError) errs.push(JSON.parse(r.result.content[0].text).error.code); else ok++;',
      '}',
      "report('ok', ok); report('errs', errs);",
    ].join('\n'));

    const [report, wreport] = await Promise.all([runWorker(readerScript), runWorker(writerScript)]);
    assert.ok(report.reads > 100, `并发读取次数过少（${report.reads}），测试无效`);
    assert.strictEqual(report.bad, 0, `读到 ${report.bad} 次损坏/半截 JSON（共 ${report.reads} 次读取）`);
    const md = readMaildir(sb.store);
    assert.strictEqual(md.records.length, wreport.ok,
      `落盘 ${md.records.length} != 成功入队 ${wreport.ok}；失败码=${JSON.stringify(countCodes(wreport.errs || []))}`);
    return `${report.reads} 次并发逐文件读取 0 次半截 JSON；成功入队 ${wreport.ok}/60 全部落盘`;
  });
  await check('D12-5 并发读存在时原子写入零丢失（rename 退避）', async () => {
    const sb = sandbox('d12-rename');
    const readerScript = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(path.join(sb.store, 'pending'))};`,
      'let reads = 0;',
      'const t0 = Date.now();',
      'while (Date.now() - t0 < 4000) {',
      '  let names = []; try { names = fs.readdirSync(dir); } catch (e) { names = []; }',
      '  for (const n of names) { reads++; try { fs.readFileSync(path.join(dir, n), "utf8"); } catch (e) { /* ignore */ } }',
      '}',
      'process.stdout.write(JSON.stringify({ reads }));',
      'process.exit(0);',
    ].join('\n');
    const writerScript = bridgeWorkerScript(sb.store, [
      'let ok = 0; const errs = [];',
      'for (let k = 0; k < 60; k++) {',
      `  const r = await call('wb_send_instruction', { instruction: 'rename-${TEST_MARK}-' + k });`,
      '  if (r.error) errs.push(r.error.code); else if (r.result.isError) { const pj = JSON.parse(r.result.content[0].text); errs.push((pj.error && pj.error.code) + " | " + String(pj.error && pj.error.message).slice(0, 80)); } else ok++;',
      '}',
      "report('ok', ok); report('errs', errs);",
    ].join('\n'));

    const [report, wreport] = await Promise.all([runWorker(readerScript), runWorker(writerScript)]);
    const md = readMaildir(sb.store);
    const renameErrs = (wreport.errs || []).filter((e) => e.includes('STORE_RENAME_FAILED'));
    assert.strictEqual(md.records.length, wreport.ok,
      `落盘 ${md.records.length} != 成功入队 ${wreport.ok}；错误码 ${JSON.stringify(countCodes(wreport.errs || []))}`);
    assert.strictEqual(wreport.ok, 60, `期望 60 全部成功，实际 ${wreport.ok}；错误码 ${JSON.stringify((wreport.errs || []).slice(0, 5))}`);
    assert.strictEqual(renameErrs.length, 0, `仍有 rename 失败 ${renameErrs.length} 次: ${renameErrs[0]}`);
    assert.ok(report.reads > 50, `并发读取次数过少（${report.reads}），测试无效`);
    return `读侧 ${report.reads} 次并发读取下，60 次入队全部落盘（每记录独立文件 + 原子 rename），零丢失`;
  });

  await check('D12-6 真实双进程：读侧用 bridge 工具轮询 + 写侧投递（零丢失）', async () => {
    const sb = sandbox('d12-realistic');
    const readerScript = bridgeWorkerScript(sb.store, [
      'let polls = 0;',
      'for (let i = 0; i < 100; i++) {',
      "  await call('wb_instruction_stats', {});",
      "  await call('wb_pending_instructions', { limit: 5, markPicked: false });",
      '  polls++;',
      '}',
      "report('polls', polls);",
    ].join('\n'));
    const writerScript = bridgeWorkerScript(sb.store, [
      'let ok = 0; const errs = [];',
      'for (let k = 0; k < 40; k++) {',
      `  const r = await call('wb_send_instruction', { instruction: 'real-${TEST_MARK}-' + k });`,
      '  if (r.error) errs.push(r.error.code); else if (r.result.isError) errs.push(JSON.parse(r.result.content[0].text).error.code); else ok++;',
      '}',
      "report('ok', ok); report('errs', errs);",
    ].join('\n'));

    const [rr, wr] = await Promise.all([runWorker(readerScript), runWorker(writerScript)]);
    const md = readMaildir(sb.store);
    assert.strictEqual(md.records.length, wr.ok,
      `落盘 ${md.records.length} != 成功入队 ${wr.ok}；错误码 ${JSON.stringify(countCodes(wr.errs || []))}`);
    return `读侧轮询 ${rr.polls || 0} 次（纯只读）；写侧 40 次入队成功 ${wr.ok}，落盘 ${md.records.length}，零丢失`;
  });

  await check('D12-7 【F09】退避预算为逐次取整上界且只计真实睡眠次数', () => {
    const R = storeMod.RENAME_RETRY;
    // 逐次最坏上界（与 backoffDelay 的单次 ceil 口径一致）
    let manual = 0;
    for (let a = 0; a < R.attempts - 1; a += 1) {
      const exp = Math.min(R.maxDelayMs, R.baseDelayMs * 2 ** a);
      manual += Math.max(1, Math.ceil(exp * (1 + R.jitterRatio)));
    }
    const reported = storeMod.totalBackoffBudget(R);
    assert.strictEqual(reported, manual, `totalBackoffBudget=${reported}，逐次上界应为 ${manual}`);
    assert.strictEqual(reported, 238, `rename 逐次上界应为 238，实际 ${reported}`);
    // 加载期不变量链（≥3 条不等式）
    const chain = storeMod.assertBudgetInvariant();
    assert.ok(chain.length >= 4, '预算链节点不足');
    for (let i = 1; i < chain.length; i += 1) {
      assert.ok(chain[i - 1].value < chain[i].value,
        `${chain[i - 1].name}(${chain[i - 1].value}) 应 < ${chain[i].name}(${chain[i].value})`);
    }
    return `rename 逐次上界=${reported}ms；预算链 ${chain.map((c) => c.value).join(' < ')}`;
  });
}

/* ------------------------------------------------------------------ *
 * D13. 错误路径收敛（文件操作失败模拟，生产源码零改动）
 *
 * 对应 team-lead 故障模拟确定性复现的 3 个变体（D11-2c）：
 *   - 变体1：rename(tmp→picked) 失败 + 并发完成  → 旧实现残留 pending+done 双份；
 *   - 变体2：removeSourceLink(pending) 失败       → 旧实现残留 pending+done 双份；
 *   - 变体3：link(picked→done) ENOENT（由并发回滚引起）→ 旧实现误报 INSTRUCTION_ALREADY_FINAL。
 * 模拟经 NODE_OPTIONS=--require 预载，仅作用于测试子进程，绝不修改生产源码。
 * ------------------------------------------------------------------ */

async function groupD13() {
  group('D13. 错误路径收敛（文件操作失败模拟，生产源码零改动）');

  const preloadPath = (name) => path.join(__dirname, 'helpers', name);
  const PRE_RENAME = preloadPath('fault-sim-rename-picked.js');
  const PRE_UNLINK = preloadPath('fault-sim-unlink-pending.js');
  const PRE_DELAY = preloadPath('fault-sim-delay-link-done.js');

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 在子进程中直接驱动 InstructionStore.complete（不经 MCP），可带 NODE_OPTIONS 预载模拟。 */
  const runComplete = (storeRoot, id, label, envExtra) => new Promise((resolve) => {
    const code = [
      "const { InstructionStore } = require(process.env.WB_STORE_MOD);",
      "const store = new InstructionStore({ storeRoot: process.env.WB_STORE_ROOT });",
      'let record = null; let threw = null;',
      "try { record = store.complete({ instructionId: process.env.WB_STORE_ID, result: process.env.WB_STORE_LABEL, status: 'done' }); }",
      'catch (e) { threw = (e && e.code) || String(e); }',
      "process.stdout.write(JSON.stringify({ threw, status: record && record.status }));",
    ].join('\n');
    const proc = spawn(NODE_BIN, ['-e', code], {
      env: {
        ...process.env,
        WB_BRIDGE_LOG: '0',
        WB_STORE_MOD: path.join(LIB, 'store.js'),
        WB_STORE_ROOT: storeRoot,
        WB_STORE_ID: id,
        WB_STORE_LABEL: label,
        ...envExtra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('exit', () => {
      try { resolve(JSON.parse(out.trim())); } catch (_e) { resolve({ threw: 'HARNESS', raw: out.slice(0, 200) }); }
    });
  });

  const stateOf = (storeRoot, id) => {
    const out = {};
    for (const dir of ['pending', 'picked', 'done', 'failed']) {
      out[dir] = fs.existsSync(path.join(storeRoot, dir, `${id}.json`));
    }
    return out;
  };
  const copiesOf = (storeRoot, id) => Object.values(stateOf(storeRoot, id)).filter(Boolean).length;

  const waitFor = async (predicate, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleepMs(15); // eslint-disable-line no-await-in-loop
    }
    return false;
  };

  await check('D13-1 模拟 rename(tmp→picked) 失败 + 并发完成：静止状态恰一份（done），无 pending+done 双份', async () => {
    const sb = sandbox('d13-rename-fail');
    const seeder = new storeMod.InstructionStore({ storeRoot: sb.store });
    const { id } = seeder.enqueue({ instruction: 'd13-rename', sessionId: null, priority: 'normal', metadata: null });
    const pickedPath = path.join(sb.store, 'picked', `${id}.json`);
    const a = runComplete(sb.store, id, 'A', {
      NODE_OPTIONS: `--require ${PRE_RENAME}`,
      WB_TEST_RENAME_FAIL_ID: id,
      WB_TEST_RENAME_FAIL_SLEEP_MS: '600',
    });
    const appeared = await waitFor(() => fs.existsSync(pickedPath), 5000);
    assert.ok(appeared, '模拟下 picked 未出现（rename 模拟未命中 link 之后的窗口）');
    const b = runComplete(sb.store, id, 'B', {});
    const [ra, rb] = await Promise.all([a, b]);
    const st = stateOf(sb.store, id);
    const copies = copiesOf(sb.store, id);
    assert.strictEqual(copies, 1, `静止状态副本数=${copies}（应恰 1）: ${JSON.stringify(st)}；A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`);
    assert.strictEqual(st.done, true, `唯一副本应在 done，实际 ${JSON.stringify(st)}`);
    return `模拟 rename 失败：A=${JSON.stringify(ra)} B=${JSON.stringify(rb)} 静止=${JSON.stringify(st)}（唯一 done）`;
  });

  await check('D13-2 模拟 removeSourceLink(pending) 失败：静止状态恰一份，无 pending+done 双份', async () => {
    const sb = sandbox('d13-unlink-fail');
    const seeder = new storeMod.InstructionStore({ storeRoot: sb.store });
    const { id } = seeder.enqueue({ instruction: 'd13-unlink', sessionId: null, priority: 'normal', metadata: null });
    const pickedPath = path.join(sb.store, 'picked', `${id}.json`);
    const a = runComplete(sb.store, id, 'A', { NODE_OPTIONS: `--require ${PRE_UNLINK}`, WB_TEST_UNLINK_ID: id });
    const appeared = await waitFor(() => fs.existsSync(pickedPath), 5000);
    assert.ok(appeared, '模拟下 picked 未出现');
    await sleepMs(500); // 等 A 的「删除源」退避重试耗尽并完成收敛
    const b = runComplete(sb.store, id, 'B', {});
    const [ra, rb] = await Promise.all([a, b]);
    const st = stateOf(sb.store, id);
    const copies = copiesOf(sb.store, id);
    assert.strictEqual(copies, 1, `静止状态副本数=${copies}（应恰 1）: ${JSON.stringify(st)}；A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`);
    assert.strictEqual(st.done, true, `唯一副本应在 done，实际 ${JSON.stringify(st)}`);
    return `模拟删源失败：A=${JSON.stringify(ra)} B=${JSON.stringify(rb)} 静止=${JSON.stringify(st)}（唯一 done）`;
  });

  await check('D13-3 领取被并发回滚/推进时 complete 错误码与真实终态一致（绝不误报终态）', async () => {
    const sb = sandbox('d13-gone');
    const seeder = new storeMod.InstructionStore({ storeRoot: sb.store });
    const { id } = seeder.enqueue({ instruction: 'd13-gone', sessionId: null, priority: 'normal', metadata: null });
    const pickedPath = path.join(sb.store, 'picked', `${id}.json`);
    const a = runComplete(sb.store, id, 'A', {
      NODE_OPTIONS: `--require ${PRE_RENAME}`,
      WB_TEST_RENAME_FAIL_ID: id,
      WB_TEST_RENAME_FAIL_SLEEP_MS: '600',
    });
    const appeared = await waitFor(() => fs.existsSync(pickedPath), 5000);
    assert.ok(appeared, '模拟下 picked 未出现');
    const b = runComplete(sb.store, id, 'B', {
      NODE_OPTIONS: `--require ${PRE_DELAY}`,
      WB_TEST_DELAY_ID: id,
      WB_TEST_DELAY_MS: '1500',
    });
    const [ra, rb] = await Promise.all([a, b]);
    const st = stateOf(sb.store, id);
    const finalized = st.done || st.failed;
    for (const r of [ra, rb]) {
      if (r.threw === 'INSTRUCTION_ALREADY_FINAL') {
        assert.ok(finalized, `误报终态：报 INSTRUCTION_ALREADY_FINAL 但终态不存在（静止=${JSON.stringify(st)}）`);
      }
    }
    const copies = copiesOf(sb.store, id);
    assert.strictEqual(copies, 1, `静止状态副本数=${copies}（应恰 1）: ${JSON.stringify(st)}`);
    return `GONE 语义：A=${JSON.stringify(ra)} B=${JSON.stringify(rb)} 静止=${JSON.stringify(st)}（终态存在=${finalized}）`;
  });
}

/* ------------------------------------------------------------------ *
 * E. 交付完整性 + 全工具手工验证
 * ------------------------------------------------------------------ */

async function groupE() {
  group('E. 交付完整性 + 8 工具原始 JSON-RPC 手工验证');

  await check('E13-1 README 工具清单/参数与实现一致', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const { toolDefinitions } = require(path.join(LIB, 'tools.js'));
    const defs = toolDefinitions();
    for (const d of defs) {
      assert.ok(readme.includes('`' + d.name + '`'), `README 未提及工具 ${d.name}`);
      for (const param of Object.keys(d.inputSchema.properties)) {
        assert.ok(readme.includes('`' + param + '`'), `README 未提及参数 ${d.name}.${param}`);
      }
    }
    return `${defs.length} 个工具及其参数均在 README 中有记载`;
  });

  await check('E13-2 README config.toml / mcp.json 片段的 command/args 合法且位置无关', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('[mcp_servers.workbuddy-session-bridge]'), 'README 缺 codex config.toml 片段');
    assert.ok(readme.includes('"mcpServers"'), 'README 缺 mcp.json 片段');

    // README 的 TOML/JSON 片段里反斜杠是转义的（两个反斜杠），先归一为单反斜杠再解析路径。
    const unescaped = readme.replace(/\\\\/g, '\\');
    const grab = (re) => [...unescaped.matchAll(re)].map((m) => m[0]);
    // 【M3】同时支持 Windows（`C:\…\node.exe`）与 POSIX（`/Users/…/bin/node`）两种绝对路径片段。
    const absTokens = grab(/(?:[A-Za-z]:\\|\/)[^\s"',\]]*/g);
    const nodePaths = absTokens.filter((t) => /(?:^|[\\/])node(?:\.exe)?$/.test(t));
    const serverPaths = absTokens.filter((t) => /(?:^|[\\/])server\.js$/.test(t));
    /** 取路径 basename（自动按分隔符判断 win32 / posix 语义）。 */
    const baseNameOf = (p) => path.win32.basename(p);

    // (1) args = server.js：basename 必须是 server.js；把「项目目录段之后的尾部」
    //     重定根（re-root）到**当前实际项目目录**——原部署位置、审计包副本位置都能通过；
    //     若 README 写错文件名（如 server.mjs），serverPaths 为空，此处直接 FAIL（保持判别力）。
    assert.ok(serverPaths.length >= 1, 'README 片段未包含任何 "...\\server.js" 或 ".../server.js" 绝对路径（args）');
    const PROJ_SEGMENT = 'workbuddy-session-bridge'; // README 中固定的项目目录段
    for (const raw of serverPaths) {
      assert.strictEqual(baseNameOf(raw), 'server.js', `args 指向的不是 server.js: ${raw}`);
      const segs = raw.split(/[\\/]+/).filter((s) => s.length > 0);
      const idx = segs.lastIndexOf(PROJ_SEGMENT);
      assert.ok(idx >= 0 && idx < segs.length - 1, `args 路径未包含项目目录段 "${PROJ_SEGMENT}": ${raw}`);
      const relocated = path.join(ROOT, ...segs.slice(idx + 1));
      assert.ok(fs.existsSync(relocated), `重定根后路径不存在（README 可能写错文件名/结构）: ${relocated}`);
    }

    // (2) command = node：绝对路径 + basename=node(.exe) 是硬断言；
    //     「本机是否存在」属环境差异（不同机器 Node 安装路径不同）——全部缺失则记 ENV，
    //     既不直接 FAIL，也不伪装 PASS。toml 与 mcp.json 两个片段、两个平台都覆盖。
    assert.ok(nodePaths.length >= 1, 'README 片段未包含任何 "...\\node.exe" 或 ".../bin/node" 绝对路径（command）');
    const missingNode = [];
    for (const raw of nodePaths) {
      assert.ok(/^(?:[A-Za-z]:[\\/]|\/)/.test(raw), `command 不是绝对路径: ${raw}`);
      assert.ok(baseNameOf(raw) === 'node' || baseNameOf(raw) === 'node.exe', `command 指向的不是 node/node.exe: ${raw}`);
      if (!fs.existsSync(raw)) missingNode.push(raw);
    }
    if (missingNode.length === nodePaths.length) {
      raiseEnv(`README 片段中的 node 绝对路径在本机均不存在（不同机器 Node 安装路径不同）: ${missingNode[0]}`);
    }
    const nodeNote = missingNode.length ? `；${missingNode.length}/${nodePaths.length} 个 node 路径本机缺失（ENV 容忍）` : '';
    return `重定根校验 ${serverPaths.length} 个 server.js 均存在；node 绝对路径 ${nodePaths.length} 个 basename 合法${nodeNote}`;
  });

  await check('E13-3 README 声称的 mcp.json 位置存在且为合法 JSON', () => {
    // README 声称的本机配置位置属「部署/本地配置」路径：不同机器可能不在该位置放置 mcp.json，
    // 属环境差异 —— 记 ENV（既不 FAIL，也不伪装 PASS）；若存在则校验其结构（保持判别力）。
    const candidates = [
      'C:\\Users\\TinaD\\.workbuddy\\mcp.json',
      path.join(os.homedir(), '.workbuddy', 'mcp.json'),
    ];
    const existing = candidates.find((p) => fs.existsSync(p));
    if (!existing) {
      raiseEnv(`README 声称的 mcp.json 在本机不存在（属部署/环境差异）: 候选 ${candidates.join(' | ')}`);
    }
    const parsed = JSON.parse(fs.readFileSync(existing, 'utf8'));
    assert.ok(parsed.mcpServers && typeof parsed.mcpServers === 'object', 'mcp.json 结构非 mcpServers');
    return `存在（${existing}），含 ${Object.keys(parsed.mcpServers).length} 个 server（未含本连接器，属配置待办）`;
  });

  await check('E13-4 版本号三处一致（server.js / package.json / README）', () => {
    const { BRIDGE_VERSION, BRIDGE_NAME } = require(path.join(LIB, 'tools.js'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.strictEqual(pkg.version, BRIDGE_VERSION, `package.json=${pkg.version} vs tools.js=${BRIDGE_VERSION}`);
    assert.ok(readme.includes(BRIDGE_NAME), 'README 未提及连接器名');
    assert.deepStrictEqual(pkg.dependencies, {}, 'package.json 声明了第三方依赖');
    return `${BRIDGE_NAME}@${BRIDGE_VERSION} 三处一致，零依赖`;
  });

  await check('E13-5 README 错误码清单覆盖实现中实际抛出的 code', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const codes = ['INVALID_ARGUMENT', 'INVALID_CONVERSATION_ID', 'SESSION_NOT_FOUND', 'PATH_OUT_OF_ROOT',
      'INSTRUCTION_NOT_FOUND', 'INSTRUCTION_ALREADY_FINAL', 'UNKNOWN_TOOL', 'STORE_READ_FAILED',
      'STORE_WRITE_FAILED', 'STORE_RENAME_FAILED', 'RECORD_CORRUPT', 'STORE_CONFIG_INVALID', 'INTERNAL_ERROR'];
    const missing = codes.filter((c) => !readme.includes(c));
    assert.strictEqual(missing.length, 0, `README 缺错误码说明: ${missing.join(', ')}`);
    return `${codes.length} 个错误码均已记载`;
  });

  await check('E14-1 8 个工具全部用原始 JSON-RPC 手工调通', async () => {
    const fx = makeFixture('e-tools');
    const wd = makeWorkDir(['fx', 'tool']);
    writeSession(fx, wd.slug, 'conv-tool', [msgLine('工具联通性测试消息'), msgLine('第二条')], { segments: ['fx', 'tool'] });
    const client = new RawClient({ env: fx.env });
    try {
      // 1 wb_bridge_info
      const info = await client.call('wb_bridge_info');
      assert.ok(!info.raw.isError, 'wb_bridge_info 失败');
      assert.strictEqual(info.payload.name, 'workbuddy-session-bridge');
      assert.ok(info.payload.readAccess.forbiddenFiles.length === 4, '受保护清单不完整');
      assert.strictEqual(info.payload.capabilityBoundary.canDriveWorkBuddySessionDirectly, false);
      // 2 wb_list_sessions
      const list = await client.call('wb_list_sessions', { limit: 10, includeCounts: true });
      assert.ok(!list.raw.isError, 'wb_list_sessions 失败');
      assert.ok(list.payload.sessions.length >= 1, '未列出 fixture 会话');
      // 注意：fixture 目录名按 WorkBuddy 真实规则（单破折号）命名。
      // 由于 slugifyPath 目前产出双破折号，索引路径必然找不到文件 ->
      // fileExists=false / messageCount=0。工具仍应通过 project-scan 兜底读到内容。
      const entry = list.payload.sessions.find((s) => s.conversationId === 'conv-tool');
      assert.ok(entry, '列表中缺少 fixture 会话');
      if (entry.fileExists) {
        assert.ok(entry.messageCount >= 2, `messageCount=${entry.messageCount}，期望 >=2`);
      } else {
        assert.strictEqual(entry.messageCount, 0, 'fileExists=false 时 messageCount 应为 0');
      }
      // 3 wb_read_session
      const read = await client.call('wb_read_session', { conversationId: 'conv-tool', maxMessages: 10, includeSubagents: true });
      assert.ok(!read.raw.isError, 'wb_read_session 失败');
      assert.strictEqual(read.payload.totalMessages, 2);
      assert.ok(Array.isArray(read.payload.subagents), 'includeSubagents 未返回数组');
      // 4 wb_search_sessions
      const search = await client.call('wb_search_sessions', { keyword: '联通性' });
      assert.ok(!search.raw.isError, 'wb_search_sessions 失败');
      assert.ok(search.payload.hitCount >= 1, '搜索未命中');
      // 5 wb_send_instruction
      const sent = await client.call('wb_send_instruction', { instruction: `e2e-${TEST_MARK}`, priority: 'high', metadata: { src: 'qa' } });
      assert.ok(!sent.raw.isError, 'wb_send_instruction 失败');
      const iid = sent.payload.instructionId;
      assert.ok(iid, '缺 instructionId');
      // 6 wb_pending_instructions
      const pulled = await client.call('wb_pending_instructions', { limit: 5 });
      assert.ok(!pulled.raw.isError, 'wb_pending_instructions 失败');
      assert.strictEqual(pulled.payload.count, 1);
      assert.strictEqual(pulled.payload.instructions[0].id, iid);
      // 7 wb_complete_instruction
      const done = await client.call('wb_complete_instruction', { instructionId: iid, result: { summary: 'ok' }, status: 'done' });
      assert.ok(!done.raw.isError, 'wb_complete_instruction 失败');
      assert.strictEqual(done.payload.status, 'done');
      // 8 wb_instruction_stats
      const stats = await client.call('wb_instruction_stats');
      assert.ok(!stats.raw.isError, 'wb_instruction_stats 失败');
      assert.strictEqual(stats.payload.counts.done, 1);
      assert.strictEqual(stats.payload.counts.pending, 0);
      assert.strictEqual(stats.payload.total, 1);
      return '8/8 工具手工 JSON-RPC 全部调通';
    } finally {
      client.close();
    }
  });

  await check('E14-2 指令优先级排序：high 先于 normal 先于 low', async () => {
    const sb = sandbox('e-priority');
    const client = new RawClient({ env: sb.env });
    try {
      await client.call('wb_send_instruction', { instruction: 'low-1', priority: 'low' });
      await RawClient.wait(30);
      await client.call('wb_send_instruction', { instruction: 'normal-1', priority: 'normal' });
      await RawClient.wait(30);
      await client.call('wb_send_instruction', { instruction: 'high-1', priority: 'high' });
      const pulled = await client.call('wb_pending_instructions', { limit: 10 });
      const order = pulled.payload.instructions.map((i) => i.instruction);
      assert.deepStrictEqual(order, ['high-1', 'normal-1', 'low-1'], `取件顺序错误: ${order.join(',')}`);
      return 'high -> normal -> low';
    } finally {
      client.close();
    }
  });

  await check('E14-3 markPicked=false 预览不改变状态', async () => {
    const sb = sandbox('e-preview');
    const client = new RawClient({ env: sb.env });
    try {
      await client.call('wb_send_instruction', { instruction: 'preview-me' });
      const p1 = await client.call('wb_pending_instructions', { limit: 5, markPicked: false });
      assert.strictEqual(p1.payload.instructions[0].status, 'pending');
      const s1 = await client.call('wb_instruction_stats');
      assert.strictEqual(s1.payload.counts.pending, 1);
      const p2 = await client.call('wb_pending_instructions', { limit: 5, markPicked: true });
      assert.strictEqual(p2.payload.instructions[0].status, 'picked');
      const s2 = await client.call('wb_instruction_stats');
      assert.strictEqual(s2.payload.counts.picked, 1);
      assert.strictEqual(s2.payload.counts.pending, 0);
      return '预览不改变状态，标记后转 picked';
    } finally {
      client.close();
    }
  });

  await check('E14-4 sessionId 过滤只取该会话的指令', async () => {
    const sb = sandbox('e-sessionid');
    const client = new RawClient({ env: sb.env });
    try {
      await client.call('wb_send_instruction', { instruction: 'for-A', sessionId: 'A' });
      await client.call('wb_send_instruction', { instruction: 'for-B', sessionId: 'B' });
      await client.call('wb_send_instruction', { instruction: 'no-session' });
      const a = await client.call('wb_pending_instructions', { sessionId: 'A', limit: 10 });
      assert.strictEqual(a.payload.count, 1, `A 应只取到 1 条，实际 ${a.payload.count}`);
      assert.strictEqual(a.payload.instructions[0].instruction, 'for-A');
      const all = await client.call('wb_pending_instructions', { limit: 10 });
      assert.strictEqual(all.payload.count, 2, `剩余应为 2 条，实际 ${all.payload.count}`);
      return 'sessionId 过滤正确';
    } finally {
      client.close();
    }
  });

  await check('E14-5 wb_complete_instruction 终态不可重复回填', async () => {
    const sb = sandbox('e-final');
    const client = new RawClient({ env: sb.env });
    try {
      const sent = await client.call('wb_send_instruction', { instruction: 'final-test' });
      const iid = sent.payload.instructionId;
      await client.call('wb_complete_instruction', { instructionId: iid, status: 'done' });
      const again = await client.call('wb_complete_instruction', { instructionId: iid, status: 'failed' });
      assert.strictEqual(again.raw.isError, true);
      assert.strictEqual(again.payload.error.code, 'INSTRUCTION_ALREADY_FINAL');
      const missing = await client.call('wb_complete_instruction', { instructionId: 'no-such-id' });
      assert.strictEqual(missing.payload.error.code, 'INSTRUCTION_NOT_FOUND');
      return 'INSTRUCTION_ALREADY_FINAL / INSTRUCTION_NOT_FOUND 均正确';
    } finally {
      client.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 独立缺陷用例（针对已定位的源码问题）
 * ------------------------------------------------------------------ */

async function groupF() {
  group('F. 已定位源码缺陷的定向验证');

  await check('F1 【已修复】wb_send_instruction 缺失/空白 instruction 被拒绝（-32602）', async () => {
    const sb = sandbox('f1-empty');
    const client = new RawClient({ env: sb.env });
    try {
      for (const args of [{}, { instruction: '   ' }, { instruction: '' }]) {
        const r = await client.request('tools/call', { name: 'wb_send_instruction', arguments: args });
        assert.ok(r.error, `${JSON.stringify(args)} 竟成功入队`);
        assert.strictEqual(r.error.code, JSONRPC_ERRORS.INVALID_PARAMS, `${JSON.stringify(args)} code=${r.error.code}`);
        assert.ok(String(r.error.message).includes('INVALID_ARGUMENT'), `message 未含 INVALID_ARGUMENT: ${r.error.message}`);
      }
      return '三种空指令均按 -32602/INVALID_ARGUMENT 被拒绝';
    } finally {
      client.close();
    }
  });

  await check('F2 【已修复】requiredString 使空指令校验真正生效（协议级抛出）', async () => {
    // 修复后：optionalString 的空串归一化为 null，wb_send_instruction 改用 requiredString，
    // 且参数校验被标记为协议级错误 -> dispatch 直接抛出（不再是 isError 结果）。
    const { createToolRegistry } = require(path.join(LIB, 'tools.js'));
    process.env.WB_BRIDGE_STORE = sandbox('f2-root').store;
    const registry = createToolRegistry();
    for (const args of [{}, { instruction: '' }, { instruction: '   ' }]) {
      let threw = null;
      try { await registry.dispatch('wb_send_instruction', args); } catch (e) { threw = e; }
      assert.ok(threw, `args=${JSON.stringify(args)} 竟未被拒绝`);
      assert.strictEqual(threw.code, 'INVALID_ARGUMENT', `args=${JSON.stringify(args)} code=${threw.code}`);
      assert.strictEqual(threw.protocolLevel, true, `args=${JSON.stringify(args)} 非协议级错误`);
    }
    return '三种空指令均被真实拒绝（requiredString + 协议级错误）';
  });

  await check('F3 【已修复】workDir 索引路径命中（slug 双破折号已修，无需扫描兜底）', () => {
    if (!HAS_REAL_INDEX) skipCase(SKIP_NO_REAL_INDEX);
    return withRealWorkbuddyDir(() => {
      const layout = paths.resolveLayout();
      const index = sessionsMod.loadSessionIndex(layout);
      let indexHit = 0;
      let scanHit = 0;
      for (const entry of index.sessions) {
        const r = sessionsMod.resolveSessionFile(entry.workDir, entry.conversationId, layout);
        if (fs.existsSync(r.filePath)) indexHit += 1;
        const resolved = sessionsMod.resolveSession(entry.conversationId, layout, index);
        if (resolved.via === 'project-scan') scanHit += 1;
      }
      assert.strictEqual(indexHit, index.sessions.length,
        `索引路径应全部命中，实际 ${indexHit}/${index.sessions.length}（slug 修复回退了？）`);
      assert.strictEqual(scanHit, 0, `不应再有 project-scan 兜底，实际 ${scanHit} 次`);
      return `索引命中 ${indexHit}/${index.sessions.length}，零扫描兜底`;
    });
  });

  await check('F4 【已修复】wb_list_sessions 的 fileExists / messageCount 反映真实文件状态', async () => {
    // 【M3】只需真实会话文件：Mac 无 sessions.json 时走目录扫描兜底，fileExists/messageCount 同样须为真。
    if (!HAS_REAL_PROJECTS) skipCase(SKIP_NO_REAL_PROJECTS);
    // 显式把服务端指向 REAL_WB，使其与 HAS_REAL_DEPLOY 的测量对象一致（不受 HOME 重定向影响）。
    const client = new RawClient({ env: { TASK: '1', WB_BRIDGE_STORE: sandbox('f4-list').store, WB_BRIDGE_LOG: '0', WB_WORKBUDDY_DIR: REAL_WB } });
    try {
      const r = await client.call('wb_list_sessions', { limit: 5, includeCounts: true });
      const exists = r.payload.sessions.filter((s) => s.fileExists === true);
      const missing = r.payload.sessions.filter((s) => s.fileExists === false);
      // 真实数据下索引路径应全部命中；fileExists=true 的条目必须有非零 messageCount。
      for (const s of exists) {
        assert.ok(s.messageCount > 0, `fileExists=true 但 messageCount=${s.messageCount}（slug 修复回退了？）`);
      }
      assert.ok(exists.length > 0,
        `预期 fileExists=true，实际全部未命中（${JSON.stringify(r.payload.sessions.map((s) => s.fileExists))}）`);
      return `修复后：${exists.length} 个会话 fileExists=true 且 messageCount>0；${missing.length} 个真实缺失`;
    } finally {
      client.close();
    }
  });

  await check('F5 【已修复】slugifyPath 盘符冒号与反斜杠合并为单个 "-"', () => {
    if (!HAS_REAL_PROJECTS) skipCase(SKIP_NO_REAL_PROJECTS);
    const input = 'C:\\Users\\TinaD';
    const got = paths.slugifyPath(input);
    const expected = 'c-Users-TinaD';
    assert.strictEqual(got, expected, `slug 修复回退了：got=${got}，期望=${expected}`);
    assert.ok(!got.includes('--'), `仍含双破折号：${got}`);
    // 反向：真实目录名不得含双破折号。
    const realDirs = fs.readdirSync(REAL_WB_PROJECTS);
    const bad = realDirs.filter((d) => d.includes('--'));
    assert.strictEqual(bad.length, 0, `真实目录名含双破折号: ${bad.join(', ')}`);
    return `已修复：'${input}' -> '${got}'；${realDirs.length} 个真实目录名均无双破折号`;
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('workbuddy-session-bridge —— QA 独立验证\n');
  process.stdout.write(`server : ${SERVER}\n`);
  process.stdout.write(`node   : ${NODE_BIN} (${process.version})\n`);
  process.stdout.write(`sandbox: ${QA_ROOT}\n`);
  process.stdout.write(`mark    : ${TEST_MARK}\n`);

  fs.mkdirSync(QA_ROOT, { recursive: true });
  // F01：在任何写入用例之前放置哨兵文件，全程保护。
  SENTINELS = createSentinels();

  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupD13();
  await groupE();
  await groupF();

  group('G. 只读承诺复核 + 哨兵保护');
  // 注意：不能用「整轮前后 mtime 快照」判断只读——WorkBuddy 桌面端自身会持续写
  // .workbuddy（logs/*.log、workbuddy.db-wal、app/memory/polling-lease-*.json 等）。
  // 写入边界由 A1 组 syscall 审计 + D12-2 只读快照给出确定性证据。
  await check('G1 真实 .workbuddy/task-bridge 未被本套件创建或改动（全程零触碰真实目录）', () => {
    const after = snapshotDir(REAL_TASK_BRIDGE);
    assert.strictEqual(after.exists, REAL_TASK_BRIDGE_BEFORE.exists,
      `真实队列根存在性发生变化：before=${REAL_TASK_BRIDGE_BEFORE.exists} after=${after.exists}（${REAL_TASK_BRIDGE}）`);
    assert.deepStrictEqual(after.entries, REAL_TASK_BRIDGE_BEFORE.entries,
      `真实队列根内容被改动：\n  before=${JSON.stringify(REAL_TASK_BRIDGE_BEFORE.entries)}\n  after =${JSON.stringify(after.entries)}`);
    return REAL_TASK_BRIDGE_BEFORE.exists
      ? `真实队列根已存在（默认 store），但其 ${after.entries.length} 个条目在套件全程未被创建/改动/删除`
      : '真实 .workbuddy/task-bridge 不存在，套件全程未创建它';
  });

  await check('G2 真实 WorkBuddy 数据源未被本套件写入', () => {
    const after = snapshotDir(REAL_TASK_BRIDGE);
    assert.deepStrictEqual(after.entries, REAL_TASK_BRIDGE_BEFORE.entries,
      '真实队列根出现本套件产物（entries 快照不一致）');
    if (REAL_PROJECTS_BEFORE !== null) {
      const projectsAfter = fs.readdirSync(REAL_WB_PROJECTS).sort();
      assert.deepStrictEqual(projectsAfter, REAL_PROJECTS_BEFORE,
        `真实 projects/ 顶层目录集合被改动：\n  before=${JSON.stringify(REAL_PROJECTS_BEFORE)}\n  after =${JSON.stringify(projectsAfter)}`);
    }
    return '真实目录无本套件产物（队列 + projects/ 快照前后一致）';
  });

  await check('G3 【F01】哨兵文件全程未被删除/改写（清理边界安全）', () => {
    assertSentinelsIntact();
    return `${SENTINELS.files.length} 个哨兵文件内容哈希未变，清理逻辑未触碰既有文件`;
  });

  const passed = results.filter((r) => r.passed).length;
  const envCount = results.filter((r) => r.env).length;
  const skipCount = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.passed && !r.env && !r.skipped).length;
  process.stdout.write(`\n${'='.repeat(72)}\n=== SUMMARY ===\n`);
  process.stdout.write(`TOTAL ${results.length} | PASS ${passed} | FAIL ${failed} | SKIP ${skipCount} | ENV ${envCount}\n`);
  process.stdout.write(`通过率 ${((passed / results.length) * 100).toFixed(1)}%（SKIP / ENV 不计入 PASS / FAIL）\n`);
  if (failed > 0) {
    process.stdout.write(`\n--- FAILED ---\n`);
    for (const r of results.filter((x) => !x.passed && !x.env && !x.skipped)) {
      process.stdout.write(`  [${r.group}] ${r.name}\n      ${String(r.error).split('\n').join('\n      ')}\n`);
    }
  }
  if (skipCount > 0) {
    process.stdout.write(`\n--- SKIP（前置条件依赖本机真实部署，当前环境不具备）---\n`);
    for (const r of results.filter((x) => x.skipped)) {
      process.stdout.write(`  [${r.group}] ${r.name}\n      ${String(r.error).split('\n').join('\n      ')}\n`);
    }
  }
  if (envCount > 0) {
    process.stdout.write(`\n--- ENV（环境限制，非产品缺陷）---\n`);
    for (const r of results.filter((x) => x.env)) {
      process.stdout.write(`  [${r.group}] ${r.name}\n      ${String(r.error).split('\n').join('\n      ')}\n`);
    }
  }
  // 清理本次运行专有的临时目录（路径唯一，绝不与并发实例互踩）。
  try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  if (SENTINELS && SENTINELS.dir) {
    try { fs.rmSync(SENTINELS.dir, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  }
  process.stdout.write(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'}\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stdout.write(`FATAL: ${error && error.stack ? error.stack : error}\n`);
    process.exit(2);
  });
