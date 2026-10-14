'use strict';

/**
 * JSONL 会话文件读取。
 *
 * WorkBuddy 会话文件（`<conversationId>.jsonl`）正被客户端持续追加写入，
 * 因此读取必须容忍「最后一行是半截 JSON」的情况：解析失败的行被跳过并计入
 * `skipped`，绝不抛出致命异常。
 *
 * 【第三方审计整改】
 *   - F13：`<system-reminder>` 剥离改为「先自闭合、再成对、后未闭合尾块」的顺序，
 *          避免自闭合标签被当成成对块的开标签而吞掉中间业务文本。
 *   - F08：尾读起点恰好在完整行边界时不再误丢第一行（按起点**前一个字节**判定截断）。
 *   - F11：越界数值时间戳不再中断整份读取（保留消息、`time=null`）。
 */

const fs = require('fs');

/** 单条消息文本的默认最大长度。 */
const DEFAULT_MAX_CHARS = 4000;

/** 换行字节。 */
const LF = 0x0a;

/** Date 可表示的最大毫秒值（±8.64e15，即 ±100,000,000 天）。 */
const MAX_DATE_MS = 8.64e15;

/** 需要从文本中剔除的系统附加块（体积巨大且与业务无关）。 */
const SYSTEM_REMINDER_BLOCK = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_REMINDER_SELF_CLOSING = /<system-reminder\b[^>]*\/>/gi;
const SYSTEM_REMINDER_UNCLOSED = /<system-reminder\b[^>]*>[\s\S]*$/i;

/**
 * 判断一行是否为可解析的 JSON 对象。
 *
 * @param {string} line 原始行文本。
 * @return {{ok: boolean, value: (Object|null), error: (string|null)}} 解析结果。
 */
function parseLine(line) {
  const text = line.trim();
  if (text.length === 0) return { ok: true, value: null, error: null };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') {
      return { ok: false, value: null, error: 'NOT_AN_OBJECT' };
    }
    return { ok: true, value, error: null };
  } catch (_error) {
    return { ok: false, value: null, error: 'JSON_PARSE_ERROR' };
  }
}

/**
 * 从消息的 `content` 字段中提取纯文本，兼容多种 content 形态。
 *
 * @param {unknown} content 原始 content 字段。
 * @return {string} 拼接后的文本；无可提取内容时为空字符串。
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => extractText(part)).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';

  const parts = [];
  if (typeof content.text === 'string') parts.push(content.text);
  if (Array.isArray(content.content)) {
    const nested = extractText(content.content);
    if (nested) parts.push(nested);
  }
  return parts.join('\n');
}

/**
 * 去除文本中的 `<system-reminder>` 系统附加块。
 *
 * 【F13 整改】处理顺序至关重要：必须**先**剥离自闭合块，**再**剥离成对块，**最后**剥离未闭合尾块。
 * 旧实现先跑成对块正则，其开标签表达式 `<system-reminder\b[^>]*>` 也会匹配自闭合标签
 * `<system-reminder/>`（`/` 不被 `[^>]` 排除），于是从第一个自闭合标签一路贪婪匹配到后面
 * 成对块的 `</system-reminder>`，把之间的业务文本一并吞掉。
 *
 * 例：`A<system-reminder/>KEEP<system-reminder>HIDDEN</system-reminder>B`
 *   -> 期望 `AKEEPB`；旧实现得到 `AB`。
 *
 * @param {string} text 原始文本。
 * @return {{text: string, removed: boolean}} 清洗结果。
 */
function stripSystemReminders(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: '', removed: false };
  let cleaned = text;
  let removed = false;
  // 顺序不可调换：自闭合 → 成对 → 未闭合尾块。
  const patterns = [SYSTEM_REMINDER_SELF_CLOSING, SYSTEM_REMINDER_BLOCK, SYSTEM_REMINDER_UNCLOSED];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) {
      removed = true;
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, '');
    }
  }
  return { text: cleaned.trim(), removed };
}

/**
 * 按最大字符数截断文本，并标记是否发生截断。
 *
 * @param {string} text 原始文本。
 * @param {number} maxChars 上限；<=0 表示不限制。
 * @return {{text: string, truncated: boolean, originalLength: number}} 截断结果。
 */
