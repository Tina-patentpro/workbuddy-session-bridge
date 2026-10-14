'use strict';

/**
 * 只读会话访问层：会话索引 + 项目目录 + jsonl 消息。
 *
 * 只读边界：本模块只调用 stat / readdir / readFileSync，绝不写入、移动或创建任何文件。
 *
 * 【第三方审计 F04 整改】所有读取入口（索引、会话文件、扫描、搜索、计数、子代理）统一
 * 经过基于 `fs.realpathSync.native` 的真实目标边界检查：
 *   - 词法包含 + 真实包含双重判定（阻断符号链接 / 目录联接把实体引到根外）；
 *   - 真实 basename 不得命中受保护清单（阻断链接指向 workbuddy.db 及侧车）。
 * 补一个入口的 realpath 不算完成——索引、会话、扫描、子代理路径全部覆盖。
 */

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const jsonl = require('./jsonl');
const { AppError, JSONRPC_ERRORS } = require('./protocol');

/** 列举会话时的默认值。 */
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_SESSIONS = 20;
const DEFAULT_SEARCH_BYTES_PER_SESSION = 2 * 1024 * 1024;

/**
 * 读取并解析 sessions.json（权威会话索引）。
 *
 * 【M2 修复 · Mac 客户端不生成索引】
 * WinPC 客户端会维护 `<workbuddyDir>/app/sessions.json`；**Mac 客户端不写这个文件**
 * （实测全树 `find -name sessions.json` 零命中），但项目会话 jsonl 照常落在
 * `projects/<slug>/<conversationId>.jsonl`。若此处直接返回空，`wb_list_sessions` /
 * `wb_search_sessions` 在本机就完全失效。
 * 因此索引不可读时**降级**为只读目录扫描（`buildIndexFromScan`），并如实标注：
 *   - `indexReadable: false`（不掩盖索引缺失这一事实）
 *   - `source: 'project-scan'`（数据来自扫描而非权威索引）
 * 红线不变：扫描只做 `stat / readdir`，绝不触碰 `workbuddy.db` 及其侧车。
 *
 * @param {Object} layout 路径布局。
 * @return {{ok: boolean, source: string, version: (number|null), updatedAt: (string|null), sessions: Object[], error: (string|null), path: string, scan: (Object|null)}} 索引结果。
 */
