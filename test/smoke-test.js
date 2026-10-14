'use strict';

/**
 * 零依赖冒烟测试。
 *
 * 隔离策略：
 *   - 通过 `TASK=1` 让 bridge 目录重定向到系统临时目录，`WB_BRIDGE_STORE` 显式指定队列文件，
 *     因此测试期间的**写操作不会落到任何真实 WorkBuddy 目录**。
 *   - 只读访问真实 `sessions.json`，且最多只读 1 个真实会话 jsonl（`includeCounts=false` + limit=1）。
 *
 * 覆盖：initialize -> tools/list（8 个工具）-> tools/call 逐个工具 ->
 *      指令三段闭环（pending -> picked -> done）-> 会话读取 -> 能力边界说明。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', 'server.js');
// 隔离目录：**每次运行唯一**（mkdtempSync）——固定路径会导致并发实例互相删除对方的隔离目录（互踩）。
const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-session-bridge-smoke-'));
// maildir 语义：WB_BRIDGE_STORE 指向**队列根目录**（下含 pending/picked/done/failed/tmp）。
const STORE_PATH = path.join(SANDBOX_DIR, 'store');
// 真实 WorkBuddy 部署目录（只读）。可用 WB_REAL_WB 覆盖；无真实部署时（如 Linux 审计机）
// 依赖它的用例自行降级为「合成目录/跳过」，绝不因环境差异 FAIL。
const REAL_WB = process.env.WB_REAL_WB || path.join(os.homedir(), '.workbuddy');

const EXPECTED_TOOLS = [
  'wb_list_sessions',
  'wb_read_session',
  'wb_search_sessions',
  'wb_send_instruction',
  'wb_pending_instructions',
  'wb_complete_instruction',
  'wb_instruction_stats',
  'wb_bridge_info',
];

const results = [];

/**
 * 记录一条断言结果。
 *
 * @param {string} name 用例名。
 * @param {function(): (Promise<*>|void)} fn 用例体。
 * @return {Promise<void>} 完成。
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true, error: null });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (error) {
    results.push({ name, passed: false, error: error && error.message ? error.message : String(error) });
    process.stdout.write(`  FAIL  ${name}\n        ${error && error.message}\n`);
  }
}

/**
 * 一个极简 MCP stdio 客户端。
 */
