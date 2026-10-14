'use strict';

/**
 * F06 · P1 · 参数归一化把字符串 false 转成 true，导致意外领取任务
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   对每个有副作用工具覆盖字符串布尔值、0/1、数组/对象/字符串参数容器、空值、分数、无穷值；
 *   拒绝时须确认磁盘无变化。正向保留真正的 false 预览、合法 true 消费与空白 instruction 拒绝。
 *
 * 证据方式：store 整树快照前后比对。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

(async () => {
  process.stdout.write('=== F06 · P1 · 参数严格性（I/O 边界）===\n');
  const sandbox = H.makeSandbox('f06');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
  fs.mkdirSync(path.join(sandbox.store, 'pending'), { recursive: true });

  const client = new H.Client(env);
  try {
    await client.initialize();

    // 先投递一条，供领取类用例使用
    const seed = H.parseTool(await client.call('wb_send_instruction', { instruction: 'DO_NOT_PICK' }));
    H.assert(seed.ok && seed.payload && seed.payload.instructionId, `种子入队失败: ${JSON.stringify(seed).slice(0, 200)}`);

    /** 断言某调用被拒绝且磁盘零变化。 */
    const expectRejectedNoDiskChange = async (name, method, args) => {
      await H.check(name, async () => {
        const snap = H.snapshotTree(sandbox.store);
        const res = await client.call(method, args);
        const t = H.parseTool(res);
        H.assert(!t.ok, `期望被拒绝但调用成功: ${JSON.stringify(t.payload).slice(0, 200)}`);
        const diffs = H.diffSnapshots(snap, H.snapshotTree(sandbox.store));
        H.assert(diffs.length === 0, `拒绝路径仍改动了磁盘:\n        ${diffs.join('\n        ')}`);
      });
    };

    // markPicked 字符串 "false" 必须被拒绝，且不得消费
    await expectRejectedNoDiskChange('F06.1 markPicked:"false"（字符串）被拒绝且零盘变', 'wb_pending_instructions', { markPicked: 'false', limit: 5 });
    // limit 分数
    await expectRejectedNoDiskChange('F06.2 limit:0.5（分数）被拒绝且零盘变', 'wb_pending_instructions', { limit: 0.5, markPicked: false });
    // limit Infinity（不可 JSON 序列化，转为 null）→ 视为缺省或拒绝；用 NaN 语义替代：字符串
    await expectRejectedNoDiskChange('F06.3 limit:"3"（字符串）被拒绝且零盘变', 'wb_pending_instructions', { limit: '3' });
    // metadata 错误类型
    await expectRejectedNoDiskChange('F06.4 metadata:123（数字）被拒绝且零盘变', 'wb_send_instruction', { instruction: 'X', metadata: 123 });
    await expectRejectedNoDiskChange('F06.5 metadata:[1,2]（数组）被拒绝且零盘变', 'wb_send_instruction', { instruction: 'X', metadata: [1, 2] });
    await expectRejectedNoDiskChange('F06.6 metadata:"s"（字符串）被拒绝且零盘变', 'wb_send_instruction', { instruction: 'X', metadata: 's' });
    // 空白 instruction 拒绝
    await expectRejectedNoDiskChange('F06.7 空白 instruction 被拒绝且零盘变', 'wb_send_instruction', { instruction: '   ' });
    // 数组作为参数容器
    await expectRejectedNoDiskChange('F06.8 arguments:[]（数组容器）被拒绝', 'wb_instruction_stats', []);

    // 正向：真布尔 false 预览不消费
    await H.check('F06.9 真布尔 markPicked:false 预览：返回但不改变磁盘', async () => {
      const snap = H.snapshotTree(sandbox.store);
      const res = await client.call('wb_pending_instructions', { markPicked: false, limit: 5 });
      const t = H.parseTool(res);
      H.assert(t.ok, `预览调用失败: ${JSON.stringify(t).slice(0, 200)}`);
      H.assert(Array.isArray(t.payload.instructions) && t.payload.instructions.length >= 1, '预览未返回待处理指令');
      const diffs = H.diffSnapshots(snap, H.snapshotTree(sandbox.store));
      H.assert(diffs.length === 0, `预览产生了写入:\n        ${diffs.join('\n        ')}`);
    });

    // 正向：真布尔 true 消费
    await H.check('F06.10 真布尔 markPicked:true 正常消费', async () => {
      const res = await client.call('wb_pending_instructions', { markPicked: true, limit: 5 });
      const t = H.parseTool(res);
      H.assert(t.ok, `消费调用失败: ${JSON.stringify(t).slice(0, 200)}`);
      H.assert(Array.isArray(t.payload.instructions) && t.payload.instructions.length >= 1, '消费未返回指令');
    });
  } finally {
    await client.close();
  }

  H.finish('F06');
})().catch((e) => { H.fail('F06 harness', (e && e.stack) || String(e)); H.finish('F06'); });
