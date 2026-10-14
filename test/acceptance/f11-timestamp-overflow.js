'use strict';

/**
 * F11 · P2 · 单条越界数值时间戳会中断整份会话读取
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   覆盖合法毫秒值、负值、边界、越界大值和缺失值；明确保留/跳过语义，
 *   正常相邻消息始终可读，服务随后仍存活。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 写一个会话 JSONL 并保证可被 wb_read_session 发现。 */
function writeSession(sandbox, cid, records) {
  const slugDir = path.join(sandbox.projects, 'c-wbtest');
  fs.mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${cid}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

(async () => {
  process.stdout.write('=== F11 · P2 · 越界时间戳不得中断整份读取 ===\n');
  const sandbox = H.makeSandbox('f11');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });

  const cid = 'f11-session';
  writeSession(sandbox, cid, [
    { type: 'message', role: 'user', content: 'BEFORE_NORMAL_MESSAGE', timestamp: 1700000000000 },
    { type: 'message', role: 'assistant', content: 'BAD_TIMESTAMP_MIDDLE', timestamp: 1e100 },
    { type: 'message', role: 'user', content: 'AFTER_NORMAL_MESSAGE', timestamp: -1 },
  ]);

  const client = new H.Client(env);
  try {
    await client.initialize();

    await H.check('F11.1 越界时间戳消息不使整次读取失败', async () => {
      const res = await client.call('wb_read_session', { conversationId: cid });
      const t = H.parseTool(res);
      H.assert(t.ok, `读取整体失败（越界时间戳中断了整份读取）: ${JSON.stringify(t).slice(0, 300)}`);
    });

    await H.check('F11.2 相邻正常消息（前/后）始终可读', async () => {
      const res = await client.call('wb_read_session', { conversationId: cid });
      const t = H.parseTool(res);
      H.assert(t.ok, `读取失败: ${JSON.stringify(t).slice(0, 200)}`);
      const texts = (t.payload.messages || []).map((m) => m.text).join('\n');
      H.assert(texts.includes('BEFORE_NORMAL_MESSAGE'), '越界时间戳之前的正常消息未返回');
      H.assert(texts.includes('AFTER_NORMAL_MESSAGE'), '越界时间戳之后的正常消息未返回');
    });

    await H.check('F11.3 越界时间戳以明确语义处理（time 为 null 或计数跳过，不得抛错）', async () => {
      const res = await client.call('wb_read_session', { conversationId: cid });
      const t = H.parseTool(res);
      H.assert(t.ok, '读取失败');
      const mid = (t.payload.messages || []).find((m) => (m.text || '').includes('BAD_TIMESTAMP_MIDDLE'));
      if (mid) {
        H.assert(mid.time === null || typeof mid.time === 'string',
          `越界时间戳被强行转换为非法 time 值: ${JSON.stringify(mid.time)}`);
      }
      // 若整条被跳过并计数，也接受（语义明确即可）
    });

    await H.check('F11.4 服务在越界时间戳处理后仍存活（ping 正常）', async () => {
      const res = await client.request('ping', undefined, 3000);
      H.assert(res && res.result && !res.error, `服务未存活: ${JSON.stringify(res)}`);
    });

    await H.check('F11.5 合法边界/负值时间戳不误伤', async () => {
      const cid2 = 'f11-boundary';
      writeSession(sandbox, cid2, [
        { type: 'message', role: 'user', content: 'NEG_TS_OK', timestamp: -8640000000000000 },
        { type: 'message', role: 'user', content: 'ZERO_TS_OK', timestamp: 0 },
        { type: 'message', role: 'user', content: 'NO_TS_OK' },
      ]);
      const res = await client.call('wb_read_session', { conversationId: cid2 });
      const t = H.parseTool(res);
      H.assert(t.ok, `边界时间戳读取失败: ${JSON.stringify(t).slice(0, 200)}`);
      const texts = (t.payload.messages || []).map((m) => m.text).join('\n');
      H.assert(texts.includes('NEG_TS_OK') && texts.includes('ZERO_TS_OK') && texts.includes('NO_TS_OK'),
        '合法边界/缺失时间戳消息被误伤');
    });
  } finally {
    await client.close();
  }

  H.finish('F11');
})().catch((e) => { H.fail('F11 harness', (e && e.stack) || String(e)); H.finish('F11'); });
