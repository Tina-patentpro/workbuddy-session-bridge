'use strict';

/**
 * 独立验收测试共享工具（零第三方依赖，与既有测试无共享代码）。
 *
 * 设计原则（对齐审计方 02 号文档的验收要求）：
 *   1. 全隔离目录：所有写操作都在 mkdtemp 临时目录内；HOME/USERPROFILE 一律重定向到隔离目录，
 *      任何用例都不得触碰真实 ~/.workbuddy。
 *   2. 只读证据用「文件哈希 + 目录项快照」比对，而不是只看报错 / mtime。
 *   3. 结果四分类：PASS / FAIL / SKIP(原因) / ENV(环境限制)，绝不把环境限制伪装成通过。
 *   4. 每个用例文件可单独运行，末尾输出机器可读的 `__RESULT__` 行供 run-all.js 汇总。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/** 项目根（被测生产代码所在目录）。 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** 被测 server.js 绝对路径。 */
const SERVER_PATH = path.join(PROJECT_ROOT, 'server.js');
/** 当前 Node 可执行文件（保证与既有测试同运行时）。 */
const NODE_BIN = process.execPath;

const R = { pass: [], fail: [], skip: [], env: [] };

/* ------------------------------------------------------------------ *
 * 结果分类与断言
 * ------------------------------------------------------------------ */

/** 环境限制：不算产品缺陷，也不算通过。 */
class EnvLimitation extends Error {
  constructor(message) {
    super(message);
    this.__env = true;
  }
}

/** 跳过：前置条件不满足（如依赖文档尚未修订）。 */
class Skipped extends Error {
  constructor(message) {
    super(message);
    this.__skip = true;
  }
}

function emit(kind, name, detail) {
  process.stdout.write(`  ${kind.padEnd(4)} ${name}${detail ? '  · ' + detail : ''}\n`);
}

function pass(name, detail) {
  R.pass.push(name);
  emit('PASS', name, detail);
}

function fail(name, detail) {
  R.fail.push({ name, detail: detail || '' });
  emit('FAIL', name, detail);
}

function skip(name, detail) {
  R.skip.push({ name, detail: detail || '' });
  emit('SKIP', name, detail);
}

function envLimit(name, detail) {
  R.env.push({ name, detail: detail || '' });
  emit('ENV', name, detail);
}

/**
 * 运行一个检查体；按异常类型归入 PASS/FAIL/SKIP/ENV。
 *
 * @param {string} name 检查名。
 * @param {function(): (Promise<*>|void)} fn 检查体。
 * @return {Promise<void>} 完成。
 */
async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    if (error && error.__env) envLimit(name, error.message);
    else if (error && error.__skip) skip(name, error.message);
    else fail(name, error && error.message ? error.message : String(error));
  }
}

/** 抛出环境限制。 */
function raiseEnv(message) {
  throw new EnvLimitation(message);
}

/** 抛出跳过。 */
function raiseSkip(message) {
  throw new Skipped(message);
}

/**
 * 简单断言。
 *
 * @param {unknown} cond 条件。
 * @param {string} message 断言说明。
 * @return {void}
 */
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 输出本文件的结论并设置退出码（存在 FAIL 时非零）。
 *
 * @param {string} id 缺陷编号，如 'F01'。
 * @param {string} [note] 附加说明。
 * @return {void}
 */
function finish(id, note) {
  const verdict = R.fail.length > 0
    ? 'FAIL'
    : (R.pass.length > 0 ? 'PASS' : (R.env.length > 0 ? 'ENV' : 'SKIP'));
  process.stdout.write(`\n=== ${id}: ${verdict} (pass=${R.pass.length} fail=${R.fail.length} skip=${R.skip.length} env=${R.env.length}) ===\n`);
  if (note) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(`__RESULT__ ${JSON.stringify({
    id,
    verdict,
    pass: R.pass.length,
    fail: R.fail.length,
    skip: R.skip.length,
    env: R.env.length,
    failures: R.fail.map((f) => `${f.name}${f.detail ? ' :: ' + f.detail : ''}`),
  })}\n`);
  process.exit(R.fail.length > 0 ? 1 : 0);
}

