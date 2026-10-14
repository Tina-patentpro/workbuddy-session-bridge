'use strict';

/**
 * WorkBuddy 会话桥接连接器 —— MCP stdio 入口。
 *
 * 传输：换行分隔的 JSON-RPC 2.0（每行一个 JSON，无 Content-Length 头）。
 * 支持方法：initialize / notifications/initialized / tools/list / tools/call / ping。
 *
 * 铁律：
 *   - stdout 只输出协议消息；所有日志走 stderr。
 *   - 对 WorkBuddy 自身数据绝对只读；只写 bridge 自己的目录。
 *   - 零第三方依赖，纯 Node.js。
 *
 * 【F07 整改】initialize 进行协议版本协商：客户端请求不支持的版本时，返回服务端支持的版本，
 * 绝不原样回显。方法分发表由 protocol 层规范化为 Map，隔离原型链。
 * 【F03 整改】存储配置非法（.json 结尾 / 命中受保护清单 / 指向文件）时，启动即失败并走 stderr，
 * 绝不先读写再拒绝。
 */

const { serveStdio, PROTOCOL_VERSION, JSONRPC_ERRORS, AppError, negotiateProtocolVersion } = require('./lib/protocol');
const { BRIDGE_NAME, BRIDGE_VERSION, createToolRegistry } = require('./lib/tools');

/**
 * 创建 stderr 日志函数（带时间戳与级别）。
 *
 * @param {boolean} enabled 是否启用。
 * @return {function(string): void} 日志函数。
 */
function createLogger(enabled) {
  return (message) => {
    if (!enabled) return;
    process.stderr.write(`[${BRIDGE_NAME}] ${new Date().toISOString()} ${message}\n`);
  };
}

const log = createLogger(process.env.WB_BRIDGE_LOG !== '0');

/** 创建工具注册表；存储配置非法时在此失败（启动前拒绝）。 */
let registry;
try {
  registry = createToolRegistry();
} catch (error) {
  log(`FATAL: 初始化失败：${error && error.message ? error.message : String(error)}`);
  process.stderr.write(
    `[${BRIDGE_NAME}] 启动中止：${error && error.code ? `[${error.code}] ` : ''}${error && error.message ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

/** JSON-RPC 方法处理器表。 */
const handlers = {
  /**
   * 初始化握手（含协议版本协商）。
   *
   * @param {Object} params 客户端 params。
   * @return {Object} MCP 初始化结果。
   */
  initialize(params) {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = negotiateProtocolVersion(requested);
    log(`initialize from client, requested=${requested} negotiated=${negotiated}`);
    return {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      instructions:
        '读取 WorkBuddy 本机会话对话输出；写入侧仅为指令队列投递（不是直接控制 WorkBuddy 会话）。' +
        '外部 agent 用 wb_send_instruction 投递，WorkBuddy 侧用 wb_pending_instructions 取件、' +
        'wb_complete_instruction 回填。',
    };
  },

  /** initialized 是通知，无需响应。 */
  'notifications/initialized'() {
    log('client reported initialized');
    return undefined;
  },

  /** 工具列举。 */
  'tools/list'() {
    return { tools: registry.definitions };
  },

  /**
   * 工具调用。
   *
   * @param {Object} params `{name, arguments}`。
   * @return {Promise<Object>} MCP 工具结果。
   * @throws {AppError} name/arguments 结构错误时抛协议级错误（-32602）。
   */
  async 'tools/call'(params) {
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) {
      throw new AppError('INVALID_PARAMS', 'tools/call 缺少 name', JSONRPC_ERRORS.INVALID_PARAMS, {}, { protocolLevel: true });
    }
    log(`tools/call ${name}`);
    return registry.dispatch(name, params.arguments === undefined ? {} : params.arguments);
  },

  /** 心跳。 */
  ping() {
    return {};
  },
};

log(`starting ${BRIDGE_NAME} v${BRIDGE_VERSION} on node ${process.version}, tools=${registry.definitions.length}, protocol=${PROTOCOL_VERSION}`);
serveStdio(handlers, { log, name: BRIDGE_NAME, version: BRIDGE_VERSION });