function truncateText(text, maxChars) {
  const original = typeof text === 'string' ? text : '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (limit === 0 || original.length <= limit) {
    return { text: original, truncated: false, originalLength: original.length };
  }
  return {
    text: `${original.slice(0, limit)}\n...[truncated ${original.length - limit} chars]`,
    truncated: true,
    originalLength: original.length,
  };
}

/**
 * 从文件尾部读取最多 `maxBytes` 字节并切分为非空行。
 *
 * 【F08 整改】是否丢弃「第一行残片」取决于采样窗口起点**前一个字节**是否为换行：
 *   - 若 `start > 0` 且第 `start-1` 字节不是 `\n`，则窗口从一行中间开始，首段确为残片 → 丢弃；
 *   - 若第 `start-1` 字节恰为 `\n`，则窗口起点落在完整行起点，首段是**完整行** → 保留。
 * 旧实现只看 `start > 0`，导致起点恰在行边界时静默丢弃一条完整记录。
 * 同时返回 `readSync` **实际**读取的字节数（而非请求值）。
 *
 * @param {string} filePath 文件路径。
 * @param {number} maxBytes 最多读取的尾字节数。
 * @return {{lines: string[], partialFirstLine: boolean, bytesRead: number}} 读取结果。
 */
function readTailLines(filePath, maxBytes) {
  const stats = fs.statSync(filePath);
  const total = stats.size;
  const readBytes = Math.max(0, Math.min(total, Math.floor(maxBytes)));
  const start = total - readBytes;

  const fd = fs.openSync(filePath, 'r');
  let actualBytes = 0;
  let boundaryIncomplete = false;
  let text = '';
  try {
    if (readBytes > 0) {
      const buffer = Buffer.alloc(readBytes);
      actualBytes = fs.readSync(fd, buffer, 0, readBytes, start);
      if (start > 0) {
        // 探针：读取起点前一个字节，判断窗口是否从行中间开始。
        const probe = Buffer.alloc(1);
        const probed = fs.readSync(fd, probe, 0, 1, start - 1);
        boundaryIncomplete = probed === 1 && probe[0] !== LF;
      }
      text = buffer.toString('utf8', 0, actualBytes);
    }
  } finally {
    fs.closeSync(fd);
  }

  let segments = text.split('\n');
  if (boundaryIncomplete) segments = segments.slice(1); // 只丢真正被切断的首行残片
  const lines = segments.filter((line) => line.trim().length > 0);
  return { lines, partialFirstLine: boundaryIncomplete, bytesRead: actualBytes };
}

/**
 * 顺序读取 JSONL 文件中的全部记录（可限制读取字节数）。
 *
 * @param {string} filePath 文件路径。
 * @param {{maxBytes?: (number|undefined), tail?: boolean}} [options] 读取选项。
 * @return {{
 *   records: Array<{index: number, value: (Object|null), error: (string|null)}>,
 *   skipped: number, totalLines: number, bytesRead: number,
 *   truncated: boolean, partialFirstLine: boolean
 * }} 读取结果。
 */
function readRecords(filePath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 0;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return {
      records: [],
      skipped: 0,
      totalLines: 0,
      bytesRead: 0,
      truncated: false,
      partialFirstLine: false,
    };
  }

  let effectiveLines;
  let bytesRead = stats.size;
  let truncated = false;
  let partialFirstLine = false;

  if (maxBytes > 0 && stats.size > maxBytes) {
    const tailResult = readTailLines(filePath, maxBytes);
    // readTailLines 已剔除被切断的首行残片，这里不再二次 slice。
    effectiveLines = tailResult.lines;
    bytesRead = tailResult.bytesRead;
    partialFirstLine = tailResult.partialFirstLine;
    truncated = true;
  } else {
    const raw = fs.readFileSync(filePath, 'utf8');
    effectiveLines = raw.split('\n').filter((line) => line.trim().length > 0);
    bytesRead = Buffer.byteLength(raw, 'utf8');
  }

  const records = [];
  let skipped = 0;
  effectiveLines.forEach((line, offset) => {
    const index = partialFirstLine ? offset + 1 : offset;
    const parsed = parseLine(line);
    if (!parsed.ok) {
      skipped += 1;
      return;
    }
    if (parsed.value === null) return;
    records.push({ index, value: parsed.value, error: null });
  });

  return { records, skipped, totalLines: effectiveLines.length, bytesRead, truncated, partialFirstLine };
}

