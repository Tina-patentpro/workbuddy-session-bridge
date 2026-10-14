'use strict';

/**
 * F13 · P2 · 自闭合 system-reminder 与后续成对块组合时吞掉业务文本
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   覆盖自闭合、成对、未闭合尾块、多个交错相邻块、标签属性和中间业务文字；
 *   KEEP 必须保留，HIDDEN 必须删除。已通过的未闭合尾块场景必须继续通过。
 *
 * 核心反例：A<system-reminder/>KEEP<system-reminder>HIDDEN</system-reminder>B → AKEEPB
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 加载 stripSystemReminders（探测多种导出名）。 */
function loadStripper() {
  let jsonl;
  try {
    jsonl = require(path.join(H.PROJECT_ROOT, 'lib', 'jsonl.js'));
  } catch (e) {
    H.raiseEnv(`无法加载 lib/jsonl.js: ${e.message}`);
  }
  if (typeof jsonl.stripSystemReminders === 'function') return jsonl.stripSystemReminders;
  H.raiseEnv('lib/jsonl.js 未导出 stripSystemReminders（若已改名请更新探测点）');
  return null;
}

/** 兼容返回值形态，取清洗后的文本。 */
function cleanText(fn, input) {
  const out = fn(input);
  if (typeof out === 'string') return out;
  if (out && typeof out.text === 'string') return out.text;
  return null;
}

(async () => {
  process.stdout.write('=== F13 · P2 · system-reminder 顺序 / 交错 ===\n');

  const cases = [
    { name: 'F13.1 自闭合 + 成对组合：A<self/>KEEP<pair>HIDDEN</pair>B → AKEEPB', input: 'A<system-reminder/>KEEP<system-reminder>HIDDEN</system-reminder>B', expect: 'AKEEPB' },
    { name: 'F13.2 纯成对块删除：A<pair>HIDDEN</pair>B → AB', input: 'A<system-reminder>HIDDEN</system-reminder>B', expect: 'AB' },
    { name: 'F13.3 未闭合尾块剥离（既有正向）：A<unclosed>tail → A', input: 'A<system-reminder>tail should vanish', expect: 'A' },
    { name: 'F13.4 标签属性：A<reminder foo="bar" baz>H</reminder>B → AB', input: 'A<system-reminder foo="bar" baz="1">H</system-reminder>B', expect: 'AB' },
    { name: 'F13.5 多个交错相邻块 + 中间业务文字', input: 'A<system-reminder>1</system-reminder>K1<system-reminder/>K2<system-reminder>2</system-reminder>B', expect: 'AK1K2B' },
    { name: 'F13.6 自闭合在成对之后：A<pair>H</pair>KEEP<self/>B → AKEEPB', input: 'A<system-reminder>H</system-reminder>KEEP<system-reminder/>B', expect: 'AKEEPB' },
    { name: 'F13.7 两个自闭合 + 业务文字', input: 'A<system-reminder/>KEEP1<system-reminder/>KEEP2', expect: 'AKEEP1KEEP2' },
  ];

  for (const tc of cases) {
    await H.check(tc.name, () => {
      const fn = loadStripper();
      const got = cleanText(fn, tc.input);
      H.assert(got !== null, 'stripSystemReminders 返回形态无法识别');
      H.assert(got === tc.expect, `期望 ${JSON.stringify(tc.expect)}，实际 ${JSON.stringify(got)}`);
    });
  }

  // 端到端：经 wb_read_session 读取，KEEP 必须保留、HIDDEN 必须删除
  await H.check('F13.8 端到端：read_session 保留 KEEP、删除 HIDDEN', async () => {
    const sandbox = H.makeSandbox('f13');
    const slugDir = path.join(sandbox.projects, 'c-wbtest');
    fs.mkdirSync(slugDir, { recursive: true });
    const content = 'A<system-reminder/>KEEP_TEXT_F13<system-reminder>HIDDEN_TEXT_F13</system-reminder>B';
    fs.writeFileSync(path.join(slugDir, 'f13-session.jsonl'),
      `${JSON.stringify({ type: 'message', role: 'user', content, timestamp: 1 })}\n`, 'utf8');
    const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });
    const client = new H.Client(env);
    try {
      await client.initialize();
      const res = await client.call('wb_read_session', { conversationId: 'f13-session' });
      const t = H.parseTool(res);
      H.assert(t.ok, `读取失败: ${JSON.stringify(t).slice(0, 200)}`);
      const text = (t.payload.messages || []).map((m) => m.text).join('\n');
      H.assert(text.includes('KEEP_TEXT_F13'), '业务文本 KEEP 被误删');
      H.assert(!text.includes('HIDDEN_TEXT_F13'), 'HIDDEN 未被删除');
    } finally {
      await client.close();
    }
  });

  H.finish('F13');
})().catch((e) => { H.fail('F13 harness', (e && e.stack) || String(e)); H.finish('F13'); });