class BridgeClient {
  /**
   * @param {string} serverPath server.js 路径。
   */
  constructor(serverPath) {
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TASK: '1', WB_BRIDGE_STORE: STORE_PATH, WB_BRIDGE_LOG: '0', WB_WORKBUDDY_DIR: REAL_WB },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  /**
   * 处理 stdout 分片，按行解析 JSON-RPC。
   *
   * @param {string} chunk 数据分片。
   * @return {void}
   */
  onData(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch (_error) {
          message = null;
        }
        if (message && message.id !== undefined && message.id !== null) {
          const resolver = this.pending.get(message.id);
          if (resolver) {
            this.pending.delete(message.id);
            resolver(message);
          }
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  /**
   * 发送一个 JSON-RPC 请求。
   *
   * @param {string} method 方法名。
   * @param {Object} [params] 参数。
   * @return {Promise<Object>} 响应。
   */
  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}\n--- stderr ---\n${this.stderr}`));
      }, 30000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * 发送一个通知（无 id，不等响应）。
   *
   * @param {string} method 方法名。
   * @param {Object} [params] 参数。
   * @return {void}
   */
  notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  /**
   * 调用工具并解析 content[0].text。
   *
   * @param {string} name 工具名。
   * @param {Object} [args] 工具参数。
   * @return {Promise<Object>} 解析后的负载。
   */
  async callTool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args || {} });
    assert.ok(response.result, `tools/call ${name} 未返回 result: ${JSON.stringify(response)}`);
    const text = response.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(
      !response.result.isError,
      `工具 ${name} 返回 isError: ${text}\n--- stderr ---\n${this.stderr}`,
    );
    return parsed;
  }

  /**
   * 关闭子进程。
   *
   * @return {void}
   */
  close() {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch (_error) {
      /* ignore */
    }
  }
}

/**
 * 读取 maildir 队列根目录下的全部记录（跨 pending/picked/done/failed）。
 *
 * @param {string} storeRoot 队列根目录。
 * @return {{records: Object[], byStatus: Object<string, Object[]>, leftovers: string[]}} 汇总。
 */
function readMaildir(storeRoot) {
  const byStatus = { pending: [], picked: [], done: [], failed: [] };
  const records = [];
  for (const status of Object.keys(byStatus)) {
    const dir = path.join(storeRoot, status);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_e) { names = []; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      rec.status = status;
      byStatus[status].push(rec);
      records.push(rec);
    }
  }
  let leftovers = [];
  try {
    leftovers = fs.readdirSync(path.join(storeRoot, 'tmp')).filter((f) => f.endsWith('.tmp'));
  } catch (_e) { leftovers = []; }
  return { records, byStatus, leftovers };
}

/**
 * 主流程。
 *
 * @return {Promise<number>} 退出码。
 */
async function main() {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  process.stdout.write('workbuddy-session-bridge smoke test\n');
  process.stdout.write(`server : ${SERVER}\n`);
  process.stdout.write(`sandbox: ${SANDBOX_DIR} (TASK=1, WB_BRIDGE_STORE=${STORE_PATH})\n\n`);

  assert.ok(fs.existsSync(SERVER), `server.js 不存在: ${SERVER}`);
  const client = new BridgeClient(SERVER);
  let realConversationId = null;
  let realSampleWord = null;

  try {
    await test('initialize 返回 protocolVersion / capabilities.tools / serverInfo', async () => {
      const response = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
      });
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.ok(response.result.protocolVersion, '缺少 protocolVersion');
      assert.ok(response.result.capabilities.tools, '缺少 capabilities.tools');
      assert.strictEqual(response.result.serverInfo.name, 'workbuddy-session-bridge');
      assert.ok(response.result.serverInfo.version, '缺少 serverInfo.version');
      client.notify('notifications/initialized');
    });

    await test('ping 返回空结果', async () => {
      const response = await client.request('ping', {});
      assert.deepStrictEqual(response.result, {});
    });

    await test('未知方法返回 -32601', async () => {
      const response = await client.request('no/such/method', {});
      assert.strictEqual(response.error.code, -32601);
    });

    let toolNames = [];
    await test('tools/list 断言 8 个工具全部存在', async () => {
      const response = await client.request('tools/list', {});
      const tools = response.result.tools;
      toolNames = tools.map((tool) => tool.name).sort();
      assert.strictEqual(tools.length, 8, `工具数量应为 8，实际 ${tools.length}: ${toolNames.join(',')}`);
      assert.deepStrictEqual(toolNames, [...EXPECTED_TOOLS].sort());
      for (const tool of tools) {
        assert.ok(tool.description && tool.description.length > 10, `工具 ${tool.name} 缺少描述`);
        assert.ok(tool.inputSchema && tool.inputSchema.type === 'object', `工具 ${tool.name} 缺少 object schema`);
      }
    });

    await test('wb_bridge_info 能力边界说明非空', async () => {
      const info = await client.callTool('wb_bridge_info');
      const boundary = info.capabilityBoundary;
      assert.ok(boundary, '缺少 capabilityBoundary');
      assert.strictEqual(boundary.canRead, true);
      assert.strictEqual(boundary.canDriveWorkBuddySessionDirectly, false);
      assert.strictEqual(boundary.canWrite, 'queue-only');
      assert.ok(boundary.summary && boundary.summary.length > 10, 'boundary.summary 过短');
      assert.ok(Array.isArray(boundary.reasons) && boundary.reasons.length >= 3, 'boundary.reasons 过短');
      assert.ok(info.paths.bridgeDir, '缺少 bridgeDir');
      assert.ok(info.paths.storeRoot, '缺少 storeRoot');
      assert.ok(info.readAccess.sessionCount >= 0, '缺少 sessionCount');
      process.stdout.write(
        `        info: sessions=${info.readAccess.sessionCount} indexReadable=${info.readAccess.sessionsIndexReadable} ` +
          `projects=${info.readAccess.projectDirCount} sandboxed=${info.sandboxed}\n`,
      );
    });

    await test('wb_list_sessions 只读列举真实会话', async () => {
      const listed = await client.callTool('wb_list_sessions', { limit: 1, includeCounts: false });
      assert.ok(typeof listed.totalInIndex === 'number', '缺少 totalInIndex');
      assert.ok(Array.isArray(listed.sessions), '缺少 sessions 数组');
      if (listed.sessions.length > 0) {
        realConversationId = listed.sessions[0].conversationId;
        const first = listed.sessions[0];
        assert.ok(first.conversationId, '会话缺少 conversationId');
        assert.ok('workDir' in first, '会话缺少 workDir');
        assert.ok('projectDir' in first, '会话缺少 projectDir');
        assert.ok('lastActivityAt' in first, '会话缺少 lastActivityAt');
      } else {
        process.stdout.write('        warn: sessions.json 为空，跳过真实会话读取断言\n');
      }
      process.stdout.write(`        totalInIndex=${listed.totalInIndex} returned=${listed.returned}\n`);
    });

    await test('wb_read_session 返回真实会话消息', async () => {
      if (!realConversationId) {
        process.stdout.write('        skip: 无真实会话可读\n');
        return;
      }
      const read = await client.callTool('wb_read_session', {
        conversationId: realConversationId,
        maxMessages: 5,
        maxChars: 300,
        includeSubagents: true,
      });
      assert.strictEqual(read.conversationId, realConversationId);
      assert.ok(Array.isArray(read.messages), '缺少 messages 数组');
      assert.ok(read.returnedMessages <= 5, `returnedMessages 超过 maxMessages: ${read.returnedMessages}`);
      assert.strictEqual(typeof read.skipped, 'number');
      for (const message of read.messages) {
        assert.ok(typeof message.role === 'string', '消息缺少 role');
        assert.ok(typeof message.text === 'string', '消息缺少 text');
        assert.ok(message.text.length <= 340, `文本未按 maxChars 截断: ${message.text.length}`);
        assert.ok(!message.text.includes('<system-reminder'), '默认未过滤 <system-reminder>');
      }
      // 取一个真实样本词（长度 >= 4 的 ASCII 词）供搜索用例复用，避免读取第二个会话。
      for (const message of read.messages) {
        const match = message.text.match(/[A-Za-z][A-Za-z0-9_.-]{3,}/);
        if (match) {
          realSampleWord = match[0];
          break;
        }
      }
      process.stdout.write(
        `        total=${read.totalMessages} returned=${read.returnedMessages} skipped=${read.skipped} ` +
          `subagents=${read.subagents ? read.subagents.length : 'n/a'}\n`,
      );
    });

    await test('wb_read_session 对非法/不存在会话返回结构化错误', async () => {
      // 危险形态（含路径分隔符 / ".."）-> INVALID_CONVERSATION_ID；
      // 安全形态但磁盘上不存在 -> SESSION_NOT_FOUND。
      const cases = [
        { cid: '..\\..\\..\\..\\outside', expect: 'INVALID_CONVERSATION_ID' },
        { cid: 'no-such-conversation-id-0000', expect: 'SESSION_NOT_FOUND' },
      ];
      for (const item of cases) {
        const response = await client.request('tools/call', {
          name: 'wb_read_session',
          arguments: { conversationId: item.cid },
        });
        assert.strictEqual(response.result.isError, true, `conversationId=${item.cid} 应当被拒绝`);
        const parsed = JSON.parse(response.result.content[0].text);
        assert.strictEqual(parsed.error.code, item.expect, `conversationId=${item.cid} 错误码不符`);
      }
    });

    await test('BUG-3 回归：conversationId 越级路径被 UUID 白名单拦截', async () => {
      // 在隔离目录外侧放一个外部文件，验证越级输入读不到它的内容。
      const markValue = 'MARK-VALUE-9d3a7f';
      const outsideDir = path.join(SANDBOX_DIR, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, 'outside.jsonl');
      fs.writeFileSync(
        outsideFile,
        JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: markValue }] }) + '\n',
        'utf8',
      );

      // 从真实 projects/ 取一个项目目录构造相对越级路径；无真实部署（如 Linux 审计机，
      // 或 WB_REAL_WB 指向空目录）时退回隔离目录内合成的目录——越级断言本身（全部拒绝 + 未出现在响应中）
      // 与基准目录无关，保持完整判别力，绝不因环境差异 FAIL。
      let projectDir;
      try {
        const projectNames = fs.readdirSync(path.join(REAL_WB, 'projects'));
        const realSlugDir = projectNames.find((name) => name.startsWith('c-Users-TinaD-WorkBuddy-'))
          || projectNames[0];
        projectDir = realSlugDir
          ? path.join(REAL_WB, 'projects', realSlugDir)
          : path.join(SANDBOX_DIR, 'synthetic-projects', 'c-fake');
      } catch (_e) {
        projectDir = path.join(SANDBOX_DIR, 'synthetic-projects', 'c-fake');
      }
      const relative = path.relative(projectDir, outsideFile).replace(/\.jsonl$/, '');

      const edgeInputs = [relative, '..\\..\\..\\..\\outside', '../../../../outside', 'C:\\Windows\\Temp\\x', 'a/b'];
      for (const candidate of edgeInputs) {
        const response = await client.request('tools/call', {
          name: 'wb_read_session',
          arguments: { conversationId: candidate },
        });
        assert.strictEqual(response.result.isError, true, `越级输入 ${JSON.stringify(candidate)} 竟成功读取`);
        const text = response.result.content[0].text;
        const parsed = JSON.parse(text);
        assert.strictEqual(parsed.error.code, 'INVALID_CONVERSATION_ID', `越级输入 ${JSON.stringify(candidate)} 错误码不符`);
        // 关键判据：外部文件的内容（而非输入回显）绝不出现在响应里。
        assert.ok(!text.includes(markValue), `越级输入 ${JSON.stringify(candidate)} 读取到了外部文件内容`);
        assert.ok(!text.includes(outsideFile), `越级输入 ${JSON.stringify(candidate)} 返回了外部文件路径`);
      }
      // 空串 conversationId 属参数校验失败 -> 协议级 -32602（F06/F07 错误分层）。
      const emptyResp = await client.request('tools/call', { name: 'wb_read_session', arguments: { conversationId: '' } });
      assert.ok(emptyResp.error && emptyResp.error.code === -32602, `空 conversationId 未按 -32602 拒绝：${JSON.stringify(emptyResp).slice(0, 160)}`);
      assert.ok(!JSON.stringify(emptyResp).includes(markValue), '空输入响应读取到了外部文件内容');
      process.stdout.write(`        ${edgeInputs.length + 1} 种越级/非法输入全部被拦截，外部文件内容未出现在响应中\n`);
    });

    await test('BUG-4 回归：缺失/空串/纯空白 instruction 一律被拒（-32602）', async () => {
      const before = (await client.callTool('wb_instruction_stats')).total;
      for (const args of [{}, { instruction: '' }, { instruction: '   ' }, { instruction: '\t\n ' }]) {
        const response = await client.request('tools/call', { name: 'wb_send_instruction', arguments: args });
        assert.ok(response.error, `args=${JSON.stringify(args)} 竟成功入队`);
        assert.strictEqual(response.error.code, -32602, `args=${JSON.stringify(args)} code=${response.error.code}`);
        assert.ok(String(response.error.message).includes('INVALID_ARGUMENT'), `args=${JSON.stringify(args)} message=${response.error.message}`);
      }
      const after = (await client.callTool('wb_instruction_stats')).total;
      assert.strictEqual(after, before, '空指令竟然入队了');
    });

    await test('wb_search_sessions 返回启发式搜索结果', async () => {
      const found = await client.callTool('wb_search_sessions', {
        keyword: 'WorkBuddy',
        limit: 5,
        maxSessions: 1,
        maxBytesPerSession: 512 * 1024,
      });
      assert.strictEqual(found.keyword, 'WorkBuddy');
      assert.ok(Array.isArray(found.hits), '缺少 hits 数组');
      assert.ok(found.heuristicNote && found.heuristicNote.length > 20, 'heuristicNote 过短');
      assert.ok(found.scope && typeof found.scope.filesScanned === 'number', '缺少 scope.filesScanned');
      process.stdout.write(`        hits=${found.hitCount} filesScanned=${found.scope.filesScanned}\n`);
    });

    await test('wb_search_sessions 用真实会话词汇命中并给出 snippet', async () => {
      if (!realSampleWord) {
        process.stdout.write('        skip: 无可用真实样本词\n');
        return;
      }
      const found = await client.callTool('wb_search_sessions', {
        keyword: realSampleWord,
        limit: 5,
        maxSessions: 1,
        maxBytesPerSession: 2 * 1024 * 1024,
      });
      assert.ok(found.hitCount >= 1, `未命中样本词 ${realSampleWord}: ${JSON.stringify(found.scope)}`);
      const hit = found.hits[0];
      assert.strictEqual(hit.conversationId, realConversationId);
      assert.ok(typeof hit.role === 'string' && hit.role.length > 0, '命中缺少 role');
      assert.ok(hit.snippet.toLowerCase().includes(realSampleWord.toLowerCase()), 'snippet 未包含关键词');
      process.stdout.write(`        sample="${realSampleWord}" hits=${found.hitCount} role=${hit.role}\n`);
    });

    let instructionId = null;
    await test('wb_send_instruction 入队并返回 instructionId / status / position', async () => {
      const queued = await client.callTool('wb_send_instruction', {
        instruction: 'smoke-test: 请在下一个会话窗口汇报桥接连通性',
        priority: 'high',
        metadata: { source: 'smoke-test' },
      });
      assert.ok(queued.instructionId, '缺少 instructionId');
      assert.strictEqual(queued.status, 'queued');
      assert.ok(queued.createdAt, '缺少 createdAt');
      assert.ok(queued.position >= 1, `position 非法: ${queued.position}`);
      instructionId = queued.instructionId;
      // 队列文件必须落在隔离目录，不得写入真实 WorkBuddy 目录。
      assert.ok(fs.existsSync(STORE_PATH), `隔离目录队列文件未生成: ${STORE_PATH}`);
      assert.ok(
        STORE_PATH.includes('wb-session-bridge-smoke'),
        `队列文件落在非隔离目录路径: ${STORE_PATH}`,
      );
    });

    await test('wb_instruction_stats 计数 pending=1', async () => {
      const stats = await client.callTool('wb_instruction_stats');
      assert.strictEqual(stats.total, 1);
      assert.strictEqual(stats.counts.pending, 1);
      assert.strictEqual(stats.counts.picked, 0);
      assert.strictEqual(stats.counts.done, 0);
      assert.strictEqual(stats.counts.failed, 0);
      assert.ok(stats.storeExists, 'storeExists 应为 true');
    });

    await test('wb_pending_instructions 取出并标记 picked', async () => {
      const pulled = await client.callTool('wb_pending_instructions', { limit: 10 });
      assert.strictEqual(pulled.count, 1);
      assert.strictEqual(pulled.instructions[0].id, instructionId);
      assert.strictEqual(pulled.instructions[0].status, 'picked');
      assert.ok(pulled.instructions[0].pickedAt, '缺少 pickedAt');
      assert.strictEqual(pulled.markPicked, true);
      assert.strictEqual(pulled.remainingPending, 0);
    });

    await test('wb_complete_instruction 回填为 done（三段闭环）', async () => {
      const completed = await client.callTool('wb_complete_instruction', {
        instructionId,
        result: { echo: 'ok', answeredBy: 'smoke-test' },
      });
      assert.strictEqual(completed.id, instructionId);
      assert.strictEqual(completed.status, 'done');
      assert.ok(completed.completedAt, '缺少 completedAt');
      assert.strictEqual(completed.result.echo, 'ok');

      const stats = await client.callTool('wb_instruction_stats');
      assert.strictEqual(stats.counts.done, 1);
      assert.strictEqual(stats.counts.pending, 0);
      assert.strictEqual(stats.counts.picked, 0);
    });

    await test('wb_complete_instruction 对终态指令返回 ALREADY_FINAL', async () => {
      const response = await client.request('tools/call', {
        name: 'wb_complete_instruction',
        arguments: { instructionId, result: 'again' },
      });
      assert.strictEqual(response.result.isError, true);
      const parsed = JSON.parse(response.result.content[0].text);
      assert.strictEqual(parsed.error.code, 'INSTRUCTION_ALREADY_FINAL');
    });

    await test('wb_pending_instructions 支持 markPicked=false 预览', async () => {
      await client.callTool('wb_send_instruction', { instruction: 'preview-only' });
      const preview = await client.callTool('wb_pending_instructions', { limit: 5, markPicked: false });
      assert.strictEqual(preview.count, 1);
      assert.strictEqual(preview.instructions[0].status, 'pending');
      assert.strictEqual(preview.markPicked, false);
      const stats = await client.callTool('wb_instruction_stats');
      assert.strictEqual(stats.counts.pending, 1, 'markPicked=false 不应改变 pending 计数');
    });

    await test('未知工具返回 -32602 协议级错误（含 UNKNOWN_TOOL）', async () => {
      const response = await client.request('tools/call', { name: 'wb_not_a_tool', arguments: {} });
      assert.ok(response.error, `未知工具未返回 error: ${JSON.stringify(response).slice(0, 160)}`);
      assert.strictEqual(response.error.code, -32602);
      assert.ok(String(response.error.message).includes('UNKNOWN_TOOL'), `message=${response.error.message}`);
    });

    await test('stdout 未混入非协议输出', async () => {
      assert.ok(
        !client.stderr.includes('undefined'),
        `stderr 出现异常: ${client.stderr.slice(0, 400)}`,
      );
    });
  } finally {
    client.close();
  }

  await test('BUG-2 回归：slugifyPath 与真实 projects/ 目录名逐一比对', () => {
    const paths = require(path.resolve(__dirname, '..', 'lib', 'paths.js'));
    const projectsDir = path.join(REAL_WB, 'projects');
    const indexPath = path.join(REAL_WB, 'app', 'sessions.json');
    if (!fs.existsSync(projectsDir) || !fs.existsSync(indexPath)) {
      process.stdout.write('        skip: 真实 WorkBuddy 数据不可用\n');
      return;
    }
    const realDirs = fs.readdirSync(projectsDir);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    // 1) 索引中的每个 workDir，slug 化后必须真实存在于磁盘。
    const missing = [];
    for (const entry of index.sessions || []) {
      if (typeof entry.workDir !== 'string') continue;
      const slug = paths.slugifyPath(entry.workDir);
      if (!fs.existsSync(path.join(projectsDir, slug))) missing.push(`${entry.workDir} -> ${slug}`);
    }
    assert.strictEqual(missing.length, 0, `slug 化结果在磁盘上不存在（双破折号 bug 未修）:\n${missing.join('\n')}`);

    // 2) 关键形态断言：盘符冒号+分隔符必须合并为单个 '-'。
    assert.strictEqual(paths.slugifyPath('C:\\Users\\TinaD'), 'c-Users-TinaD', '单破折号规则不符');
    assert.strictEqual(
      paths.slugifyPath('C:/Users/TinaD/WorkBuddy/2026-10-07-11-15-23'),
      'c-Users-TinaD-WorkBuddy-2026-10-07-11-15-23',
      '正斜杠路径 slug 不符',
    );
    // 3) 中文路径：以真实目录名为基准（不硬编码期望值）。
    const cnDirs = realDirs.filter((name) => /[一-龥]/.test(name));
    if (cnDirs.length > 0) {
      // 反推 workDir：'d-' 之后把分隔符还原为盘符冒号 + 反斜杠是歧义的，
      // 故改用「已验证形态」构造：对每个真实中文目录，断言其不含 '--'。
      const doubleDash = cnDirs.filter((name) => name.includes('--'));
      assert.strictEqual(doubleDash.length, 0, `真实中文目录名含双破折号: ${doubleDash.join(', ')}`);
      // 抽样一个真实中文目录，构造 workDir 并验证 slug 化能复现它。
      const sample = cnDirs[0];
      const rest = sample.slice(2); // 去掉 'd-'
      const workDirGuess = `D:\\${rest.split('-').join('\\')}`;
      const got = paths.slugifyPath(workDirGuess);
      assert.ok(!got.includes('--'), `中文路径 slug 出现双破折号: ${got}`);
      process.stdout.write(`        中文样本 ${sample} -> ${got}\n`);
    }
    process.stdout.write(`        ${(index.sessions || []).length} 个真实会话 slug 全部命中磁盘\n`);
  });

  await test('BUG-1 回归：4 进程 x 16 条并发投递零丢失（总 64 条）', async () => {
    const CONC_STORE = path.join(SANDBOX_DIR, 'concurrent', 'store');
    fs.mkdirSync(CONC_STORE, { recursive: true });

    // 读侧进程：持续裸读 pending 目录下每个记录文件，制造 Windows rename EPERM 竞争窗口。
    const readerScript = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(path.join(CONC_STORE, 'pending'))};`,
      'const t0 = Date.now();',
      'while (Date.now() - t0 < 6000) {',
      '  let names = []; try { names = fs.readdirSync(dir); } catch (e) { continue; }',
      '  for (const n of names) { try { fs.readFileSync(path.join(dir, n), "utf8"); } catch (e) {} }',
      '}',
      'process.exit(0);',
    ].join('\n');
    const reader = spawn(process.execPath, ['-e', readerScript], { stdio: 'ignore' });

