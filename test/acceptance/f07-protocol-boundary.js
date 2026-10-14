'use strict';

/**
 * F07 · P1 · JSON-RPC / MCP 校验与分发边界不合规
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   矩阵覆盖 -32700 / -32600 / -32601 / -32602 / -32603 各层、合法通知不回包、
 *   非法无 id 输入回错误、原型名、arguments 类型和版本协商；错误之后 ping 必须存活。
 *   大文本 NDJSON 正向控制必须继续通过。
 */

const path = require('path');
const H = require('./harness');

(async () => {
  process.stdout.write('=== F07 · P1 · 协议与分发边界矩阵 ===\n');
  const sandbox = H.makeSandbox('f07');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  const c = new H.Client(env);

  /** 发送一条原始帧，收集窗口内响应。 */
  const raw = async (obj, ms = 350) => {
    const from = c.messages.length;
    c.writeRaw(typeof obj === 'string' ? obj : JSON.stringify(obj));
    await H.sleep(ms);
    return c.messages.slice(from).filter(Boolean);
  };

  const hasResponse = (msgs) => msgs.length > 0;
  const findError = (msgs, code) => msgs.find((m) => m && m.error && m.error.code === code);

  try {
    await c.initialize();

    // -32600 请求结构
    await H.check('F07.1 缺少 jsonrpc → -32600', async () => {
      const msgs = await raw({ id: 900, method: 'ping' });
      H.assert(!!findError(msgs, -32600), `期望 -32600，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.2 jsonrpc:"1.0" → -32600', async () => {
      const msgs = await raw({ jsonrpc: '1.0', id: 901, method: 'ping' });
      H.assert(!!findError(msgs, -32600), `期望 -32600，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.3 对象 id → -32600（非法 id）', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' });
      H.assert(!!findError(msgs, -32600), `期望 -32600，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.4 标量 params → -32600 或 -32602', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 903, method: 'ping', params: 42 });
      H.assert(!!(findError(msgs, -32600) || findError(msgs, -32602)), `期望 -32600/-32602，实际: ${JSON.stringify(msgs)}`);
    });

    // -32601 原型链方法名不得被执行
    await H.check('F07.5 method:"toString" → -32601（不得执行）', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 905, method: 'toString' });
      H.assert(!!findError(msgs, -32601), `期望 -32601，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.6 method:"constructor" → -32601（不得执行）', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 906, method: 'constructor' });
      H.assert(!!findError(msgs, -32601), `期望 -32601，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.7 method:"__proto__" → -32601（不得执行 / 不得 -32603）', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 907, method: '__proto__' });
      H.assert(!!findError(msgs, -32601), `期望 -32601，实际: ${JSON.stringify(msgs)}`);
    });

    // -32602 工具结构错误应在协议层
    await H.check('F07.8 未知工具 → 协议层 -32602（而非 result.isError）', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 908, method: 'tools/call', params: { name: 'NOT_A_TOOL', arguments: {} } });
      H.assert(!!findError(msgs, -32602), `期望协议层 -32602，实际: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.9 arguments:[]（数组容器）→ -32602', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 909, method: 'tools/call', params: { name: 'wb_instruction_stats', arguments: [] } });
      H.assert(!!findError(msgs, -32602), `期望 -32602，实际: ${JSON.stringify(msgs)}`);
    });

    // 版本协商：不得原样回显未知版本
    await H.check('F07.10 未知协议版本不得原样回显', async () => {
      const msgs = await raw({ jsonrpc: '2.0', id: 910, method: 'initialize', params: { protocolVersion: 'NOT-A-REAL-VERSION', capabilities: {} } });
      const ok = msgs.find((m) => m && m.result && m.result.protocolVersion);
      H.assert(!!ok, `initialize 无有效响应: ${JSON.stringify(msgs)}`);
      H.assert(ok.result.protocolVersion !== 'NOT-A-REAL-VERSION', `未知版本被原样回显: ${ok.result.protocolVersion}`);
    });

    // 合法通知不回包
    await H.check('F07.11 合法通知不回包', async () => {
      const msgs = await raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
      H.assert(!hasResponse(msgs), `通知被回应: ${JSON.stringify(msgs)}`);
    });

    // 非法无 id 输入回错误（必须是 error 对象，而非「无响应」或「成功响应」）
    await H.check('F07.12 非法无 id 输入（空对象）回 error', async () => {
      const msgs = await raw({});
      H.assert(msgs.some((m) => m && m.error), `非法无 id 输入未回 error 对象: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.13 非法 JSON 值 null → error（-32600）', async () => {
      const msgs = await raw('null');
      H.assert(msgs.some((m) => m && m.error), `null 未回 error 对象: ${JSON.stringify(msgs)}`);
      H.assert(!!findError(msgs, -32600) || msgs.some((m) => m && m.error && m.id === null),
        `null 未被识别为 Invalid Request: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.14 非法 JSON 值 3 → error 响应', async () => {
      const msgs = await raw('3');
      H.assert(msgs.some((m) => m && m.error), `标量 JSON 值未回 error 对象: ${JSON.stringify(msgs)}`);
    });

    await H.check('F07.15 解析错误 → -32700', async () => {
      const msgs = await raw('{ this is not json ');
      H.assert(!!findError(msgs, -32700), `期望 -32700，实际: ${JSON.stringify(msgs)}`);
    });

    // 错误之后 ping 存活
    await H.check('F07.16 上述错误后 ping 仍存活', async () => {
      const res = await c.request('ping', undefined, 3000);
      H.assert(res && res.result && !res.error, `ping 失败: ${JSON.stringify(res)}`);
    });

    // 大文本 NDJSON 正向控制
    await H.check('F07.17 大文本单行消息正向控制（含换行/中文/引号）', async () => {
      const big = 'L'.repeat(200000) + '\n中文"引号\\反斜杠';
      const res = await c.request('tools/call', { name: 'wb_send_instruction', arguments: { instruction: big } }, 10000);
      H.assert(res && res.result, `大文本请求失败: ${JSON.stringify(res).slice(0, 200)}`);
    });
  } finally {
    await c.close();
  }

  H.finish('F07');
})().catch((e) => { H.fail('F07 harness', (e && e.stack) || String(e)); H.finish('F07'); });
