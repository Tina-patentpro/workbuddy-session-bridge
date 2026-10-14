'use strict';

/**
 * F04 · P1 · 词法根目录检查不能阻止链接指向根外和受保护文件
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   覆盖文件链接、目录链接、根内指向根外、根内指向受保护命名、索引别名、子代理别名；
 *   保留合法非 UUID、中文/空格工作路径。Windows junction/reparse 需原生运行。
 *
 * 所有测试文件均位于隔离目录内，绝不触碰真实目录。
 *
 * ---------------------------------------------------------------------------
 * 【本轮修订 1】team-lead 复核后确认 F04.3/F04.4 旧版是**测试缺陷**，非源码缺陷。
 *   旧版根因：
 *     a) 用 writeMarkJsonl() 把 TEST_MARK 写进了**会话自身文件**，而 read_session 响应
 *        必然包含该会话消息 → 「整个响应不含 TEST_MARK」的断言恒假（必然 FAIL）。
 *     b) 根外测试文件命名为 `workbuddy.db`（非 `.jsonl`），而 readSubagents 只读 `.jsonl`，
 *        故即便禁用收口也读不到 → 用例对「越界读取」零判别力。
 *   修订：会话自身文件一律用 LEGIT_CONTENT_OK；仅根外测试文件携带标记值；
 *         断言收紧为「payload.subagents 不含标记值」+「整个响应不含根外标记值」。
 *
 * 【本轮修订 2】发现**本机 file 符号链接退化为普通空文件**（isSymbolicLink=false、
 *   read=''），即 fs.symlinkSync(t, link, 'file') 不产生真实 reparse point。
 *   于是旧版 F04.1/F04.2 实为**空过（vacuous pass）**——「无命中」只是因为文件为空，
 *   而非边界生效。按「诚实第一」，本版对文件级符号链接做**真实性校验**：
 *   若本机无法创建真实符号链接，则记 ENV（环境限制），绝不伪装通过。
 *   目录联接（junction）在本机可正常工作，故 F04.3/F04.4 改为以目录联接承载越界场景。
 *
 * 【判别力自证】每个真实越界场景都附带自证：用 --require 预载把 realpath 退化为词法
 *   resolve（见 _probe-lexical-realpath.js，模拟「未做真实目标收口」的旧实现），
 *   此时标记值**必须**出现在结果中；若不出现则判 FAIL —— 说明该用例抓不到它声称要抓的缺陷。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const TEST_MARK = 'FORBIDDEN_LINK_MARK_F04';
const LEGIT = 'LEGIT_CONTENT_OK';
const PROBE = path.join(__dirname, '_probe-lexical-realpath.js');

/**
 * 建立链接并**校验其真实性**。
 *
 * @param {string} target 链接目标。
 * @param {string} linkPath 链接路径（父目录会被自动创建）。
 * @param {string} type 'file' | 'dir' | 'junction'。
 * @return {{ok: boolean, real: boolean, code: (string|null)}} 结果；
 *   `real=false` 表示“创建未抛异常但并非真实符号链接”（本机 file 链接会退化为空文件）。
 */
function makeLink(target, linkPath, type) {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  } catch (_error) {
    /* 父目录创建失败时 symlinkSync 会给出更具体的错误码 */
  }
  try {
    fs.symlinkSync(target, linkPath, type);
  } catch (e) {
    return { ok: false, real: false, code: e.code || String(e) };
  }
  let real = false;
  try {
    real = fs.lstatSync(linkPath).isSymbolicLink();
  } catch (_error) {
    real = false;
  }
  return { ok: true, real, code: null };
}