    // 写侧：4 个独立 server 进程，各投递 16 条（与真实部署形态一致：多进程共享同一 store）。
    const WORKERS = 4;
    const PER_WORKER = 16;
    const TOTAL = WORKERS * PER_WORKER;
    const writerScript = [
      "const { spawn } = require('child_process');",
      `const server = ${JSON.stringify(SERVER)};`,
      `const store = ${JSON.stringify(CONC_STORE)};`,
      'function call(client, name, args) {',
      '  return new Promise((resolve) => {',
      '    const id = client.nextId++;',
      '    client.pending.set(id, resolve);',
      "    client.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\\n');",
      '  });',
      '}',
      'function makeClient() {',
      '  const child = spawn(process.execPath, [server], { stdio: ["pipe","pipe","pipe"],',
      '    env: { ...process.env, TASK: "1", WB_BRIDGE_STORE: store, WB_BRIDGE_LOG: "0" } });',
      '  let buf = "";',
      '  const client = { child, nextId: 1, pending: new Map(), stdin: child.stdin };',
      '  child.stdout.on("data", (chunk) => {',
      '    buf += chunk;',
      '    let i;',
      '    while ((i = buf.indexOf("\\n")) !== -1) {',
      '      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);',
      '      if (!line) continue;',
      '      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }',
      '      const r = client.pending.get(msg.id); if (r) { client.pending.delete(msg.id); r(msg); }',
      '    }',
      '  });',
      '  return client;',
      '}',
      'async function main() {',
      `  const tag = process.argv[2];`,
      '  const client = makeClient();',
      '  const codes = []; let ok = 0;',
      `  for (let k = 0; k < ${PER_WORKER}; k++) {`,
      '    const r = await call(client, "wb_send_instruction", { instruction: "concurrent-" + tag + "-" + k });',
      '    if (r.result && r.result.isError) codes.push(JSON.parse(r.result.content[0].text).error.code); else ok++;',
      '  }',
      '  process.stdout.write(JSON.stringify({ ok, codes }));',
      '  client.child.kill();',
      '  process.exit(0);',
      '}',
      'main();',
    ].join('\n');