/**
 * 把数值时间戳规范为 ISO 字符串；无效/越界值返回 null（不抛异常）。
 *
 * 【F11 整改】旧实现直接 `new Date(timestamp).toISOString()`，当 timestamp 是数值但
 * 超出 Date 有效范围（如 `1e100`）时会抛 `RangeError: Invalid time value`，
 * 该异常被工具层整体捕获，导致**整份会话读取失败**、其它正常消息也不可见。
 * 现改为：先校验有限且 `|ts| <= 8.64e15`，再转换并兜底 `NaN`。
 *
 * @param {unknown} timestamp 原始时间戳。
 * @return {(string|null)} ISO 字符串或 null。
 */
function toIsoTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) {
    return null;
  }
  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  try {
    return date.toISOString();
  } catch (_error) {
    return null;
  }
}

/**
 * 把一条 JSONL 记录转换为统一的消息结构；非消息记录返回 null。
 *
 * @param {Object} value 已解析的记录。
 * @param {{includeSystemReminders: boolean, maxChars: number}} options 转换选项。
 * @return {{
 *   index: number, role: string, text: string, timestamp: (number|null),
 *   time: (string|null), timeInvalid: boolean, id: (string|null), textLength: number,
 *   truncated: boolean, hadSystemReminder: boolean
 * }|null} 消息或 null。
 */
function toMessage(value, options) {
  const includeSystemReminders = Boolean(options.includeSystemReminders);
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;

  if (!value || value.type !== 'message') return null;
  const role = typeof value.role === 'string' ? value.role : 'unknown';

  const rawText = extractText(value.content);
  const stripped = includeSystemReminders
    ? { text: rawText.trim(), removed: false }
    : stripSystemReminders(rawText);
  const truncatedResult = truncateText(stripped.text, maxChars);

  const timestamp = typeof value.timestamp === 'number' ? value.timestamp : null;
  const time = toIsoTime(timestamp);
  return {
    index: 0,
    role,
    text: truncatedResult.text,
    timestamp,
    time,
    timeInvalid: timestamp !== null && time === null,
    id: typeof value.id === 'string' ? value.id : null,
    textLength: truncatedResult.originalLength,
    truncated: truncatedResult.truncated,
    hadSystemReminder: stripped.removed,
  };
}

/**
 * 统计 JSONL 文件的行数。文件较大时只采样尾部并按比例估算。
 *
 * @param {string} filePath 文件路径。
 * @param {{exactLimitBytes?: number, sampleBytes?: number}} [options] 统计选项。
 * @return {{count: number, estimated: boolean, bytesRead: number, sizeBytes: number}} 统计结果。
 */
function countLines(filePath, options = {}) {
  const exactLimitBytes = Number.isFinite(options.exactLimitBytes) ? options.exactLimitBytes : 4 * 1024 * 1024;
  const sampleBytes = Number.isFinite(options.sampleBytes) ? options.sampleBytes : 512 * 1024;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (_error) {
    return { count: 0, estimated: false, bytesRead: 0, sizeBytes: 0 };
  }

  if (stats.size === 0) return { count: 0, estimated: false, bytesRead: 0, sizeBytes: 0 };

  if (stats.size <= exactLimitBytes) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const count = raw.split('\n').filter((line) => line.trim().length > 0).length;
    return { count, estimated: false, bytesRead: stats.size, sizeBytes: stats.size };
  }

  // 大文件：采样尾部，用平均行长外推总行数（readTailLines 已剔除残行）。
  const tailResult = readTailLines(filePath, sampleBytes);
  const sampledLines = tailResult.lines.length;
  const avgBytes = sampledLines > 0 ? tailResult.bytesRead / sampledLines : 0;
  const estimate = avgBytes > 0 ? Math.round(stats.size / avgBytes) : stats.size;
  return { count: estimate, estimated: true, bytesRead: tailResult.bytesRead, sizeBytes: stats.size };
}

module.exports = {
  DEFAULT_MAX_CHARS,
  MAX_DATE_MS,
  parseLine,
  extractText,
  stripSystemReminders,
  truncateText,
  readTailLines,
  readRecords,
  toIsoTime,
  toMessage,
  countLines,
};
