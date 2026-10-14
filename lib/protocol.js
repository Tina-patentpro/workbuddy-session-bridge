'use strict';

/**
 * MCP stdio 传输层：换行分隔的 JSON-RPC 2.0。
 *
 * MCP stdio 的线格式非常朴素：每个 JSON-RPC 消息独占一行，行内不含换行符。
 * 本模块负责：读行 -> 校验信封 -> 分发 -> 写行；并统一错误码与结构化异常。
 *
 * 【第三方审计 F07 整改】
 *   1. 先验证 JSON-RPC 信封（jsonrpc === "2.0"、id 类型、method、params 结构），
 *      再判断是否为「合法通知」；非法无 id 请求也必须回 -32600（id=null）。
 *   2. 分发表改为 Map（仅注册的 own 方法），杜绝 `toString` / `constructor` / `__proto__`
 *      这类原型链属性被当成方法分发。
 *   3. 协议版本协商：不认识客户端请求的版本时，回**服务端支持的版本**，绝不原样回显。
 *   4. 错误分层：协议级错误（未知方法 / 参数结构错误）走 JSON-RPC error 响应；
 *      真正的工具执行失败仍用工具结果的 isError。
 */

const readline = require('readline');

/** 本连接器实现并支持的 MCP 协议版本（按 MCP 2024-11-05 规范，不要求升级到更新版本）。 */
const PROTOCOL_VERSION = '2024-11-05';

/** 服务端支持的协议版本集合。 */
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05']);

/** JSON-RPC 2.0 标准错误码。 */
const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** 本连接器自定义的结构化错误类型。 */
class AppError extends Error {
  /**
   * @param {string} code 机器可读错误码，如 `SESSION_NOT_FOUND`。
   * @param {string} message 人类可读描述。
   * @param {number} [rpcCode] 映射到的 JSON-RPC 错误码，默认 `INTERNAL_ERROR`。
   * @param {Object<string, unknown>} [details] 附加诊断信息。
   * @param {{protocolLevel?: boolean}} [options] 选项；`protocolLevel=true` 表示该错误属于
   *   协议层（应作为 JSON-RPC error 响应返回，而非工具结果的 isError）。
   */
  constructor(code, message, rpcCode = JSONRPC_ERRORS.INTERNAL_ERROR, details = {}, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.rpcCode = rpcCode;
    this.details = details;
    this.protocolLevel = options.protocolLevel === true;
  }

  /**
   * 转换为 MCP 工具结果中的错误负载。
   *
   * @return {{error: {code: string, message: string, details: Object<string, unknown>}}} 结构化错误。
   */
  toPayload() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/**
 * 把任意异常规整为 AppError。
 *
 * @param {unknown} error 原始异常。
 * @return {AppError} 规整后的异常。
 */
function toAppError(error) {
  if (error instanceof AppError) return error;
  const message = error && error.message ? String(error.message) : String(error);
  return new AppError('INTERNAL_ERROR', message, JSONRPC_ERRORS.INTERNAL_ERROR);
}

/**
 * 协商协议版本：客户端请求的版本被支持则采用，否则返回服务端支持的版本。
 *
 * @param {unknown} requested 客户端请求的 protocolVersion。
 * @return {string} 协商结果版本。
 */
function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return PROTOCOL_VERSION;
}

/**
 * 组装一个 JSON-RPC 响应对象。
 *
 * @param {string|number|null} id 请求 id；通知为 null。
 * @param {unknown} result 成功负载。
 * @return {Object<string, unknown>} JSON-RPC 响应。
 */
function successResponse(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * 组装一个 JSON-RPC 错误响应对象。
 *
 * @param {string|number|null} id 请求 id。
 * @param {number} code JSON-RPC 错误码。
 * @param {string} message 错误描述。
 * @param {Object<string, unknown>} [data] 附加数据。
 * @return {Object<string, unknown>} JSON-RPC 错误响应。
 */
function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * 启动 MCP stdio 服务。
 *
 * stdout 只用于输出协议消息；所有诊断日志必须通过 `logger` 走 stderr。
 * 传入的 `handlers` 会被规范化为 Map（仅 own 可枚举属性），从根上隔离原型链。
 *
 * @param {Object<string, Function>} handlers 方法名 -> 处理函数，返回 Promise<result>。
 * @param {{log?: Function, name: string, version: string}} options 服务元信息与日志函数。
 * @return {{stop: Function}} 句柄，stop() 可结束读行循环。
 */
function serveStdio(handlers, options) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const serverInfo = { name: options.name, version: options.version };
  const registry = new Map();
  for (const [name, fn] of Object.entries(handlers || {})) {
    if (typeof fn === 'function') registry.set(name, fn);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    void dispatchLine(trimmed, registry, serverInfo, log);
  });

  rl.on('close', () => {
    log('stdin closed, shutting down');
  });

  return {
    stop() {
      rl.close();
    },
  };
}

