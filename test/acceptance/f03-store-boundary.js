'use strict';

/**
 * F03 · P1 · 队列存储入口未校验数据库受保护名单
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   对四种受保护命名和大小写 / 别名配置做只读与写入负向测试；**不仅断言工具报错，
 *   还应证明目标及父目录未发生读写、移动或新建副作用**。正向验证正常临时队列继续可用。
 *
 * 证据方式：文件 SHA-256 + 父目录项快照比对（不是只看报错）。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 受保护命名清单（含大小写变体与别名形态）。 */
const FORBIDDEN = [
  'workbuddy.db',
  'workbuddy.db-wal',
  'workbuddy.db-shm',
  'workbuddy.db-journal',
  'WORKBUDDY.DB',
  'WorkBuddy.Db-Wal',
];

/** 合法队列测试负载。 */
const PAYLOAD = JSON.stringify({ version: 1, updatedAt: null, instructions: [{ id: 'payload-1', status: 'pending', instruction: 'PAYLOAD' }] }, null, 2);

(async () => {
  process.stdout.write('=== F03 · P1 · 存储受保护命名边界（只读/写入负向 + 零副作用）===\n');
  const sandbox = H.makeSandbox('f03');

  for (const name of FORBIDDEN) {
    const target = path.join(sandbox.workbuddy, name);
    fs.writeFileSync(target, PAYLOAD);
    const parentBefore = H.snapshotTree(sandbox.workbuddy);

    const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: target });
    const client = new H.Client(env);

    await H.check(`F03 [${name}] 存储入口拒绝受保护命名 + 目标与父目录零副作用`, async () => {
      try {
        const init = await client.initialize();
        // 允许启动即失败（初始化无响应）。
        const stats = await client.call('wb_instruction_stats', {});
        const send = await client.call('wb_send_instruction', { instruction: 'SHOULD-NOT-WRITE' });

        const statsRejected = !stats || !!H.parseTool(stats).protocolError || H.parseTool(stats).isError;
        const sendRejected = !send || !!H.parseTool(send).protocolError || H.parseTool(send).isError;
        H.assert(statsRejected && sendRejected,
          `受保护命名配置未同时被只读与写入拒绝（statsRejected=${statsRejected}, sendRejected=${sendRejected}）`);

        // 零副作用：目标字节不变 + 父目录项快照不变
        const onDisk = fs.readFileSync(target, 'utf8');
        H.assert(onDisk === PAYLOAD, `受保护命名目标文件被改写（${name}）`);
        const diffs = H.diffSnapshots(parentBefore, H.snapshotTree(sandbox.workbuddy));
        H.assert(diffs.length === 0, `受保护命名目标或父目录出现副作用:\n        ${diffs.join('\n        ')}`);
      } finally {
        await client.close();
      }
    });
  }

  await H.check('F03 [正向] 正常临时队列目录继续可用', async () => {
    const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
    const client = new H.Client(env);
    try {
      await client.initialize();
      const res = await client.call('wb_send_instruction', { instruction: 'POSITIVE-OK' });
      const t = H.parseTool(res);
      H.assert(t.ok && t.payload && typeof t.payload.instructionId === 'string',
        `正常目录入队失败: ${JSON.stringify(t)}`);
    } finally {
      await client.close();
    }
  });

  H.finish('F03');
})().catch((e) => { H.fail('F03 harness', (e && e.stack) || String(e)); H.finish('F03'); });
