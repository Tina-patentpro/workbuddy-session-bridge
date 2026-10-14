'use strict';

/**
 * MCP 工具定义与分发。
 *
 * 8 个工具分三类：
 *   读取类：wb_list_sessions / wb_read_session / wb_search_sessions
 *   写入类：wb_send_instruction / wb_pending_instructions / wb_complete_instruction
 *   辅助类：wb_instruction_stats / wb_bridge_info
 *
 * 【第三方审计 F06 整改】所有参数在进入任何 store 事务之前进行**严格的类型与边界校验**：
 *   - 布尔参数只接受真正的 `true`/`false`（非空字符串 "false" 不再被 Boolean() 转成 true）；
 *   - 整数参数必须是 `Number.isInteger` 且落在声明区间内（0.5 不再被 Math.floor 归一化）；
 *   - metadata 必须是普通对象（错误类型不再被静默丢弃）；
 *   - `arguments` 必须是对象，且未知字段被拒绝（Schema 声明 additionalProperties:false）。
 *
 * 【F07 整改】参数/工具层面的错误（未知工具、类型不符）归类为**协议级错误**（-32602），
 * 由 tools/call 层抛出 JSON-RPC error；真正的执行失败（存储 IO、指令不存在等）仍用 isError 结果。
 */

const paths = require('./paths');
const sessions = require('./sessions');
const { InstructionStore, STATUSES, PRIORITIES } = require('./store');
const { AppError, JSONRPC_ERRORS } = require('./protocol');

/** 本连接器版本号（与 README / package.json 保持一致）。 */
const BRIDGE_VERSION = '1.0.0';
const BRIDGE_NAME = 'workbuddy-session-bridge';

/** 参数校验错误统一标记：协议级错误，作为 JSON-RPC error 返回。 */
const ARG_ERROR_OPTIONS = Object.freeze({ protocolLevel: true });

/** 各整数参数的合法区间（[min, max]）。 */
const INT_BOUNDS = Object.freeze({
  limit: { min: 1, max: 1000 },
  maxMessages: { min: 1, max: 100000 },
  maxChars: { min: 1, max: 10000000 },
  maxSessions: { min: 1, max: 1000 },
  maxBytesPerSession: { min: 1, max: 64 * 1024 * 1024 },
});

/**
 * 能力边界声明：写入侧只能投递队列，不能直接驱动 WorkBuddy 会话。
 *
 * 原因：WorkBuddy 桌面端的 sendPrompt / runPrompt 通过 Electron 渲染进程内的
 * postMessage({type:'wb:invoke:request'}) bridge 暴露，外部进程无法触达。
 */
const CAPABILITY_BOUNDARY = Object.freeze({
  canRead: true,
  canWrite: 'queue-only',
  canDriveWorkBuddySessionDirectly: false,
  summary: '读取 WorkBuddy 本机会话的对话输出；写入侧仅为「指令队列投递」，不是直接控制 WorkBuddy 会话。',
  reasons: [
    'WorkBuddy 的 sendPrompt / runPrompt 属于 Electron 渲染进程内 postMessage RPC（bridgeAuto），外部进程不可调用。',
    '本连接器不改动、不修改 WorkBuddy 进程，也不读写 workbuddy.db 等运行时状态文件。',
    '外部 agent 投递指令后，需由 WorkBuddy 内的 agent（或用户）用 wb_pending_instructions 取件并执行，再用 wb_complete_instruction 回填结果。',
  ],
});

/**
 * 把内部负载包装为 MCP 工具结果。
 *
 * @param {unknown} payload 业务负载。
 * @return {{content: Array<{type: string, text: string}>}} MCP 工具结果。
 */
function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * 把异常包装为 MCP 工具错误结果（isError + 结构化 error）。
 *
 * @param {unknown} error 异常。
 * @return {{isError: true, content: Array<{type: string, text: string}>}} MCP 错误结果。
 */
function fail(error) {
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const message = error && error.message ? error.message : String(error);
  const details = error instanceof AppError ? error.details : {};
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
  };
}

/**
 * 判断是否为普通对象（非 null、非数组）。
 *
 * @param {unknown} value 待判定值。
 * @return {boolean} 是否普通对象。
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 描述一个值的类型（用于错误信息）。
 *
 * @param {unknown} value 值。
 * @return {string} 类型描述。
 */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 校验 `arguments` 容器必须是对象。
 *
 * @param {unknown} args 参数容器。
 * @return {Object} 参数对象。
 * @throws {AppError} 非对象时抛出（协议级）。
 */
function assertArgsObject(args) {
  if (!isPlainObject(args)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `tools/call 的 arguments 必须是 JSON 对象，收到 ${describeValue(args)}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: describeValue(args) },
      ARG_ERROR_OPTIONS,
    );
  }
  return args;
}

/**
 * 拒绝未在 Schema 中声明的字段（additionalProperties:false）。
 *
 * @param {Object} args 参数对象。
 * @param {string[]} allowed 允许的字段名。
 * @return {void}
 * @throws {AppError} 存在未知字段时抛出（协议级）。
 */
function rejectUnknownKeys(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `包含未知参数: ${unknown.join(', ')}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { unknown, allowed },
      ARG_ERROR_OPTIONS,
    );
  }
}

/**
 * 归一化字符串参数：空串与纯空白归一化为 `fallback`。
 *
 * @param {unknown} value 原始值。
 * @param {string} name 参数名。
 * @param {string|null} [fallback] 缺省值，默认 `null`。
 * @return {string|null} 归一化结果。
 * @throws {AppError} 类型不合法时抛出（协议级）。
 */
function optionalString(value, name, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGUMENT', `${name} 必须是字符串`, JSONRPC_ERRORS.INVALID_PARAMS, { received: describeValue(value) }, ARG_ERROR_OPTIONS);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * 必填字符串参数：缺失、空串或纯空白一律拒绝。
 *
 * @param {unknown} value 原始值。
 * @param {string} name 参数名。
 * @return {string} trim 后的非空字符串。
 * @throws {AppError} 参数缺失或为空白时抛出（协议级）。
 */
function requiredString(value, name) {
  const normalized = optionalString(value, name, null);
  if (normalized === null) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${name} 必须是非空字符串`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: typeof value === 'string' ? 'blank-string' : describeValue(value) },
      ARG_ERROR_OPTIONS,
    );
  }
  return normalized;
}

/**
 * 归一化布尔参数：只接受真正的布尔值（**不再用 Boolean() 强转**）。
 *
 * @param {unknown} value 原始值。
 * @param {string} name 参数名。
 * @param {boolean} fallback 缺省值（仅当参数缺省时使用）。
 * @return {boolean} 归一化结果。
 * @throws {AppError} 值存在但非布尔时抛出（协议级）。
 */
function optionalBoolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${name} 必须是布尔值 true/false，收到 ${describeValue(value)}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: describeValue(value) },
      ARG_ERROR_OPTIONS,
    );
  }
  return value;
}

/**
 * 归一化整数参数：必须是整数且落在声明的 [min, max] 区间内。
 *
 * 【F06 整改】旧实现先判 `value > 0` 再 `Math.floor`，导致 `0.5` 被归一化为 `0`。
 * 现要求 `Number.isInteger`，分数、无穷、越界一律拒绝。
 *
 * @param {unknown} value 原始值。
 * @param {string} name 参数名。
 * @param {number} fallback 缺省值。
 * @param {{min: number, max: number}} bounds 合法区间。
 * @return {number} 归一化结果。
 * @throws {AppError} 类型/区间不合法时抛出（协议级）。
 */
function optionalInteger(value, name, fallback, bounds) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${name} 必须是整数，收到 ${describeValue(value)}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: describeValue(value) },
      ARG_ERROR_OPTIONS,
    );
  }
  if (value < bounds.min || value > bounds.max) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${name} 必须在 [${bounds.min}, ${bounds.max}] 区间内，收到 ${value}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: value, min: bounds.min, max: bounds.max },
      ARG_ERROR_OPTIONS,
    );
  }
  return value;
}

/**
 * 归一化 metadata 参数：必须是普通对象（错误类型不再被静默替换为 null）。
 *
 * @param {unknown} value 原始值。
 * @return {Object|null} metadata 或 null（缺省时）。
 * @throws {AppError} 存在但非普通对象时抛出（协议级）。
 */
function optionalMetadata(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `metadata 必须是 JSON 对象，收到 ${describeValue(value)}`,
      JSONRPC_ERRORS.INVALID_PARAMS,
      { received: describeValue(value) },
      ARG_ERROR_OPTIONS,
    );
  }
  return value;
}

/**
 * 构造全部 MCP 工具的 JSON Schema 描述。
 *
 * @return {Array<Object>} 工具定义数组。
 */
function toolDefinitions() {
  return [
    {
      name: 'wb_list_sessions',
      description:
        '列出 WorkBuddy 本机会话（只读）。数据来自 ~/.workbuddy/app/sessions.json 与 projects/<slug>/*.jsonl。' +
        'messageCount 对 <=4MB 的文件精确计数，更大的文件按尾部采样估算（messageCountEstimated=true）。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, description: `最多返回的会话数，默认 ${sessions.DEFAULT_LIST_LIMIT}` },
          workDir: { type: 'string', description: '按工作目录精确过滤（大小写不敏感）' },
          includeCounts: { type: 'boolean', description: '是否统计 jsonl 行数，默认 true' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'wb_read_session',
      description:
        '读取指定会话的消息列表（只读）。默认过滤 <system-reminder> 系统附加块并对每条文本做长度截断；' +
        '会话文件正在被追加写入，末行半截 JSON 会被跳过并计入 skipped。',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '会话 ID' },
          maxMessages: { type: 'integer', minimum: 1, description: '最多返回的消息数（取末尾），默认 40' },
          maxChars: { type: 'integer', minimum: 1, description: '每条消息文本最大字符数，默认 4000' },
          includeSystemReminders: { type: 'boolean', description: '是否保留 <system-reminder> 系统附加块，默认 false' },
          includeSubagents: { type: 'boolean', description: '是否附带 subagents 摘要，默认 false' },
        },
        required: ['conversationId'],
        additionalProperties: false,
      },
    },
    {
      name: 'wb_search_sessions',
      description:
        '在最近若干会话中做启发式子串搜索（只读）。默认只扫最近 20 个会话、每个文件最多读末尾 2MB，结果不保证全量覆盖。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词（大小写不敏感的子串）' },
          limit: { type: 'integer', minimum: 1, description: '最多返回的命中条数，默认 20' },
          maxSessions: { type: 'integer', minimum: 1, description: `最多扫描的会话数，默认 ${sessions.DEFAULT_SEARCH_SESSIONS}` },
          maxBytesPerSession: {
            type: 'integer',
            minimum: 1,
            description: `每个会话文件最多读取的尾字节数，默认 ${sessions.DEFAULT_SEARCH_BYTES_PER_SESSION}`,
          },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
    {
      name: 'wb_send_instruction',
      description:
        '向指令队列追加一条指令（写入 bridge 自己的目录）。这是「投递队列」，不是直接驱动 WorkBuddy 会话：' +
        '需由 WorkBuddy 侧调用 wb_pending_instructions 取件执行。',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '指令正文' },
          sessionId: { type: 'string', description: '可选：指定投递到哪个会话（供 WorkBuddy 侧按会话过滤取件）' },
          priority: { type: 'string', enum: [...PRIORITIES], description: '优先级，默认 normal' },
          metadata: { type: 'object', description: '可选：附加元数据，原样存储' },
        },
        required: ['instruction'],
        additionalProperties: false,
      },
    },
    {
      name: 'wb_pending_instructions',
      description:
        '拉取 status=pending 的指令（WorkBuddy 侧消费入口）。默认 markPicked=true，同时置为 picked 并写 pickedAt。' +
        '定向消费者请**在领取前**传入自己的 sessionId，勿领取后再跳过其它会话的指令。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '可选：只拉取投递给该会话的指令' },
          limit: { type: 'integer', minimum: 1, description: '最多拉取条数，默认 10' },
          markPicked: { type: 'boolean', description: '是否标记为 picked，默认 true' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'wb_complete_instruction',
      description: '回填指令执行结果，status 置为 done 或 failed。已处于终态的指令会返回 INSTRUCTION_ALREADY_FINAL。',
      inputSchema: {
        type: 'object',
        properties: {
          instructionId: { type: 'string', description: '指令 ID（wb_send_instruction 返回）' },
          result: { description: '执行结果（任意 JSON 值）' },
          status: { type: 'string', enum: ['done', 'failed'], description: '终态，默认 done' },
        },
        required: ['instructionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'wb_instruction_stats',
      description: '返回指令队列各状态计数（pending / picked / done / failed）、损坏记录数与队列根目录路径。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'wb_bridge_info',
      description:
        '返回连接器诊断信息：bridge 目录、store 根目录、sessions.json 可读性、会话总数，以及明确的能力边界说明。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

/**
 * 创建工具分发器。
 *
 * @return {{definitions: Array<Object>, dispatch: function(string, Object): Promise<Object>, store: InstructionStore, layout: Object}} 分发器。
 */
function createToolRegistry() {
  const layout = paths.resolveLayout();
  const store = new InstructionStore(layout);

  /**
   * 单个工具的实现体（参数已在 dispatch 前做过容器校验）。
   *
   * @type {Object<string, function(Object): Object>}
   */
  const handlers = {
    wb_list_sessions(args) {
      rejectUnknownKeys(args, ['limit', 'workDir', 'includeCounts']);
      return sessions.listSessions(
        {
          limit: optionalInteger(args.limit, 'limit', sessions.DEFAULT_LIST_LIMIT, INT_BOUNDS.limit),
          workDir: optionalString(args.workDir, 'workDir'),
          includeCounts: optionalBoolean(args.includeCounts, 'includeCounts', true),
        },
        layout,
      );
    },

    wb_read_session(args) {
      rejectUnknownKeys(args, ['conversationId', 'maxMessages', 'maxChars', 'includeSystemReminders', 'includeSubagents']);
      const conversationId = requiredString(args.conversationId, 'conversationId');
      return sessions.readSession(
        conversationId,
        {
          maxMessages: optionalInteger(args.maxMessages, 'maxMessages', 40, INT_BOUNDS.maxMessages),
          maxChars: optionalInteger(args.maxChars, 'maxChars', 4000, INT_BOUNDS.maxChars),
          includeSystemReminders: optionalBoolean(args.includeSystemReminders, 'includeSystemReminders', false),
          includeSubagents: optionalBoolean(args.includeSubagents, 'includeSubagents', false),
        },
        layout,
      );
    },

    wb_search_sessions(args) {
      rejectUnknownKeys(args, ['keyword', 'limit', 'maxSessions', 'maxBytesPerSession']);
      const keyword = requiredString(args.keyword, 'keyword');
      return sessions.searchSessions(
        {
          keyword,
          limit: optionalInteger(args.limit, 'limit', 20, INT_BOUNDS.limit),
          maxSessions: optionalInteger(args.maxSessions, 'maxSessions', sessions.DEFAULT_SEARCH_SESSIONS, INT_BOUNDS.maxSessions),
          maxBytesPerSession: optionalInteger(
            args.maxBytesPerSession,
            'maxBytesPerSession',
            sessions.DEFAULT_SEARCH_BYTES_PER_SESSION,
            INT_BOUNDS.maxBytesPerSession,
          ),
        },
        layout,
      );
    },

    wb_send_instruction(args) {
      rejectUnknownKeys(args, ['instruction', 'sessionId', 'priority', 'metadata']);
      const instruction = requiredString(args.instruction, 'instruction');
      const priority = optionalString(args.priority, 'priority', 'normal');
      if (!PRIORITIES.includes(priority)) {
        throw new AppError('INVALID_ARGUMENT', `priority 必须是 ${PRIORITIES.join(' / ')}`, JSONRPC_ERRORS.INVALID_PARAMS, {
          received: priority,
        }, ARG_ERROR_OPTIONS);
      }
      const metadata = optionalMetadata(args.metadata);
      const queued = store.enqueue({
        instruction,
        sessionId: optionalString(args.sessionId, 'sessionId'),
        priority,
        metadata,
      });
      return {
        instructionId: queued.id,
        status: 'queued',
        queueStatus: queued.queueStatus,
        createdAt: queued.createdAt,
        position: queued.position,
        queueDepth: queued.queueDepth,
        delivery: CAPABILITY_BOUNDARY.summary,
        nextStep: 'WorkBuddy 侧调用 wb_pending_instructions 取件执行，完成后调用 wb_complete_instruction 回填。',
      };
    },

    wb_pending_instructions(args) {
      rejectUnknownKeys(args, ['sessionId', 'limit', 'markPicked']);
      return store.takePending({
        sessionId: optionalString(args.sessionId, 'sessionId'),
        limit: optionalInteger(args.limit, 'limit', 10, INT_BOUNDS.limit),
        markPicked: optionalBoolean(args.markPicked, 'markPicked', true),
      });
    },

    wb_complete_instruction(args) {
      rejectUnknownKeys(args, ['instructionId', 'result', 'status']);
      const instructionId = requiredString(args.instructionId, 'instructionId');
      const status = optionalString(args.status, 'status', 'done');
      if (!['done', 'failed'].includes(status)) {
        throw new AppError('INVALID_ARGUMENT', 'status 必须是 done 或 failed', JSONRPC_ERRORS.INVALID_PARAMS, {
          received: status,
        }, ARG_ERROR_OPTIONS);
      }
      return store.complete({ instructionId, result: args.result, status });
    },

    wb_instruction_stats(args) {
      rejectUnknownKeys(args, []);
      return { ...store.stats(), validStatuses: [...STATUSES] };
    },

    wb_bridge_info(args) {
      rejectUnknownKeys(args, []);
      const index = sessions.loadSessionIndex(layout);
      const projectDirs = paths.safeReadDir(layout.projectsDir).filter((entry) => entry.isDirectory()).length;
      return {
        name: BRIDGE_NAME,
        version: BRIDGE_VERSION,
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        paths: {
          homeDir: layout.homeDir,
          workbuddyDir: layout.workbuddyDir,
          projectsDir: layout.projectsDir,
          sessionsIndexPath: layout.sessionsIndexPath,
          bridgeDir: layout.bridgeDir,
          storeRoot: layout.storeRoot,
        },
        pathSources: layout.sources,
        sandboxed: layout.sandboxed,
        readAccess: {
          sessionsIndexReadable: index.ok,
          sessionsIndexError: index.error,
          sessionCount: index.sessions.length,
          projectDirCount: projectDirs,
          forbiddenFiles: [...paths.FORBIDDEN_BASENAMES],
        },
        capabilityBoundary: CAPABILITY_BOUNDARY,
        tools: toolDefinitions().map((tool) => tool.name),
      };
    },
  };

  // 用 Map 分发表，杜绝 `toString` / `constructor` / `__proto__` 等原型链属性被分发。
  const handlerMap = new Map(Object.entries(handlers));

  return {
    definitions: toolDefinitions(),
    store,
    layout,
    /**
     * 工具分发。
     *
     * @param {string} name 工具名。
     * @param {Object} args 参数对象。
     * @return {Promise<Object>} MCP 工具结果。
     * @throws {AppError} 协议级错误（未知工具 / 参数不合法）时抛出，由 tools/call 转成 JSON-RPC error。
     */
    async dispatch(name, args) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new AppError('INVALID_PARAMS', 'tools/call 缺少 name', JSONRPC_ERRORS.INVALID_PARAMS, {}, ARG_ERROR_OPTIONS);
      }
      const handler = handlerMap.get(name);
      if (typeof handler !== 'function') {
        throw new AppError('UNKNOWN_TOOL', `未知工具: ${name}`, JSONRPC_ERRORS.INVALID_PARAMS, { tool: name }, ARG_ERROR_OPTIONS);
      }
      const normalizedArgs = assertArgsObject(args);
      try {
        return ok(handler(normalizedArgs));
      } catch (error) {
        // 协议级错误（参数/工具）向上抛出 -> JSON-RPC error；执行级错误 -> 工具 isError。
        if (error instanceof AppError && error.protocolLevel) throw error;
        return fail(error);
      }
    },
  };
}

module.exports = { BRIDGE_NAME, BRIDGE_VERSION, CAPABILITY_BOUNDARY, toolDefinitions, createToolRegistry };