/**
 * 处理单行输入：解析、校验信封、分发、写出响应。
 *
 * @param {string} line 一行 JSON 文本。
 * @param {Map<string, Function>|Object<string, Function>} handlers 方法处理器表。
 * @param {{name: string, version: string}} serverInfo 服务信息。
 * @param {Function} log stderr 日志函数。
 * @return {Promise<void>} 完成时 resolve。
 */
async function dispatchLine(line, handlers, serverInfo, log) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage(errorResponse(null, JSONRPC_ERRORS.PARSE_ERROR, `Parse error: ${error.message}`));
    return;
  }

  // 批量请求：本连接器不支持，按无效请求处理（id=null）。
  if (Array.isArray(request)) {
    writeMessage(errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Batch requests are not supported'));
    return;
  }

  // --- 1. 信封校验 ---
  if (request === null || typeof request !== 'object') {
    writeMessage(errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request: request must be a JSON object'));
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const rawId = hasId ? request.id : null;
  const idValid = !hasId || rawId === null || typeof rawId === 'string' || typeof rawId === 'number';

  const jsonrpcOk = request.jsonrpc === '2.0';
  const methodOk = typeof request.method === 'string' && request.method.length > 0;
  const paramsPresent = Object.prototype.hasOwnProperty.call(request, 'params');
  const params = paramsPresent ? request.params : undefined;
  const paramsStructured = !paramsPresent || params === null || typeof params === 'object';

  if (!jsonrpcOk || !idValid || !methodOk || !paramsStructured) {
    const reason = !jsonrpcOk
      ? 'missing or invalid "jsonrpc" (must be "2.0")'
      : !idValid
        ? 'invalid "id" (must be string, number or null)'
        : !methodOk
          ? 'missing "method" (must be a non-empty string)'
          : '"params" must be structured (object or array)';
    // 信封非法：无论有无 id 都必须回错误；id 无法可靠识别时用 null。
    writeMessage(errorResponse(idValid && hasId ? rawId : null, JSONRPC_ERRORS.INVALID_REQUEST, `Invalid Request: ${reason}`));
    return;
  }

  // --- 2. 合法通知判定（仅「信封合法且无 id」才算通知）---
  const isNotification = !hasId;

  // --- 3. 分发（Map 仅含注册方法，隔离原型链）---
  const handler = handlers instanceof Map
    ? handlers.get(request.method)
    : (Object.prototype.hasOwnProperty.call(handlers, request.method) ? handlers[request.method] : undefined);

  if (typeof handler !== 'function') {
    log(`unknown method: ${request.method}`);
    if (!isNotification) {
      writeMessage(errorResponse(rawId, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${request.method}`));
    }
    return;
  }

  const effectiveParams = params === undefined || params === null ? {} : params;

  try {
    const result = await handler(effectiveParams, { serverInfo, id: hasId ? rawId : null, method: request.method });
    if (isNotification) return;
    if (result === undefined) return; // 处理器主动选择不响应。
    writeMessage(successResponse(rawId, result));
  } catch (error) {
    const appError = toAppError(error);
    log(`method ${request.method} failed: ${appError.code} ${appError.message}`);
    if (!isNotification) {
      writeMessage(
        errorResponse(rawId, appError.rpcCode, `${appError.code}: ${appError.message}`, appError.details),
      );
    }
  }
}

/**
 * 将一条消息以单行 JSON 写入 stdout。
 *
 * @param {Object<string, unknown>} message JSON-RPC 消息。
 * @return {void}
 */
function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSONRPC_ERRORS,
  AppError,
  toAppError,
  negotiateProtocolVersion,
  serveStdio,
  dispatchLine,
  successResponse,
  errorResponse,
  writeMessage,
};