/* ------------------------------------------------------------------ *
 * 隔离与快照
 * ------------------------------------------------------------------ */

/**
 * 创建一个完全隔离的临时目录。
 *
 * @param {string} label 隔离标签（用于临时目录前缀）。
 * @return {{root: string, home: string, workbuddy: string, store: string, projects: string}} 隔离路径集。
 */
function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `acc-${label}-`));
  const home = path.join(root, 'home');
  const workbuddy = path.join(home, '.workbuddy');
  const store = path.join(root, 'store');
  const projects = path.join(workbuddy, 'projects');
  fs.mkdirSync(workbuddy, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  return { root, home, workbuddy, store, projects };
}

/**
 * 构造隔离环境变量：HOME/USERPROFILE 指向隔离目录，清除可能影响布局的变量。
 *
 * @param {{home: string, workbuddy: string}} sandbox 隔离目录。
 * @param {Object<string,string|undefined>} [extra] 额外覆盖。
 * @return {Object<string,string>} 环境变量。
 */
function baseEnv(sandbox, extra) {
  const env = { ...process.env };
  delete env.TASK;
  delete env.WB_BRIDGE_STORE;
  delete env.WB_BRIDGE_DIR;
  delete env.WB_WORKBUDDY_DIR;
  delete env.WB_PROJECTS_DIR;
  delete env.WB_SESSIONS_INDEX;
  env.HOME = sandbox.home;
  env.USERPROFILE = sandbox.home;
  env.WB_WORKBUDDY_DIR = sandbox.workbuddy;
  env.WB_BRIDGE_LOG = '0';
  if (extra) for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/**
 * 递归快照一个目录：文件 -> size:sha256，目录 -> 'dir'，符号链接不跟随（lstat）。
 *
 * @param {string} root 根目录（可为不存在的路径）。
 * @return {Object<string,string>} 快照映射。
 */
function snapshotTree(root) {
  const out = {};
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      out['D:' + p] = 'dir';
      let entries = [];
      try {
        entries = fs.readdirSync(p).sort();
      } catch {
        entries = [];
      }
      for (const e of entries) walk(path.join(p, e));
    } else {
      let hash = '<unreadable>';
      try {
        hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      } catch {
        /* 保留占位 */
      }
      out['F:' + p] = `${st.size}:${hash}`;
    }
  };
  walk(root);
  return out;
}

/**
 * 比较两个快照，返回差异描述数组。
 *
 * @param {Object<string,string>} before 前快照。
 * @param {Object<string,string>} after 后快照。
 * @return {string[]} 差异列表。
 */
function diffSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [];
  for (const k of keys) {
    if (before[k] !== after[k]) diffs.push(`${k}: ${before[k] || '(absent)'} -> ${after[k] || '(absent)'}`);
  }
  return diffs;
}

/**
 * 读取 store 中「已持久化」的指令 id 集合（兼容 maildir 目录与单文件两种布局）。
 *
 * @param {string} storePath store 根（目录或文件）。
 * @return {{ids: string[], records: Object[], files: string[]}} 持久化结果。
 */
function readPersisted(storePath) {
  const ids = [];
  const records = [];
  const files = [];
  const pushRecord = (obj, file) => {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.id === 'string') {
      ids.push(obj.id);
      records.push(obj);
      files.push(file);
    } else if (Array.isArray(obj.instructions)) {
      for (const it of obj.instructions) {
        if (it && typeof it.id === 'string') {
          ids.push(it.id);
          records.push(it);
          files.push(file);
        }
      }
    }
  };
  let st;
  try {
    st = fs.lstatSync(storePath);
  } catch {
    return { ids, records, files };
  }
  if (st.isFile()) {
    files.push(storePath);
    try {
      pushRecord(JSON.parse(fs.readFileSync(storePath, 'utf8')), storePath);
    } catch {
      /* 无法解析 */
    }
    return { ids, records, files };
  }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      let cst;
      try {
        cst = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (cst.isDirectory()) walk(p);
      else {
        try {
          pushRecord(JSON.parse(fs.readFileSync(p, 'utf8')), p);
        } catch {
          /* 跳过非 JSON */
        }
      }
    }
  };
  walk(storePath);
  return { ids, records, files };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * MCP stdio 客户端
 * ------------------------------------------------------------------ */