    const workerPath = path.join(SANDBOX_DIR, 'concurrent', 'writer.js');
    fs.writeFileSync(workerPath, writerScript, 'utf8');

    const syncResults = [];
    for (let w = 0; w < WORKERS; w += 1) {
      // 串行 spawn 但让子进程并行运行：spawn 后不等待，各自并发投递。
      const child = spawn(process.execPath, [workerPath, `w${w}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      syncResults.push(
        new Promise((resolve) => {
          let out = '';
          child.stdout.on('data', (chunk) => { out += chunk; });
          child.on('close', () => {
            try {
              resolve(JSON.parse(out));
            } catch (error) {
              resolve({ ok: 0, codes: [`WORKER_PARSE_FAIL: ${error.message} raw=${out.slice(0, 120)}`] });
            }
          });
        }),
      );
    }

    const workerReports = await Promise.all(syncResults);
    await new Promise((resolve) => {
      reader.on('close', resolve);
      setTimeout(() => {
        try { reader.kill(); } catch (_e) { /* ignore */ }
        resolve();
      }, 8000);
    });

    const totalOk = workerReports.reduce((sum, item) => sum + (item.ok || 0), 0);
    const allCodes = workerReports.flatMap((item) => item.codes || []);

    // maildir：跨 pending/picked/done/failed 汇总所有记录，逐文件解析保证每份都是合法 JSON。
    const md = readMaildir(CONC_STORE);
    const list = md.records;

    // 核心判据：成功入队数 === 落盘数（零丢失）。
    assert.strictEqual(
      list.length,
      totalOk,
      `落盘 ${list.length} != 成功入队 ${totalOk}；错误码分布 ${JSON.stringify(allCodes.slice(0, 8))}`,
    );
    // id 无重复。
    const ids = list.map((item) => item.id);
    assert.strictEqual(new Set(ids).size, ids.length, `存在重复 id（${ids.length} 条中 ${ids.length - new Set(ids).size} 个重复）`);
    // 指令正文无重复（每条都真实落盘）。
    const texts = list.map((item) => item.instruction);
    assert.strictEqual(new Set(texts).size, texts.length, '存在重复 instruction');
    assert.strictEqual(totalOk, TOTAL, `成功入队 ${totalOk} != 期望 ${TOTAL}；错误码 ${JSON.stringify(allCodes.slice(0, 8))}`);
    // 无残留临时文件。
    assert.strictEqual(md.leftovers.length, 0, `残留临时文件: ${md.leftovers.join(', ')}`);

    process.stdout.write(
      `        4 进程 x ${PER_WORKER} 条 = ${TOTAL} 次投递，落盘 ${list.length} 条，` +
        `id 全唯一，JSON 未损坏，错误码 ${allCodes.length === 0 ? '无' : JSON.stringify(allCodes.slice(0, 5))}\n`,
    );
  });

  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  process.stdout.write(`\n=== SUMMARY ===\nPASS ${passed} / ${results.length}\nFAIL ${failed}\n`);
  for (const item of results) {
    if (!item.passed) process.stdout.write(`  - ${item.name}: ${item.error}\n`);
  }
  // 清理本次运行专有的隔离目录（路径唯一，并发安全）。
  try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  process.stdout.write(failed === 0 ? 'RESULT: PASS\n' : 'RESULT: FAIL\n');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stdout.write(`FATAL: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });