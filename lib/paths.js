'use strict';

/**
 * 路径与目录布局解析。
 *
 * 布局（全部来自 WorkBuddy 本机已验证的事实）：
 *   - 会话索引:      <workbuddyDir>/app/sessions.json
 *   - 项目会话目录:  <workbuddyDir>/projects/<workDir 的 slug>/<conversationId>.jsonl
 *   - 子代理记录:    <workbuddyDir>/projects/<slug>/<conversationId>/subagents/<agentId>.jsonl
 *   - 本连接器队列:  <workbuddyDir>/task-bridge/  （maildir 根目录，可用 WB_BRIDGE_STORE 覆盖为目录）
 *
 * 硬性约束：绝不读写 workbuddy.db 及其 -wal / -shm / -journal 文件。
 *
 * 【第三方审计 F03 / F04 整改】
 *   - F03：所有存储入口在**任何** fs 调用之前统一校验受保护清单与父目录别名，配置错误立即失败。
 *   - F04：`assertWithinRoot` 改为基于 `fs.realpathSync.native` 的**真实目标**判定，
 *          而非词法 `path.resolve` 前缀比较，从而阻断「符号链接 / 目录联接指向根外或受保护文件」。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/** 绝对禁止触碰的 WorkBuddy 运行时数据库文件名（小写比较）。 */
const FORBIDDEN_BASENAMES = Object.freeze([
  'workbuddy.db',
  'workbuddy.db-wal',
  'workbuddy.db-shm',
  'workbuddy.db-journal',
]);

/** maildir 队列根目录下的固定子目录。 */
const STORE_SUBDIRS = Object.freeze(['pending', 'picked', 'done', 'failed', 'tmp']);

/**
 * 项目目录 slug 化时需要替换掉的路径分隔符与盘符冒号。
 *
 * 注意 `+` 量词：WorkBuddy 的真实规则是「盘符冒号 + 分隔符合并为**单个** `-`」，
 * 因此 `C:\Users\TinaD` -> `c-Users-TinaD`（而非 `c--Users-TinaD`）。
 * 该决策经 QA 第 2 轮数据验证正确（BUG-2 真修复），**不得回退**。
 */
const SLUG_REPLACED_CHARS = /[\\/:]+/g;

/**
 * 真实 WorkBuddy 会话 ID 的形态：UUID v4（大小写不敏感）。
 * 仅用于「建议形态」提示，不作为硬性白名单——测试夹具等场景存在非 UUID 的会话 ID。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * conversationId 中**绝不允许**出现的字符。
 *
 * `path.join` 会规范化 `..`，因此只要放行路径分隔符与 `..`，
 * 形如 `..\\..\\..\\outside` 的值就能把读取范围引到 projects/ 之外。
 */
const ID_FORBIDDEN_CHARS = /[\\/*?<>|":\u0000-\u001f]/;

/** conversationId 的形态限制：只允许「安全名字」字符。 */
const ID_SAFE_CHARS = /^[A-Za-z0-9._-]+$/;

/** conversationId 长度上限（防超长输入）。 */
const ID_MAX_LENGTH = 128;

/** workDir 长度上限（防超长输入）。 */
const WORKDIR_MAX_LENGTH = ID_MAX_LENGTH * 16;

/**
 * Windows 保留设备名（Win32 命名空间）。
 *
 * 这些名字即便带扩展名也无法创建常规文件，`CON.jsonl` 之类会被解释为设备。
 * 当前 Node v22 走 `\\?\` 长路径语义不解析设备名，故这不是可利用缺陷，
 * 但作为多重校验显式拒绝 —— 万一将来换运行时就踩坑。
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 取文件名 stem：去掉最后一个扩展名的部分（无扩展名则原样返回）。
 *
 * 例：`CON.jsonl` -> `CON`；`conv-partial` -> `conv-partial`。
 *
 * @param {string} name 文件名。
 * @return {string} stem。
 */
function stripExtension(name) {
  const index = name.lastIndexOf('.');
  // index <= 0：`.hidden` 没有 stem（返回原样），`noext` 也没有。
  return index > 0 ? name.slice(0, index) : name;
}

/**
 * 把工作目录路径 slug 化，与 WorkBuddy 自身的命名规则保持一致。
 *
 * 规则：盘符字母转小写，**连续的** `\` / `:` / `/` 合并替换为单个 `-`，其余字符（含中文）原样保留。
 *   `C:\Users\TinaD\WorkBuddy\2026-10-07-11-15-23`
 *     -> `c-Users-TinaD-WorkBuddy-2026-10-07-11-15-23`
 *   `D:\OneDrive\4、董娣相关\4、专利知识库`
 *     -> `d-OneDrive-4、董娣相关-4、专利知识库`
 *
 * @param {string} workDir 绝对路径的工作目录。
 * @return {string} slug 化结果；入参为空或非字符串时返回空字符串。
 */
function slugifyPath(workDir) {
  if (typeof workDir !== 'string' || workDir.length === 0) return '';
  let normalized = workDir.trim().replace(/\//g, '\\');
  // 仅盘符首字母小写：`C:\...` -> `c:\...`，其余保持原样（`Users` 不变小写）。
  normalized = normalized.replace(/^([A-Za-z]):/, (_m, letter) => letter.toLowerCase() + ':');
  return normalized.replace(SLUG_REPLACED_CHARS, '-');
}

/**
 * 校验 workDir 是否可安全用于路径拼接（多重校验）。
 *
 * @param {unknown} workDir 待校验的工作目录。
 * @return {{ok: boolean, value: (string|null), reason: (string|null)}} 校验结果。
 */
function validateWorkDir(workDir) {
  if (typeof workDir !== 'string' || workDir.trim().length === 0) {
    return { ok: false, value: null, reason: 'EMPTY' };
  }
  const value = workDir.trim();
  if (value.length > WORKDIR_MAX_LENGTH) {
    return { ok: false, value: null, reason: 'TOO_LONG' };
  }
  // NUL 与控制字符在 Windows 上是隐蔽的路径操纵手法。
  if (/[\u0000-\u001f]/.test(value)) {
    return { ok: false, value: null, reason: 'FORBIDDEN_CHARS' };
  }
  return { ok: true, value, reason: null };
}

/**
 * 校验 conversationId 是否可安全用于拼接路径。
 *
 * 四层防护：
 *   1. 形态：非空、长度受限、只含 `[A-Za-z0-9._-]`（拒绝一切路径分隔符与控制字符）。
 *   2. 语义：拒绝含 `..` 的值。
 *   3. 设备名：拒绝 Windows 保留设备名（含 `CON.jsonl` 这类带扩展名的形式）。
 *   4. 路径：调用方再用 `assertWithinRoot` 确认**真实目标**仍在允许根目录内。
 *
 * 采用「安全字符集 + 设备名黑名单」而非纯 UUID 白名单：既阻断 `..\\..\\outside` 类越级
 * 与设备名，又不误伤真实会话 ID —— 实测 `projects/` 下约 10% 的会话 ID 是
 * 32 位无连字符 hex（形如 `0210327a89244abea944d98682323895`）而非 UUID，
 * 纯 UUID 白名单会让这部分真实会话不可读。**该决策经数据验证，不得回退为纯 UUID。**
 *
 * @param {unknown} conversationId 待校验的会话 ID。
 * @return {{ok: boolean, value: (string|null), reason: (string|null), isUuid: boolean}} 校验结果。
 */
function validateConversationId(conversationId) {
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    return { ok: false, value: null, reason: 'EMPTY', isUuid: false };
  }
  const id = conversationId.trim();
  if (id.length > ID_MAX_LENGTH) {
    return { ok: false, value: null, reason: 'TOO_LONG', isUuid: false };
  }
  if (ID_FORBIDDEN_CHARS.test(id)) {
    return { ok: false, value: null, reason: 'FORBIDDEN_CHARS', isUuid: false };
  }
  if (!ID_SAFE_CHARS.test(id)) {
    return { ok: false, value: null, reason: 'UNSAFE_CHARS', isUuid: false };
  }
  if (id === '.' || id === '..' || id.includes('..')) {
    return { ok: false, value: null, reason: 'PARENT_REF', isUuid: false };
  }
  // 设备名检查：按 stem（去扩展名）比对，`CON.jsonl` 与 `con` 同样被拦下。
  if (WINDOWS_DEVICE_NAMES.has(stripExtension(id).toUpperCase())) {
    return { ok: false, value: null, reason: 'RESERVED_DEVICE_NAME', isUuid: false };
  }
  return { ok: true, value: id, reason: null, isUuid: UUID_PATTERN.test(id) };
}

/**
 * 解析路径的**真实**（规范化）目标，跟随符号链接 / 目录联接。
 *
 * 优先使用 `fs.realpathSync.native`（Windows 上可解析 junction / reparse point），
 * 失败（路径不存在 / 平台不支持）时退回普通 `realpathSync`，再失败时退回词法绝对路径。
 * 该函数是只读的，且对不存在的路径不产生任何副作用。
 *
 * @param {string} targetPath 目标路径。
 * @return {string} 规范化后的真实绝对路径；无法解析时返回 `path.resolve` 结果。
 */
function toCanonical(targetPath) {
  const abs = path.resolve(targetPath);
  if (typeof fs.realpathSync.native === 'function') {
    try {
      return fs.realpathSync.native(abs);
    } catch (_error) {
      /* 落到下一级回退 */
    }
  }
  try {
    return fs.realpathSync(abs);
  } catch (_error) {
    return abs;
  }
}

/**
 * 平台相关的路径比较归一化（Windows 大小写不敏感）。
 *
 * @param {string} p 路径。
 * @return {string} 归一化结果。
 */
function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 判断 `childPath` 是否位于 `parentPath` 之内（含相等）。
 *
 * @param {string} childPath 子路径（已 resolve）。
 * @param {string} parentPath 父路径（已 resolve）。
 * @return {boolean} 是否包含。
 */
function isWithinPath(childPath, parentPath) {
  const child = normalizeForCompare(childPath);
  const parent = normalizeForCompare(parentPath);
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * 确认目标路径的**真实实体**仍位于允许的根目录之内，且真实 basename 不在受保护清单。
 *
 * 【F04 整改核心】旧实现只做 `path.resolve` 后的字符串前缀比较，
 * 无法阻止符号链接 / 目录联接把读取实体引到根外（如指向根外的 `workbuddy.db` 同名文件）。
 * 现改为：对根目录与候选路径分别求真（realpath）后比较真实目标，并检查真实 basename。
 *
 * 三重判定（任一不成立即拒绝）：
 *   1. 词法包含：`path.resolve(candidate)` 位于 `path.resolve(root)` 内。
 *   2. 真实包含：`realpath(candidate)` 位于 `realpath(root)` 内。
 *   3. 受保护清单：`basename(realpath(candidate))` 不在 FORBIDDEN_BASENAMES 内。
 *
 * @param {string} candidatePath 候选路径。
 * @param {string} rootDir 允许的根目录。
 * @return {{ok: boolean, resolved: string, realRoot: string, reason: (string|null)}} 校验结果。
 */
function assertWithinRoot(candidatePath, rootDir) {
  const rootAbs = path.resolve(rootDir);
  const rootReal = toCanonical(rootAbs);
  const candAbs = path.resolve(candidatePath);
  const candReal = toCanonical(candAbs);

  if (!isWithinPath(candAbs, rootAbs)) {
    return { ok: false, resolved: candReal, realRoot: rootReal, reason: 'OUTSIDE_ROOT_LEXICAL' };
  }
  if (!isWithinPath(candReal, rootReal)) {
    return { ok: false, resolved: candReal, realRoot: rootReal, reason: 'OUTSIDE_ROOT_REAL' };
  }
  const realBase = path.basename(candReal).toLowerCase();
  if (FORBIDDEN_BASENAMES.includes(realBase)) {
    return { ok: false, resolved: candReal, realRoot: rootReal, reason: 'FORBIDDEN_BASENAME' };
  }
  return { ok: true, resolved: candReal, realRoot: rootReal, reason: null };
}

/**
 * 只读且**零副作用**地确认一个路径可安全读取。
 *
 * 依次执行：词法 basename 受保护清单检查 -> 真实目标根包含检查 -> 存在性/文件类型检查。
 * 不创建、不移动、不写入任何文件。
 *
 * @param {string} targetPath 目标路径。
 * @param {string} rootDir 允许的根目录；缺省为不限制根（仅做 basename 检查）。
 * @return {{ok: boolean, resolved: (string|null), reason: (string|null)}} 检查结果。
 */
function assertSafeReadPath(targetPath, rootDir) {
  const lexBase = path.basename(path.resolve(targetPath)).toLowerCase();
  if (FORBIDDEN_BASENAMES.includes(lexBase)) {
    return { ok: false, resolved: null, reason: `FORBIDDEN_PATH: 禁止访问 WorkBuddy 运行时数据库 (${lexBase})` };
  }
  let resolved = path.resolve(targetPath);
  if (rootDir) {
    const within = assertWithinRoot(targetPath, rootDir);
    if (!within.ok) {
      return {
        ok: false,
        resolved: within.resolved,
        reason: `PATH_OUT_OF_ROOT (${within.reason}): ${within.resolved}`,
      };
    }
    resolved = within.resolved;
  }
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (_error) {
    return { ok: false, resolved, reason: `NOT_FOUND: ${resolved}` };
  }
  if (!stats.isFile()) return { ok: false, resolved, reason: `NOT_A_FILE: ${resolved}` };
  return { ok: true, resolved, reason: null };
}

/**
 * 校验一个存储根目录配置是否安全可用（**只读、零副作用**）。
 *
 * 【F03 整改核心】必须在任何 mkdir / write / rename 之前调用，且自身不得产生副作用。
 * 拒绝以下配置：
 *   - 以 `.json` 结尾（旧版把 STORE 当作单文件的语义，已废弃，直接报配置错误）；
 *   - 任一路径段的 basename 命中受保护清单（workbuddy.db 及其三个侧车）；
 *   - 目标已存在且不是目录（是文件）。
 *
 * @param {string} rootPath 期望的存储根目录。
 * @return {{ok: boolean, value: (string|null), reason: (string|null)}} 校验结果。
 */
function validateStoreRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    return { ok: false, value: null, reason: 'EMPTY' };
  }
  const abs = path.resolve(rootPath.trim());

  if (/\.json$/i.test(abs)) {
    return {
      ok: false,
      value: null,
      reason: 'CONFIG_STORE_IS_FILE_PATH: WB_BRIDGE_STORE 现在表示「队列根目录」，不再接受 .json 文件路径',
    };
  }

  // 逐段检查 basename，阻断「父目录别名」指向受保护文件/侧车。
  const segments = abs.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_BASENAMES.includes(segment.toLowerCase())) {
      return { ok: false, value: null, reason: `CONFIG_FORBIDDEN_TARGET: 存储根包含受保护路径段 (${segment})` };
    }
  }

  // 存在性检查：使用 lstat（不跟随链接）避免把「链接到文件」误判为目录。
  let stats = null;
  try {
    stats = fs.lstatSync(abs);
  } catch (_error) {
    stats = null;
  }
  if (stats && !stats.isDirectory() && !stats.isSymbolicLink()) {
    return { ok: false, value: null, reason: 'CONFIG_STORE_NOT_DIRECTORY: WB_BRIDGE_STORE 必须指向目录' };
  }
  if (stats && stats.isSymbolicLink()) {
    let realStats = null;
    try {
      realStats = fs.statSync(abs);
    } catch (_error) {
      realStats = null;
    }
    if (realStats && !realStats.isDirectory()) {
      return { ok: false, value: null, reason: 'CONFIG_STORE_NOT_DIRECTORY: WB_BRIDGE_STORE 链接目标不是目录' };
    }
  }
  return { ok: true, value: abs, reason: null };
}

/**
 * 返回用户主目录，兼容不同平台环境变量。
 *
 * @return {string} 用户主目录。
 */
function homeDir() {
  const candidates = [process.env.USERPROFILE, process.env.HOME, os.homedir()];
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return found || 'C:\\';
}

/**
 * 由存储根目录派生 maildir 各子目录绝对路径。
 *
 * @param {string} root 存储根目录。
 * @return {{root: string, pending: string, picked: string, done: string, failed: string, tmp: string}} 子目录表。
 */
function storeParts(root) {
  return {
    root,
    pending: path.join(root, 'pending'),
    picked: path.join(root, 'picked'),
    done: path.join(root, 'done'),
    failed: path.join(root, 'failed'),
    tmp: path.join(root, 'tmp'),
  };
}

/**
 * 解析本连接器关心的全部路径。可被环境变量覆盖，便于测试隔离。
 *
 * 覆盖规则：
 *   - `WB_BRIDGE_STORE`：直接指定**队列根目录**（优先级最高，语义为目录）。
 *   - `WB_BRIDGE_DIR`  ：指定 bridge 根目录（其本身即队列根目录）。
 *   - `TASK`（任意真值）：隔离模式，bridge 目录被重定向到系统临时目录。
 *   - `WB_WORKBUDDY_DIR`：覆盖 `.workbuddy` 根（默认 `<home>/.workbuddy`）。
 *   - `WB_PROJECTS_DIR` / `WB_SESSIONS_INDEX`：覆盖只读数据源（诊断/测试用）。
 *
 * 解析出的存储目标会立即通过 `validateStoreRoot` 校验；非法配置在此抛出，**不产生任何副作用**。
 *
 * @return {{
 *   homeDir: string, workbuddyDir: string, projectsDir: string,
 *   sessionsIndexPath: string, sessionIndexRoot: string,
 *   bridgeDir: string, storeRoot: string, storeParts: Object,
 *   sandboxed: boolean, sources: Object<string, string>
 * }} 路径布局描述。
 * @throws {Error} 存储根配置非法（如 .json 结尾 / 命中受保护清单 / 指向文件）时抛出。
 */
function resolveLayout() {
  const home = homeDir();
  const workbuddyDir = process.env.WB_WORKBUDDY_DIR || path.join(home, '.workbuddy');

  const sandboxed = isTruthy(process.env.TASK) || Boolean(process.env.WB_BRIDGE_STORE);
  const storeRootEnv = process.env.WB_BRIDGE_STORE;
  const bridgeDirEnv = process.env.WB_BRIDGE_DIR;

  let bridgeDir;
  let storeRoot;
  let storeSource;
  if (storeRootEnv) {
    const validated = validateStoreRoot(storeRootEnv);
    if (!validated.ok) {
      throw new Error(`[paths] 存储配置非法：${validated.reason}（WB_BRIDGE_STORE=${storeRootEnv}）`);
    }
    storeRoot = validated.value;
    bridgeDir = bridgeDirEnv ? path.resolve(bridgeDirEnv) : storeRoot;
    storeSource = 'env:WB_BRIDGE_STORE';
  } else if (bridgeDirEnv) {
    bridgeDir = path.resolve(bridgeDirEnv);
    const validated = validateStoreRoot(bridgeDir);
    if (!validated.ok) {
      throw new Error(`[paths] 存储配置非法：${validated.reason}（WB_BRIDGE_DIR=${bridgeDirEnv}）`);
    }
    storeRoot = validated.value;
    storeSource = 'env:WB_BRIDGE_DIR';
  } else if (sandboxed) {
    bridgeDir = path.join(os.tmpdir(), 'workbuddy-session-bridge-sandbox');
    storeRoot = bridgeDir;
    storeSource = 'sandbox';
  } else {
    bridgeDir = path.join(workbuddyDir, 'task-bridge');
    storeRoot = bridgeDir;
    storeSource = 'default';
  }

  const sessionsIndexPath =
    process.env.WB_SESSIONS_INDEX || path.join(workbuddyDir, 'app', 'sessions.json');

  return {
    homeDir: home,
    workbuddyDir,
    projectsDir: process.env.WB_PROJECTS_DIR || path.join(workbuddyDir, 'projects'),
    sessionsIndexPath,
    sessionIndexRoot: path.dirname(sessionsIndexPath),
    bridgeDir,
    storeRoot,
    storeParts: storeParts(storeRoot),
    sandboxed,
    sources: {
      store: storeSource,
      projectsDir: process.env.WB_PROJECTS_DIR ? 'env:WB_PROJECTS_DIR' : 'default',
      sessionsIndex: process.env.WB_SESSIONS_INDEX ? 'env:WB_SESSIONS_INDEX' : 'default',
    },
  };
}

/**
 * 判断环境变量是否为真值（用于隔离目录开关）。
 *
 * @param {string|undefined} value 环境变量原始值。
 * @return {boolean} 是否为真。
 */
function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

/**
 * 只读地确认某个路径可以安全访问：词法 basename 不在受保护清单、存在且是文件。
 *
 * 保留该函数是为了不破坏既有调用方；涉及根边界的新调用请使用 `assertSafeReadPath`。
 *
 * @param {string} targetPath 目标路径。
 * @return {{ok: boolean, reason: (string|null)}} 检查结果。
 */
function assertSafeReadable(targetPath) {
  const base = path.basename(targetPath).toLowerCase();
  if (FORBIDDEN_BASENAMES.includes(base)) {
    return { ok: false, reason: `FORBIDDEN_PATH: 禁止访问 WorkBuddy 运行时数据库 (${base})` };
  }
  let stats;
  try {
    stats = fs.statSync(targetPath);
  } catch (_error) {
    return { ok: false, reason: `NOT_FOUND: ${targetPath}` };
  }
  if (!stats.isFile()) return { ok: false, reason: `NOT_A_FILE: ${targetPath}` };
  return { ok: true, reason: null };
}

/**
 * 安全地列目录，失败时返回空数组而不抛异常（只读）。
 *
 * @param {string} dir 目录路径。
 * @return {import('fs').Dirent[]} 目录项；不可用时为空数组。
 */
function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

module.exports = {
  FORBIDDEN_BASENAMES,
  STORE_SUBDIRS,
  UUID_PATTERN,
  WINDOWS_DEVICE_NAMES,
  ID_MAX_LENGTH,
  slugifyPath,
  stripExtension,
  validateConversationId,
  validateWorkDir,
  validateStoreRoot,
  assertWithinRoot,
  assertSafeReadPath,
  assertSafeReadable,
  toCanonical,
  isWithinPath,
  storeParts,
  homeDir,
  resolveLayout,
  isTruthy,
  safeReadDir,
};