/** 极简 MCP stdio 客户端（可发原始帧，用于协议边界测试）。 */
class Client {
  /**
   * @param {Object<string,string>} env 子进程环境变量。
   * @param {{args?: string[]}} [opts] 选项。
   */
  constructor(env, opts = {}) {
    this.buffer = '';
    this.pending = new Map();
    this.messages = [];
    this.nextId = 1;
    this.stderr = '';
    this.child = spawn(NODE_BIN, [SERVER_PATH, ...(opts.args || [])], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this._onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderr += c;
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let i = this.buffer.indexOf('\n');
    while (i !== -1) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line.length > 0) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        this.messages.push(msg);
        if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const resolve = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
      i = this.buffer.indexOf('\n');
    }
  }

  /**
   * 发送一条 JSON-RPC 请求并等待响应。
   *
   * @param {string} method 方法名。
   * @param {Object} [params] 参数。
   * @param {number} [timeout] 超时毫秒。
   * @return {Promise<Object|null>} 响应消息；超时返回 null。
   */
  request(method, params, timeout = 10000) {
    const id = this.nextId;
    this.nextId += 1;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeout);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.write(JSON.stringify(msg));
    });
  }

  /** 发送通知（无 id）。 */
  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(JSON.stringify(msg));
  }

  /** 发送一条原始文本行（用于畸形帧测试）。 */
  writeRaw(line) {
    this.write(line);
  }

  write(text) {
    try {
      this.child.stdin.write(text + '\n');
    } catch {
      /* 子进程可能已退出 */
    }
  }

  /** 完成 MCP 握手。 */
  async initialize(protocolVersion = '2024-11-05') {
    const res = await this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'acceptance', version: '1.0.0' } });
    this.notify('notifications/initialized');
    return res;
  }

  /** 调用工具，返回原始响应消息。 */
  call(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  /** 等待若干毫秒，收集此窗口内的新消息。 */
  async collect(ms) {
    const from = this.messages.length;
    await sleep(ms);
    return this.messages.slice(from);
  }

  /** 优雅关闭。 */
  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const killed = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1500);
    await this.exited;
    clearTimeout(killed);
  }
}

/**
 * 解析 tools/call 响应为统一结构。
 *
 * @param {Object|null} msg 响应消息。
 * @return {{ok: boolean, payload: (Object|null), protocolError: (Object|null), isError: boolean, reason: (string|null)}} 解析结果。
 */
function parseTool(msg) {
  if (!msg) return { ok: false, payload: null, protocolError: null, isError: false, reason: 'no-response' };
  if (msg.error) return { ok: false, payload: null, protocolError: msg.error, isError: false, reason: 'protocol-error' };
  const result = msg.result;
  if (!result || !Array.isArray(result.content)) return { ok: false, payload: null, protocolError: null, isError: false, reason: 'bad-result' };
  let payload = null;
  try {
    payload = JSON.parse(result.content[0].text);
  } catch {
    payload = null;
  }
  if (result.isError) return { ok: false, payload, protocolError: null, isError: true, reason: 'tool-error' };
  return { ok: true, payload, protocolError: null, isError: false, reason: null };
}

module.exports = {
  PROJECT_ROOT,
  SERVER_PATH,
  NODE_BIN,
  EnvLimitation,
  Skipped,
  R,
  check,
  pass,
  fail,
  skip,
  envLimit,
  raiseEnv,
  raiseSkip,
  assert,
  finish,
  makeSandbox,
  baseEnv,
  snapshotTree,
  diffSnapshots,
  readPersisted,
  sleep,
  Client,
  parseTool,
};