/** 写入一个 JSONL 消息文件（content 由调用方决定：可为 legit 也可为标记值）。 */
function writeJsonl(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({ type: 'message', role: 'user', content, timestamp: 1 })}\n`);
}

/** 用一个 env 起一个会话，读 session（includeSubagents），返回 parseTool 结果。 */
async function readSession(env, conversationId) {
  const client = new H.Client(env);
  try {
    await client.initialize();
    const res = await client.call('wb_read_session', { conversationId, includeSubagents: true });
    return H.parseTool(res);
  } finally {
    await client.close();
  }
}

/** 用一个 env 列会话，返回 parseTool 结果。 */
async function listSessions(env) {
  const client = new H.Client(env);
  try {
    await client.initialize();
    const res = await client.call('wb_list_sessions', { limit: 5, includeCounts: false });
    return H.parseTool(res);
  } finally {
    await client.close();
  }
}

/** 把 env 包一层退化 realpath 的预载（用于判别力自证）。 */
function probeEnv(env) {
  return Object.assign({}, env, { NODE_OPTIONS: `--require ${PROBE}` });
}

/** 对象（含嵌套）序列化后是否含标记值。 */
function hasMark(obj) {
  return JSON.stringify(obj).includes(TEST_MARK);
}

/** 断言「判别力自证」：退化 realpath 后标记值必须出现。 */
function assertProbeDetects(t, label) {
  H.assert(
    hasMark(t),
    `判别力自证失败：禁用 realpath 收口后 ${label} 仍未出现标记值 —— 该用例抓不到「链接越界」缺陷`,
  );
}

/** 文件级符号链接在本机不可用时统一记 ENV。 */
function requireRealFileLink(r) {
  if (!r.ok) H.raiseEnv(`无法创建文件符号链接（${r.code}）`);
  if (!r.real) {
    H.raiseEnv('本机 fs.symlinkSync(file) 退化为普通空文件（isSymbolicLink=false，无 SeCreateSymbolicLinkPrivilege），无法验证文件级符号链接向量');
  }
}

/** 目录联接创建失败一律记 ENV。 */
function requireJunction(r) {
  if (!r.ok) H.raiseEnv(`无法创建目录 junction（${r.code}）`);
}

(async () => {
  process.stdout.write('=== F04 · P1 · 链接边界（根外 / 受保护命名别名）===\n');
  const sandbox = H.makeSandbox('f04');
  const env = H.baseEnv(sandbox, { WB_BRIDGE_STORE: sandbox.store });

  // 根外外部目录：其内放 `.jsonl`（内容含标记值）——只有这种「可被子代理读取的形态」
  // 才让「禁用 realpath 收口 → 标记值出现」成立，从而赋予用例判别力。
  const outsideDir = path.join(sandbox.root, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideForbidden = path.join(outsideDir, 'workbuddy.db');
  writeJsonl(outsideForbidden, TEST_MARK); // F04.1 用：根外 + 受保护命名
  writeJsonl(path.join(outsideDir, 'other-agent.jsonl'), TEST_MARK); // F04.3 用：根外 + 可读形态

  // 根外外部目录 2（供 F04.4 的「中间层 junction」使用）
  const outsideDir4 = path.join(sandbox.root, 'outside4');
  writeJsonl(path.join(outsideDir4, 'subagents', 'other-agent.jsonl'), TEST_MARK);

  const slug = path.join(sandbox.projects, 'c-wbtest');
  fs.mkdirSync(slug, { recursive: true });

  // ---- 场景 1：会话 .jsonl 文件链接 → 根外受保护命名文件 ----
  {
    const linkPath = path.join(slug, 'linked-session.jsonl');
    const r = makeLink(outsideForbidden, linkPath, 'file');
    await H.check('F04.1 会话文件链接指向根外受保护命名文件 → 拒绝读取（标记值不出现）', async () => {
      requireRealFileLink(r);
      const t = await readSession(env, 'linked-session');
      H.assert(!hasMark(t), `读取经链接返回了根外文件内容（标记值命中）: ${JSON.stringify(t).slice(0, 300)}`);
    });
    await H.check('F04.1-自证 判别力（禁用 realpath 收口 → 标记值必须出现）', async () => {
      requireRealFileLink(r);
      assertProbeDetects(await readSession(probeEnv(env), 'linked-session'), '会话文件链接');
    });
  }

  // ---- 场景 2：sessions.json 索引链接 → 根外测试文件 ----
  {
    const appDir = path.join(sandbox.workbuddy, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    const outsideIndex = path.join(outsideDir, 'index-outside.json');
    fs.writeFileSync(outsideIndex, JSON.stringify({
      version: 1,
      sessions: [{ conversationId: 'linked-index', workDir: `C:\\Users\\${TEST_MARK}`, startedAt: '2026-01-01T00:00:00.000Z' }],
    }));
    const r = makeLink(outsideIndex, path.join(appDir, 'sessions.json'), 'file');
    await H.check('F04.2 sessions.json 索引链接指向根外 → 不返回内容 / 不信任', async () => {
      requireRealFileLink(r);
      const t = await listSessions(env);
      H.assert(!hasMark(t), '索引经链接返回了根外内容（标记值命中）');
    });
    await H.check('F04.2-自证 判别力（禁用 realpath 收口 → 标记值必须出现）', async () => {
      requireRealFileLink(r);
      assertProbeDetects(await listSessions(probeEnv(env)), 'sessions.json 索引链接');
    });
  }

  // ---- 场景 3：subagents 目录联接 → 根外目录（目录级越界）----
  const cid3 = 'subagent-host';
  writeJsonl(path.join(slug, `${cid3}.jsonl`), LEGIT); // 会话自身：非标记值
  const r3 = makeLink(outsideDir, path.join(slug, cid3, 'subagents'), 'junction');
  await H.check('F04.3 subagents 目录联接指向根外 → subagents 字段不含根外标记值', async () => {
    requireJunction(r3);
    const t = await readSession(env, cid3);
    H.assert(t.ok, `read_session 失败: ${JSON.stringify(t).slice(0, 300)}`);
    H.assert(!hasMark(t.payload && t.payload.subagents), 'subagents 字段返回了根外目录内容（标记值命中）');
    H.assert(!hasMark(t), '响应整体出现根外标记值');
  });
  await H.check('F04.3-自证 判别力（禁用 realpath 收口 → 标记值必须出现）', async () => {
    requireJunction(r3);
    assertProbeDetects(await readSession(probeEnv(env), cid3), 'subagents 目录联接');
  });

  // ---- 场景 4：会话目录本身是指向根外的 junction（中间层越界）----
  // 会话文件 <cid4>.jsonl 合法可读；但 <cid4>/ 这个「会话目录」是 junction → 根外，
  // 其下 subagents/other-agent.jsonl 为标记值。收口必须按真实目标判定并阻断。
  const cid4 = 'rootlink-host';
  writeJsonl(path.join(slug, `${cid4}.jsonl`), LEGIT); // 会话自身：非标记值
  const r4 = makeLink(outsideDir4, path.join(slug, cid4), 'junction');
  await H.check('F04.4 会话目录为根内 junction 指向根外 → 不读取根外内容', async () => {
    requireJunction(r4);
    const t = await readSession(env, cid4);
    H.assert(t.ok, `read_session 失败: ${JSON.stringify(t).slice(0, 300)}`);
    H.assert(!hasMark(t.payload && t.payload.subagents), 'subagents 字段经由中间层 junction 返回根外标记值');
    H.assert(!hasMark(t), '响应整体出现根外标记值');
  });
  await H.check('F04.4-自证 判别力（禁用 realpath 收口 → 标记值必须出现）', async () => {
    requireJunction(r4);
    assertProbeDetects(await readSession(probeEnv(env), cid4), '会话目录 junction');
  });

  // ---- 场景 5：合法非 UUID / 中文空格工作路径必须保持可读（不误伤）----
  {
    const cid = 'conv-partial';
    writeJsonl(path.join(slug, `${cid}.jsonl`), LEGIT);
    await H.check('F04.5 合法非 UUID 会话仍可读取（链接修复不误伤）', async () => {
      const client = new H.Client(env);
      try {
        await client.initialize();
        const res = await client.call('wb_read_session', { conversationId: cid });
        const t = H.parseTool(res);
        H.assert(t.ok, `合法会话读取失败: ${JSON.stringify(t).slice(0, 300)}`);
        H.assert(JSON.stringify(t.payload).includes(LEGIT), '合法会话内容未返回');
      } finally {
        await client.close();
      }
    });
  }

  H.finish('F04', `隔离目录外测试文件 token=${TEST_MARK}`);
})().catch((e) => { H.fail('F04 harness', (e && e.stack) || String(e)); H.finish('F04'); });