function loadSessionIndex(layout) {
  const filePath = layout.sessionsIndexPath;
  // F04：索引入口同样做真实目标边界检查（阻断 sessions.json 链接到根外受保护文件）。
  const safe = paths.assertSafeReadPath(filePath, layout.sessionIndexRoot);
  if (!safe.ok) {
    return degradeToScan(layout, filePath, safe.reason);
  }
  let raw;
  try {
    raw = fs.readFileSync(safe.resolved || filePath, 'utf8');
  } catch (error) {
    return degradeToScan(layout, filePath, `READ_FAILED: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return degradeToScan(layout, filePath, `JSON_PARSE_ERROR: ${error.message}`);
  }
  const sessions = Array.isArray(parsed && parsed.sessions) ? parsed.sessions : [];
  return {
    ok: true,
    source: 'sessions.json',
    version: Number.isFinite(parsed && parsed.version) ? parsed.version : null,
    updatedAt: typeof (parsed && parsed.updatedAt) === 'string' ? parsed.updatedAt : null,
    sessions: sessions.filter((item) => item && typeof item.conversationId === 'string'),
    error: null,
    path: filePath,
    scan: null,
  };
}

/**
 * 索引不可用时降级为目录扫描，并保留原始错误（不掩盖、不吞掉）。
 *
 * @param {Object} layout 路径布局。
 * @param {string} filePath 索引路径。
 * @param {string} reason 索引不可用的原因。
 * @return {Object} 与 `loadSessionIndex` 同构的结果（`ok:false`, `source:'project-scan'`）。
 */
function degradeToScan(layout, filePath, reason) {
  const scan = buildIndexFromScan(layout);
  return {
    ok: false,
    source: 'project-scan',
    version: null,
    updatedAt: null,
    sessions: scan.sessions,
    error: reason,
    path: filePath,
    scan,
  };
}

/** 单次扫描最多收录的会话数（防超大部署拖慢列举）。 */
const SCAN_MAX_SESSIONS = 200;

/**
 * 只读扫描 `projects/<slug>/*.jsonl`，构造与 sessions.json 等价的会话条目。
 *
 * 【M2 修复】用于 Mac 等「客户端不生成 sessions.json」的部署。条目直接携带
 * `projectDir` / `filePath`，调用方**无需**再按 workDir 反推 slug（反推是有损的：
 * 真实目录名里的 `-` 与路径分隔符无法区分）。`workDir` 保持 `null` 以免给出错误值。
 *
 * 只读边界：仅 `readdir`（withFileTypes）+ `stat`，不创建、不写入、不删除。
 *
 * @param {Object} layout 路径布局。
 * @return {{sessions: Object[], projectDirs: number, scannedFiles: number, skippedInvalidIds: number, truncated: boolean}} 扫描结果。
 */
function buildIndexFromScan(layout) {
  const sessions = [];
  let projectDirs = 0;
  let scannedFiles = 0;
  let skippedInvalidIds = 0;

  const dirents = paths.safeReadDir(layout.projectsDir).filter((entry) => entry.isDirectory());
  for (const dirEntry of dirents) {
    projectDirs += 1;
    const projectDir = path.join(layout.projectsDir, dirEntry.name);
    const dirWithin = paths.assertWithinRoot(projectDir, layout.projectsDir);
    if (!dirWithin.ok) continue;

    const files = paths.safeReadDir(dirWithin.resolved)
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'));

    for (const fileEntry of files) {
      const conversationId = fileEntry.name.slice(0, -'.jsonl'.length);
      const checked = paths.validateConversationId(conversationId);
      if (!checked.ok) {
        skippedInvalidIds += 1;
        continue;
      }
      const filePath = path.join(projectDir, fileEntry.name);
      // 索引来源也走真实目标边界检查（阻断项目目录 / 文件被链接到根外）。
      const fileWithin = paths.assertWithinRoot(filePath, layout.projectsDir);
      if (!fileWithin.ok) continue;
      let stats;
      try {
        stats = fs.statSync(fileWithin.resolved);
      } catch (_error) {
        continue;
      }
      if (!stats.isFile()) continue;

      scannedFiles += 1;
      const lastActivityAt = new Date(stats.mtimeMs).toISOString();
      sessions.push({
        conversationId: checked.value,
        workDir: null,
        workDirSource: 'unknown',
        slug: dirEntry.name,
        projectDir,
        filePath,
        startedAt: Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
          ? new Date(stats.birthtimeMs).toISOString()
          : null,
        resumedAt: lastActivityAt,
        lastActivityAt,
        source: 'project-scan',
      });
    }
  }

  sessions.sort((a, b) => String(b.resumedAt || '').localeCompare(String(a.resumedAt || '')));
  const truncated = sessions.length > SCAN_MAX_SESSIONS;
  return {
    sessions: truncated ? sessions.slice(0, SCAN_MAX_SESSIONS) : sessions,
    projectDirs,
    scannedFiles,
    skippedInvalidIds,
    truncated,
  };
}

/**
 * 由工作目录推导项目目录与会话文件路径。
 *
 * @param {string} workDir 会话工作目录。
 * @param {string} conversationId 会话 ID。
 * @param {Object} layout 路径布局。
 * @return {{projectDir: string, filePath: string, slug: string}} 路径三元组。
 * @throws {AppError} conversationId / workDir 非法或路径越界时抛出。
 */
function resolveSessionFile(workDir, conversationId, layout) {
  const checked = paths.validateConversationId(conversationId);
  if (!checked.ok) {
    throw new AppError(
      'INVALID_CONVERSATION_ID',
      `conversationId 非法（仅允许 [A-Za-z0-9._-]、不得含路径分隔符 / ".." / Windows 设备名）: reason=${checked.reason}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { conversationId: String(conversationId).slice(0, 120), reason: checked.reason, expected: 'safe-id' },
    );
  }
  const id = checked.value;

  const workDirChecked = paths.validateWorkDir(workDir);
  if (!workDirChecked.ok && typeof workDir === 'string' && workDir.trim().length > 0) {
    throw new AppError(
      'INVALID_WORKDIR',
      `workDir 非法（含 NUL/控制字符或超长）: reason=${workDirChecked.reason}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { reason: workDirChecked.reason },
    );
  }
  const slug = paths.slugifyPath(workDirChecked.value || '');
  if (!slug) return { projectDir: '', filePath: '', slug: '' };

  const projectDir = path.join(layout.projectsDir, slug);
  const filePath = path.join(projectDir, `${id}.jsonl`);

  // F04：真实目标必须仍在 projects 根内，且真实 basename 非受保护文件（阻断链接别名）。
  const contained = paths.assertWithinRoot(filePath, layout.projectsDir);
  if (!contained.ok) {
    throw new AppError(
      'PATH_OUT_OF_ROOT',
      `解析后的路径越出允许目录: ${contained.resolved}（${contained.reason}）`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { resolved: contained.resolved, projectsDir: layout.projectsDir, reason: contained.reason },
    );
  }
  return { projectDir, filePath, slug };
}

/**
 * 在项目目录树中通过 conversationId 反查 jsonl 文件（索引缺项时的兜底）。
 *
 * @param {string} conversationId 会话 ID。
 * @param {Object} layout 路径布局。
 * @return {{filePath: (string|null), projectDir: (string|null), workDir: (string|null), via: string}} 反查结果。
 */
function findSessionByScan(conversationId, layout) {
  const checked = paths.validateConversationId(conversationId);
  if (!checked.ok) return { filePath: null, projectDir: null, workDir: null, via: 'invalid-id' };
  const wanted = `${checked.value}.jsonl`;
  for (const entry of paths.safeReadDir(layout.projectsDir)) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(layout.projectsDir, entry.name);
    const candidate = path.join(projectDir, wanted);
    // F04：真实目标边界 + 受保护清单（阻断项目目录链接 / 文件链接别名）。
    const within = paths.assertWithinRoot(candidate, layout.projectsDir);
    if (!within.ok) continue;
    let stats;
    try {
      stats = fs.statSync(within.resolved);
    } catch (_error) {
      continue;
    }
    if (!stats.isFile()) continue;
    return { filePath: candidate, projectDir, workDir: null, via: 'project-scan' };
  }
  return { filePath: null, projectDir: null, workDir: null, via: 'not-found' };
}

/**
 * 把一个索引条目解析为「确实存在的会话文件」。
 *
 * 【M2 修复】统一三层解析顺序，消除各处重复且口径不一的兜底逻辑：
 *   1. 条目自带 `filePath`（`project-scan` 来源直接携带真实路径，无需反推 slug）；
 *   2. `sessions.json` 的 `workDir` → slug → `projects/<slug>/<id>.jsonl`；
 *   3. 全项目目录按 `conversationId` 扫描反查。
 *
 * 任一层都可能失败，**失败即进入下一层**，最终返回 `filePath: null`（调用方决定如何上报）。
 *
 * @param {Object} entry 索引条目。
 * @param {Object} layout 路径布局。
 * @return {{projectDir: string, filePath: (string|null), via: string}} 解析结果。
 */
function resolveEntryFile(entry, layout) {
  if (entry && typeof entry.filePath === 'string' && entry.filePath) {
    const within = paths.assertWithinRoot(entry.filePath, layout.projectsDir);
    if (within.ok) {
      try {
        if (fs.statSync(within.resolved).isFile()) {
          return {
            projectDir: typeof entry.projectDir === 'string' && entry.projectDir ? entry.projectDir : path.dirname(entry.filePath),
            filePath: entry.filePath,
            via: 'project-scan',
          };
        }
      } catch (_error) {
        /* 落到下一层 */
      }
    }
  }

  try {
    const resolved = resolveSessionFile(entry.workDir, entry.conversationId, layout);
    if (resolved.filePath && fs.existsSync(resolved.filePath)) {
      return { projectDir: resolved.projectDir, filePath: resolved.filePath, via: 'sessions.json' };
    }
  } catch (_error) {
    /* 落到下一层 */
  }

  const scanned = findSessionByScan(entry.conversationId, layout);
  if (scanned.filePath) {
    return { projectDir: scanned.projectDir, filePath: scanned.filePath, via: scanned.via };
  }
  return { projectDir: '', filePath: null, via: 'not-found' };
}

/**
 * 解析一个会话 ID 到可读的会话上下文（含索引元信息）。
 *
 * @param {string} conversationId 会话 ID。
 * @param {Object} layout 路径布局。
 * @param {Object} index sessions.json 解析结果。
 * @return {Object} 会话上下文。
 * @throws {AppError} 会话不存在或 ID 非法时抛出。
 */
function resolveSession(conversationId, layout, index) {
  const checked = paths.validateConversationId(conversationId);
  if (!checked.ok) {
    throw new AppError(
      'INVALID_CONVERSATION_ID',
      `conversationId 非法（仅允许 [A-Za-z0-9._-]、不得含路径分隔符或 ".."）: reason=${checked.reason}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { conversationId: String(conversationId).slice(0, 120), reason: checked.reason, expected: 'safe-id' },
    );
  }
  const id = checked.value;

  const entry = index.sessions.find((item) => item.conversationId === id);
  if (entry) {
    const resolved = resolveEntryFile(entry, layout);
    if (resolved.filePath) {
      return {
        conversationId: id,
        workDir: typeof entry.workDir === 'string' ? entry.workDir : null,
        workDirSource: entry.workDirSource || (typeof entry.workDir === 'string' ? 'index' : 'unknown'),
        projectDir: resolved.projectDir,
        filePath: resolved.filePath,
        via: resolved.via,
        startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : null,
        resumedAt: typeof entry.resumedAt === 'string' ? entry.resumedAt : null,
      };
    }
  }

  const scanned = findSessionByScan(id, layout);
  if (scanned.filePath) {
    return {
      conversationId: id,
      workDir: scanned.workDir,
      workDirSource: 'unknown',
      projectDir: scanned.projectDir,
      filePath: scanned.filePath,
      via: scanned.via,
      startedAt: entry && typeof entry.startedAt === 'string' ? entry.startedAt : null,
      resumedAt: entry && typeof entry.resumedAt === 'string' ? entry.resumedAt : null,
    };
  }

  throw new AppError(
    'SESSION_NOT_FOUND',
    `未找到会话 ${id}：sessions.json 与项目目录扫描均未命中`,
    JSONRPC_ERRORS.INVALID_PARAMS,
    { conversationId: id, projectsDir: layout.projectsDir, indexSize: index.sessions.length, indexSource: index.source || null },
  );
}

/**
 * 列举会话：合并 sessions.json 元信息与 jsonl 行数统计。
 *
 * @param {{limit?: number, workDir?: string, includeCounts?: boolean}} params 过滤参数。
 * @param {Object} layout 路径布局。
 * @return {Object} 列举结果。
 */
function listSessions(params, layout) {
  const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : DEFAULT_LIST_LIMIT;
  const includeCounts = params.includeCounts !== false;
  const index = loadSessionIndex(layout);

  let entries = index.sessions.slice();
  if (typeof params.workDir === 'string' && params.workDir.trim().length > 0) {
    const needle = params.workDir.trim().toLowerCase();
    // 扫描来源的条目没有 workDir（无法无损反推），改用 slug 比对，保证 Mac 上按工作目录过滤仍可用。
    const needleSlug = paths.slugifyPath(params.workDir.trim()).toLowerCase();
    entries = entries.filter((item) => {
      if (typeof item.workDir === 'string' && item.workDir.toLowerCase() === needle) return true;
      return typeof item.slug === 'string' && item.slug.toLowerCase() === needleSlug;
    });
  }
  entries.sort((a, b) => String(b.resumedAt || b.startedAt || '').localeCompare(String(a.resumedAt || a.startedAt || '')));

  const sliced = entries.slice(0, limit);
  let invalidIds = 0;
  const sessions = sliced.map((entry) => {
    let resolved;
    try {
      resolved = resolveEntryFile(entry, layout);
    } catch (_error) {
      invalidIds += 1;
      resolved = { projectDir: '', filePath: null, via: 'invalid' };
    }
    const exists = Boolean(resolved.filePath) && fs.existsSync(resolved.filePath);
    const stats = includeCounts && exists ? jsonl.countLines(resolved.filePath) : { count: 0, estimated: false, sizeBytes: 0 };
    let lastActivityAt = entry.lastActivityAt || entry.resumedAt || entry.startedAt || null;
    if (exists) {
      try {
        lastActivityAt = new Date(fs.statSync(resolved.filePath).mtimeMs).toISOString();
      } catch (_error) {
        /* 保持索引中的时间戳 */
      }
    }
    return {
      conversationId: entry.conversationId,
      workDir: typeof entry.workDir === 'string' ? entry.workDir : null,
      workDirSource: entry.workDirSource || (typeof entry.workDir === 'string' ? 'index' : 'unknown'),
      startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : null,
      resumedAt: typeof entry.resumedAt === 'string' ? entry.resumedAt : null,
      messageCount: stats.count,
      messageCountEstimated: stats.estimated,
      sizeBytes: stats.sizeBytes,
      lastActivityAt,
      projectDir: resolved.projectDir,
      filePath: resolved.filePath,
      resolvedVia: resolved.via,
      fileExists: exists,
    };
  });

  return {
    indexReadable: index.ok,
    indexSource: index.source || (index.ok ? 'sessions.json' : 'unknown'),
    indexPath: index.path,
    indexError: index.error,
    indexVersion: index.version,
    indexUpdatedAt: index.updatedAt,
    indexFallback: index.scan
      ? {
        reason: 'sessions.json 不可读，已降级为 projects/ 目录扫描',
        projectDirs: index.scan.projectDirs,
        scannedFiles: index.scan.scannedFiles,
        truncated: index.scan.truncated,
        note: '扫描条目的 workDir 无法从目录名无损反推，故 workDir=null、workDirSource="unknown"；projectDir/filePath 为真实路径。',
      }
      : null,
    totalInIndex: index.sessions.length,
    returned: sessions.length,
    limit,
    skippedInvalidIds: invalidIds,
    countMode: includeCounts
      ? 'exact (file <= 4MB) 或尾部采样估算'
      : 'skipped (includeCounts=false)',
    sessions,
  };
}

/**
 * 读取单个会话的消息列表。
 *
 * @param {string} conversationId 会话 ID。
 * @param {Object} options 读取选项。
 * @param {Object} layout 路径布局。
 * @return {Object} 会话消息负载。
 */
function readSession(conversationId, options, layout) {
  const maxMessages = Number.isFinite(options.maxMessages) && options.maxMessages > 0 ? Math.floor(options.maxMessages) : 40;
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : jsonl.DEFAULT_MAX_CHARS;
  const includeSystemReminders = options.includeSystemReminders === true;
  const includeSubagents = options.includeSubagents === true;

  const index = loadSessionIndex(layout);
  const session = resolveSession(conversationId, layout, index);

  const readOptions = { includeSystemReminders, maxChars };
  const parsed = jsonl.readRecords(session.filePath);
  const messages = [];
  let removedReminders = 0;
  for (const record of parsed.records) {
    const message = jsonl.toMessage(record.value, readOptions);
    if (!message) continue;
    message.index = record.index;
    if (message.hadSystemReminder) removedReminders += 1;
    messages.push(message);
  }

  const truncatedTail = messages.length > maxMessages;
  const visible = truncatedTail ? messages.slice(messages.length - maxMessages) : messages;

  const payload = {
    conversationId: session.conversationId,
    workDir: session.workDir,
    projectDir: session.projectDir,
    filePath: session.filePath,
    resolvedVia: session.via,
    startedAt: session.startedAt,
    resumedAt: session.resumedAt,
    totalMessages: messages.length,
    returnedMessages: visible.length,
    maxMessages,
    maxChars,
    includeSystemReminders,
    truncatedTail,
    skipped: parsed.skipped,
    removedSystemReminderMessages: removedReminders,
    fileBytes: parsed.bytesRead,
    partialFirstLine: parsed.partialFirstLine,
    messages: visible,
    subagents: includeSubagents ? readSubagents(session, readOptions, layout) : null,
    notes: [
      '会话文件由 WorkBuddy 持续追加写入，末行可能是半截 JSON，已计入 skipped。',
      includeSystemReminders
        ? 'includeSystemReminders=true：<system-reminder> 系统附加块原文返回，体积可能很大。'
        : 'includeSystemReminders=false（默认）：已剥离 <system-reminder> 系统附加块。',
      'truncatedTail=true 时仅返回末尾 maxMessages 条消息。',
    ],
  };
  return payload;
}

/**
 * 读取会话下的子代理记录。
 *
 * F04：subagents 目录与其下文件都经过真实目标边界检查；越界/链接别名直接跳过。
 *
 * @param {{conversationId: string, projectDir: string}} session 会话上下文。
 * @param {{includeSystemReminders: boolean, maxChars: number}} readOptions 文本选项。
 * @param {Object} layout 路径布局。
 * @return {Array<Object>} 子代理摘要列表。
 */
function readSubagents(session, readOptions, layout) {
  if (!session.projectDir) return [];
  const subagentsDir = path.join(session.projectDir, session.conversationId, 'subagents');
  // 子代理目录必须在项目目录（进而 projects 根）之内，且真实目标未被链接到根外。
  const dirWithin = paths.assertWithinRoot(subagentsDir, layout.projectsDir);
  if (!dirWithin.ok) return [];
  const dirents = paths.safeReadDir(dirWithin.resolved).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
  const results = [];
  for (const entry of dirents) {
    const filePath = path.join(dirWithin.resolved, entry.name);
    const fileWithin = paths.assertWithinRoot(filePath, layout.projectsDir);
    if (!fileWithin.ok) continue;
    let stats = null;
    try {
      stats = fs.statSync(fileWithin.resolved);
    } catch (_error) {
      continue;
    }
    if (!stats.isFile()) continue;
    const parsed = jsonl.readRecords(fileWithin.resolved);
    let firstText = null;
    let count = 0;
    for (const record of parsed.records) {
      const message = jsonl.toMessage(record.value, readOptions);
      if (!message) continue;
      count += 1;
      if (firstText === null && message.text) firstText = message.text.slice(0, 400);
    }
    results.push({
      agentId: entry.name.replace(/\.jsonl$/i, ''),
      filePath,
      messageCount: count,
      skipped: parsed.skipped,
      firstMessagePreview: firstText,
    });
  }
  return results;
}

/**
 * 在最近若干会话中做启发式子串搜索。
 *
 * @param {{keyword: string, limit?: number, maxSessions?: number, maxBytesPerSession?: number}} params 搜索参数。
 * @param {Object} layout 路径布局。
 * @return {Object} 搜索结果。
 */
function searchSessions(params, layout) {
  const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
  if (keyword.length === 0) {
    throw new AppError('INVALID_ARGUMENT', 'keyword 必须是非空字符串', JSONRPC_ERRORS.INVALID_PARAMS, {}, { protocolLevel: true });
  }
  const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 20;
  const maxSessions = Number.isFinite(params.maxSessions) && params.maxSessions > 0
    ? Math.floor(params.maxSessions)
    : DEFAULT_SEARCH_SESSIONS;
  const maxBytes = Number.isFinite(params.maxBytesPerSession) && params.maxBytesPerSession > 0
    ? Math.floor(params.maxBytesPerSession)
    : DEFAULT_SEARCH_BYTES_PER_SESSION;
  const needle = keyword.toLowerCase();

  const index = loadSessionIndex(layout);
  const ordered = index.sessions
    .slice()
    .sort((a, b) => String(b.resumedAt || b.startedAt || '').localeCompare(String(a.resumedAt || a.startedAt || '')))
    .slice(0, maxSessions);

  const hits = [];
  let scannedFiles = 0;
  let truncatedFiles = 0;

  for (const entry of ordered) {
    if (hits.length >= limit) break;
    let filePath = null;
    try {
      filePath = resolveEntryFile(entry, layout).filePath;
    } catch (_error) {
      continue; // 非法 conversationId / 路径越界：跳过该条。
    }
    if (!filePath) continue;
    scannedFiles += 1;
    const parsed = jsonl.readRecords(filePath, { maxBytes, tail: true });
    if (parsed.truncated) truncatedFiles += 1;

    for (const record of parsed.records) {
      if (hits.length >= limit) break;
      const message = jsonl.toMessage(record.value, { includeSystemReminders: false, maxChars: 0 });
      if (!message || !message.text) continue;
      const position = message.text.toLowerCase().indexOf(needle);
      if (position === -1) continue;
      const snippetStart = Math.max(0, position - 80);
      const snippetEnd = Math.min(message.text.length, position + keyword.length + 120);
      hits.push({
        conversationId: entry.conversationId,
        workDir: typeof entry.workDir === 'string' ? entry.workDir : null,
        messageIndex: record.index,
        role: message.role,
        time: message.time,
        snippet: `${snippetStart > 0 ? '...' : ''}${message.text.slice(snippetStart, snippetEnd)}${
          snippetEnd < message.text.length ? '...' : ''
        }`,
      });
    }
  }

  return {
    keyword,
    hits,
    hitCount: hits.length,
    limit,
    scope: {
      sessionsConsidered: ordered.length,
      filesScanned: scannedFiles,
      maxSessions,
      maxBytesPerSession: maxBytes,
      truncatedFiles,
    },
    heuristicNote:
      `启发式搜索：按 resumedAt 倒序最多扫描 ${maxSessions} 个会话，每个文件最多读取末尾 ${maxBytes} 字节，` +
      '已剥离 <system-reminder> 系统附加块。结果不保证覆盖全部历史，请配合 wb_list_sessions / wb_read_session 精读。',
    indexReadable: index.ok,
    indexSource: index.source || (index.ok ? 'sessions.json' : 'unknown'),
    indexError: index.error,
    indexFallback: index.scan
      ? {
        reason: 'sessions.json 不可读，已降级为 projects/ 目录扫描',
        scannedFiles: index.scan.scannedFiles,
        truncated: index.scan.truncated,
      }
      : null,
  };
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_SESSIONS,
  DEFAULT_SEARCH_BYTES_PER_SESSION,
  SCAN_MAX_SESSIONS,
  loadSessionIndex,
  buildIndexFromScan,
  resolveSessionFile,
  resolveEntryFile,
  resolveSession,
  listSessions,
  readSession,
  readSubagents,
  searchSessions,
};
