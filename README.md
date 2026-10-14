# workbuddy-session-bridge

WorkBuddy 会话桥接连接器 —— 一个**零第三方依赖**的 MCP stdio Server，让外部本机 agent（Codex CLI 等 MCP 客户端）
**读取** WorkBuddy 本机会话的对话输出，并**投递**新指令给 WorkBuddy 侧消费。

## ⚠️ 能力边界（先读这一节）

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| 读取本机会话索引（`~/.workbuddy/app/sessions.json`） | ✅ | 只读 |
| 读取会话消息（`projects/<slug>/<conversationId>.jsonl`） | ✅ | 只读，默认剥离 `<system-reminder>` 系统附加块 |
| 读取子代理记录（`<conversationId>/subagents/*.jsonl`） | ✅ | 只读，`includeSubagents=true` 时返回 |
| 关键词搜索历史会话 | ✅ | 启发式，只扫最近 N 个会话、每个文件末尾 M 字节 |
| **直接向 WorkBuddy 会话下发并执行指令** | ❌ | **做不到，见下** |
| 向指令队列投递指令（WorkBuddy 侧取件执行） | ✅ | 本连接器的写入能力**仅此一种** |
| 读写 `workbuddy.db` / `-wal` / `-shm` | ❌ | 硬性禁止，会损坏客户端运行时状态 |
| 修改 WorkBuddy 进程内部状态 | ❌ | 明确不做 |

**为什么不能直接下发指令？**

WorkBuddy 桌面端 `resources/wb-guest-sdk/wb.js` 里确实存在 `sendPrompt` / `runPrompt`，但它们通过
`postMessage({type:"wb:invoke:request"})` 走 **Electron 渲染进程内 bridge**（配 `bridgeAuto:!0`），
属于桌面端私有 RPC。**外部进程无法触达**，也不应尝试改动其内部状态。

因此本连接器采用 **「投递队列 + WorkBuddy 侧取件」** 模式：

```
外部 agent (Codex CLI)                本连接器                   WorkBuddy 内的 agent
      │                                  │                              │
      │── wb_send_instruction ─────────▶│ 写入队列 pending/<id>.json   │
      │                                  │                              │
      │                                  │◀── wb_pending_instructions ──│（取件，置 picked）
      │                                  │                              │ 执行指令
      │◀──────────── 后续 wb_bridge_info / wb_instruction_stats ───────│
      │                                  │◀── wb_complete_instruction ──│（回填 done/failed）
```

换句话说：**`wb_send_instruction` 是"投递"不是"下达"**。指令要真正被执行，必须由 WorkBuddy 内的
agent（或用户）主动调用 `wb_pending_instructions` 取件。

---

## 快速开始

```bash
# 无需 npm install（零依赖）
node server.js            # 启动 MCP stdio Server
node test/smoke-test.js   # 跑冒烟测试（写操作隔离到临时目录）
```

要求 Node.js ≥ 18（已在 v22.22.2 上验证）。

## 项目结构

```
workbuddy-session-bridge/
├── server.js              # MCP stdio 入口：JSON-RPC 方法分发
├── lib/
│   ├── protocol.js        # 换行分隔 JSON-RPC 2.0 传输 + AppError + 错误码
│   ├── paths.js           # 路径布局、workDir → slug 化、受保护文件拦截
│   ├── jsonl.js           # JSONL 读取：坏行容错、system-reminder 剥离、长度截断
│   ├── sessions.js        # 只读会话访问层：索引 / 项目目录 / 搜索
│   ├── store.js           # 指令队列：maildir（每记录独立文件 + link/unlink 原子领取）
│   └── tools.js           # 8 个 MCP 工具的 schema 与分发
├── test/
│   ├── smoke-test.js      # 零依赖冒烟测试（22 个用例）
│   └── qa-verify.js       # 独立 QA 验证套件（80 个用例）
└── package.json           # 无 dependencies
```

## MCP 协议

stdio 传输 = **换行分隔的 JSON-RPC 2.0**（每行一个 JSON，无 `Content-Length` 头）。

| 方法 | 行为 |
| --- | --- |
| `initialize` | 返回 `protocolVersion` / `capabilities.tools` / `serverInfo` / `instructions` |
| `notifications/initialized` | 通知，无响应 |
| `tools/list` | 返回 8 个工具的 JSON Schema |
| `tools/call` | `{name, arguments}` → `{content:[{type:"text", text:"<json>"}]}` |
| `ping` | 返回 `{}` |
| 其他 | 返回 `-32601 Method not found` |

业务错误以 `isError: true` + `{"error":{"code","message","details"}}` 返回（不抛 JSON-RPC 错误）。
**协议级错误**（未知工具、参数类型/结构不合法）例外：按 JSON-RPC 规范返回 `-32602` error 响应（不是 `isError`）。
错误码：`INVALID_ARGUMENT` / `INVALID_CONVERSATION_ID` / `PATH_OUT_OF_ROOT` / `SESSION_NOT_FOUND` /
`INSTRUCTION_NOT_FOUND` / `INSTRUCTION_ALREADY_FINAL` / `INSTRUCTION_CLAIM_LOST` / `UNKNOWN_TOOL` / `STORE_READ_FAILED` /
`STORE_WRITE_FAILED` / `STORE_RENAME_FAILED` / `RECORD_CORRUPT` / `STORE_CONFIG_INVALID` / `INTERNAL_ERROR`。

> `STORE_RENAME_FAILED` 现覆盖「原子改名 / 硬链接迁移」两类失败（含领取后删除旧名失败），重试耗尽即抛，**绝不静默丢指令**。
> `INSTRUCTION_CLAIM_LOST` 表示并发领取冲突导致记录**未被完成**（例如并发的领取被回滚撤销），属**可重试**错误——
> 与 `INSTRUCTION_ALREADY_FINAL`（已确认终态）严格区分，调用方据此决定重试而非误判「已完成」。
> `RECORD_CORRUPT` 表示队列中存在无法解析的 JSON 记录（只统计上报，**不移动不删除**）。
> `STORE_CONFIG_INVALID` 表示 `WB_BRIDGE_STORE` 指向了非法位置（如 `.json` 文件路径），启动即失败、零副作用。

---

## 工具清单（8 个）

### 读取类

#### 1. `wb_list_sessions`

列出 WorkBuddy 本机会话。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer | `20` | 最多返回的会话数 |
| `workDir` | string | — | 按工作目录精确过滤（大小写不敏感） |
| `includeCounts` | boolean | `true` | 是否统计 jsonl 行数 |

返回：`{ indexReadable, indexPath, totalInIndex, returned, sessions: [{ conversationId, workDir, startedAt, resumedAt, messageCount, messageCountEstimated, sizeBytes, lastActivityAt, projectDir, fileExists }] }`

> `messageCount`：文件 ≤ 4MB 时精确计数；更大时按尾部 512KB 采样外推，
> 此时 `messageCountEstimated: true`。`lastActivityAt` 取 jsonl 的 mtime。

#### 2. `wb_read_session`

读取指定会话的消息列表。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `conversationId` | string | **必填** | 会话 ID。仅接受 `[A-Za-z0-9._-]`、长度 ≤128、不含路径分隔符与 `..`，否则 `INVALID_CONVERSATION_ID` |
| `maxMessages` | integer | `40` | 最多返回的消息数（取**末尾**） |
| `maxChars` | integer | `4000` | 每条消息文本最大字符数 |
| `includeSystemReminders` | boolean | `false` | 是否保留 `<system-reminder>` 系统附加块 |
| `includeSubagents` | boolean | `false` | 是否附带子代理摘要 |

返回：`{ conversationId, workDir, projectDir, filePath, resolvedVia, totalMessages, returnedMessages, truncatedTail, skipped, removedSystemReminderMessages, messages: [{ index, role, text, timestamp, time, id, textLength, truncated, hadSystemReminder }], subagents, notes }`

> **容错**：会话文件正被 WorkBuddy 持续追加，末行常为半截 JSON —— 解析失败的行被跳过并计入
> `skipped`，绝不崩溃。
> **默认降噪**：`<system-reminder>` 系统附加块（OS 版本、identity 上下文等）体积巨大且与业务无关，
> 默认整体剥离，被剥离的消息数记在 `removedSystemReminderMessages`。
> **路径校验**：`conversationId` 走白名单校验（不允许路径分隔符与 `..`），且最终路径会二次确认仍在
> `projects/` 之内，确保不会读取到该目录之外的 `.jsonl`。

#### 3. `wb_search_sessions`

在最近若干会话中做关键词子串搜索。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | **必填** | 搜索词（大小写不敏感的子串） |
| `limit` | integer | `20` | 最多返回的命中条数 |
| `maxSessions` | integer | `20` | 最多扫描的会话数（按 `resumedAt` 倒序） |
| `maxBytesPerSession` | integer | `2097152` (2MB) | 每个文件最多读取的**尾**字节数 |

返回：`{ keyword, hits: [{ conversationId, workDir, messageIndex, role, time, snippet }], hitCount, scope, heuristicNote }`

> **这是启发式搜索**：只覆盖最近 `maxSessions` 个会话、每个文件的末尾 `maxBytesPerSession` 字节，
> 不保证全量命中。定位到会话后请用 `wb_read_session` 精读。

### 写入类（指令投递）

#### 4. `wb_send_instruction`

向指令队列追加一条指令（**仅写自己的 bridge 目录**）。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `instruction` | string | **必填** | 指令正文 |
| `sessionId` | string | — | 指定投递到哪个会话（WorkBuddy 侧可按会话过滤取件） |
| `priority` | `"low"\|"normal"\|"high"` | `"normal"` | 优先级，取件时 `high` 优先 |
| `metadata` | object | — | 附加元数据，原样存储 |

返回：`{ instructionId, status: "queued", queueStatus: "pending", createdAt, position, queueDepth, delivery, nextStep }`

队列中的指令结构：

```jsonc
{
  "id": "uuid-v4",
  "instruction": "指令正文",
  "sessionId": null,              // 可选
  "status": "pending",            // pending | picked | done | failed
  "priority": "normal",
  "createdAt": "2026-10-07T12:00:00.000Z",
  "pickedAt": null,
  "completedAt": null,
  "result": null,
  "metadata": null
}
```

#### 5. `wb_pending_instructions`

拉取待处理指令（**WorkBuddy 侧消费入口**）。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | string | — | 只拉取投递给该会话的指令 |
| `limit` | integer | `10` | 最多拉取条数 |
| `markPicked` | boolean | `true` | 是否置为 `picked` 并写 `pickedAt` |

返回：`{ instructions: [...], count, markPicked, remainingPending, corruptPending }`

> `markPicked=true` 时为**原子领取**：每条经 `link(pending/<id> → picked/<id>)` 竞争，只有抢到的才会出现在结果里
> （并发消费者不会重复领取同一条）。`markPicked=false` 为**纯预览**：只读 pending 目录、零写入、不改变任何状态。
> 拉取**不超过** `limit` 条；高并发下单次可能少于 `limit`（竞争失败者让位），定向消费者可循环拉取直到 `count=0`。

#### 6. `wb_complete_instruction`

回填执行结果。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `instructionId` | string | **必填** | 指令 ID |
| `result` | any | `null` | 执行结果（任意 JSON 值） |
| `status` | `"done"\|"failed"` | `"done"` | 终态 |

返回：更新后的完整指令记录。已处于终态会返回 `INSTRUCTION_ALREADY_FINAL`；若因并发领取被回滚而**未完成**则返回可重试的 `INSTRUCTION_CLAIM_LOST`（表明记录会被再次投递，应重试而非视作已完成）。

### 辅助类

#### 7. `wb_instruction_stats`

无参数。返回 `{ storeRoot, storeVersion, storeExists, total, counts: {pending, picked, done, failed}, oldestPendingAt, latestCreatedAt, corruptDetected, corrupt, corruptFiles, validStatuses }`。

> **严格只读**：本工具不创建目录、不写入、不移动文件；损坏记录以 `corrupt` / `corruptFiles` 显式上报，绝不当作「空队列」。

#### 8. `wb_bridge_info`

无参数。返回连接器诊断信息：`paths`（bridge 目录 / store 根目录 / 索引路径）、`pathSources`、
`sandboxed`、`readAccess`（索引可读性 / 会话总数 / 项目目录数 / 受保护文件清单）、
`capabilityBoundary`（能力边界三元组 `canRead` / `canWrite: "queue-only"` /
`canDriveWorkBuddySessionDirectly: false` + 原因列表）、`tools`。

---

## 配置示例

### (a) Codex CLI —— `~/.codex/config.toml`

```toml
[mcp_servers.workbuddy-session-bridge]
command = "C:\\Users\\TinaD\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe"
args = ["C:\\Users\\TinaD\\WorkBuddy\\2026-10-07-11-15-23\\workbuddy-session-bridge\\server.js"]

[mcp_servers.workbuddy-session-bridge.env]
# 可选：把队列**根目录**指到别处（默认 %USERPROFILE%\.workbuddy\task-bridge）
# 注意：WB_BRIDGE_STORE 是**目录**，不是 .json 文件；指向 .json 或已存在文件会被拒绝（STORE_CONFIG_INVALID）。
# WB_BRIDGE_STORE = "C:\\Users\\TinaD\\.workbuddy\\task-bridge"
# 可选：设为 "0" 关闭 stderr 诊断日志
# WB_BRIDGE_LOG = "1"
```

### (b) WorkBuddy —— `C:\Users\TinaD\.workbuddy\mcp.json`

```json
{
  "mcpServers": {
    "workbuddy-session-bridge": {
      "command": "C:\\Users\\TinaD\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe",
      "args": [
        "C:\\Users\\TinaD\\WorkBuddy\\2026-10-07-11-15-23\\workbuddy-session-bridge\\server.js"
      ],
      "env": {
        "WB_BRIDGE_LOG": "1"
      }
    }
  }
}
```

> 两个进程必须指向**同一个**队列根目录，队列才闭环。默认路径相同即满足。

---

## WorkBuddy 侧如何消费队列（agent 提示词示例）

把下面这段放进 WorkBuddy 内 agent 的系统提示词 / 项目指令里：

```
你可以通过 MCP 工具 workbuddy-session-bridge 接收外部 agent 投递的指令。

工作流：
1. 每一轮开始时（或用户说「看看外部有什么指令」时），调用 wb_pending_instructions 拉取待处理指令。
   - **若你是「定向消费者」**（只处理投递给某个会话的指令）：**必须在领取前**传入 sessionId，
     即 wb_pending_instructions({ sessionId: "<当前会话ID>", limit: 5, markPicked: true })。
     否则你会把别的会话的指令也置为 picked，导致它们对你不可见、对原会话又已被领走（滞留）。
   - 通用消费者（处理全部指令）可不传 sessionId：wb_pending_instructions({ limit: 5, markPicked: true })。
   - 只想先看看有什么（不改变状态）：markPicked: false 做纯预览。
2. 若 count=0，说明没有新指令，正常继续当前任务即可。
3. 若 count>0，逐条执行 instructions[].instruction。
   - metadata 里若有 deadline 等约束，优先满足。
   - 由于已在领取时按 sessionId 过滤，这里通常无需再跳过；若确实拿到不属于自己的指令，用 result 说明后跳过。
4. 每条执行完立刻调用 wb_complete_instruction 回填：
   - 成功：status="done"，result={"summary":"<不超过 200 字的结果摘要>","artifacts":["相关文件路径"]}
   - 失败：status="failed"，result={"error":"<失败原因>","retryable":true|false}
5. 全部回填完成后，向用户汇报：处理了几条、成功几条、失败几条。

注意：
- wb_send_instruction 只是「投递队列」，你无法被外部 agent 直接驱动；
  指令必须由你主动取件才会执行。
- 拉取时默认已置为 picked；若执行前中断，请用 wb_instruction_stats
  查看是否有长期滞留的 picked 指令并手工用 wb_complete_instruction 收尾。
- 需要了解外部 agent 的意图时，用 wb_read_session / wb_search_sessions
  读取历史会话上下文，而不是猜测。
```

---

## 并发与存储

### maildir 队列布局（每记录独立文件）

队列是一个**目录**（默认 `%USERPROFILE%\.workbuddy\task-bridge`，可用 `WB_BRIDGE_STORE` 覆盖）：

```
<storeRoot>/
├── pending/<id>.json   待取件（wb_send_instruction 落入此处）
├── picked/<id>.json    已被某消费者领取
├── done/<id>.json      已完成
├── failed/<id>.json    已失败
└── tmp/<...>.tmp       写入暂存区（只在此产生半成品）
```

- **互斥模型**：**每记录独立文件 + 原子硬链接（link+unlink）**。目录名即状态（权威来源），文件名即记录 ID。
- **投递**（`wb_send_instruction`）：写 `tmp/<id>.<rand>.tmp` → `rename` 到 `pending/<id>.json`；回执在 rename 成功后才返回。
- **领取**（`wb_pending_instructions` markPicked=true）：`link(pending/<id> → picked/<id>)`，
  **目标已存在（EEXIST）即竞争失败**，随后 `unlink(pending/<id>)`。链接成功瞬间目标即拥有完整内容，**无半截文件窗口**。
- **回填**（`wb_complete_instruction`）：两阶段 —— 先确保记录在 `picked`（对 `picked/<id>` 互斥领取），
  再 `link(picked/<id> → done|failed/<id>)`。这样「取件 pending→picked」与「回填 pending→done」
  不会因目标不同而各写一份。
- **为什么领取用 `link` 而不是 `rename`**：Windows/libuv 上并发对**同一源、同一目标** `fs.renameSync`
  会偶发「两个调用都返回成功」的幻影 OK（实测 4 并发约 2 个返回成功），即 **rename 不能充当互斥领取原语**；
  而 `linkSync` 在目标存在时**确定性**返回 EEXIST。实测 6 进程 × 30 轮并发领取恒为**恰好一个成功者**。
- **无锁、无锁龄、无心跳**：不存在「读到旧快照再整体覆盖」的丢失路径，也不需要任何等待/超时数值。

- **原子操作退避重试**：Windows 上目标被另一进程打开读取时 `rename` / `link` / `unlink` 会抛 `EPERM`/`EACCES`/`EBUSY`。
  这些操作统一带**指数退避 + 抖动**（8 次、2ms 起、封顶 64ms，含抖动最坏 **238ms**）。
  重试耗尽后抛 `STORE_RENAME_FAILED` 结构化错误并清理临时文件 —— **绝不静默丢指令**。
- **可靠性预算不变量**（`store.assertBudgetInvariant()` 在**加载期强制**，不等即抛错）：

  ```
  单条迁移最坏退避 238ms  <  单条迁移预算 400ms  <  单次操作预算 30000ms  <  存储操作硬截止 60000ms
  ```

  并额外断言 `单条迁移预算(400) × 最大迁移数(50) ≤ 单次操作预算(30000)`。
  该不变量由代码断言守护：日后任何人调大退避参数而忘记同步调整其它参数时，会在加载时立刻失败，
  而不是重新引入偶发不稳定。**注意**：这些预算只约束配置退避的时长，**不冒充**「进程暂停」的安全证明。

- **严格只读操作**：`wb_instruction_stats` 与 `wb_pending_instructions`（`markPicked=false` 预览）
  不 mkdir、不写入、不移动、不 rename；损坏记录**不移动不删除**，以 `corrupt` / `corruptFiles` 显式上报。
- **会话 ID 白名单**：`conversationId` 必须是「安全名字」形态 —— 只允许 `[A-Za-z0-9._-]`、
  长度 ≤ 128、**不含任何路径分隔符与 `..`**、**不是 Windows 保留设备名**（`CON`/`NUL`/`COM1`…，
  含 `CON.jsonl` 这类带扩展名的形式），否则返回 `INVALID_CONVERSATION_ID`。
  最终路径还会用 `assertWithinRoot` 二次确认规范化结果仍在 `projects/` 之内（双重保险）。
  > 刻意**不**强制 UUID 形态：实测 `projects/` 下约 10% 的真实会话 ID 是 32 位无连字符 hex
  > （形如 `0210327a89244abea944d98682323895`），纯 UUID 白名单会让这部分真实会话不可读。
- **workDir 入口校验**：拒绝 NUL/控制字符与超长输入（`INVALID_WORKDIR`）；允许中文路径
  （真实路径含 `4、董娣相关` 等）。真正的兜底仍是 `assertWithinRoot`。
- **必填参数**：`instruction` / `instructionId` 走 `requiredString`，缺失、空串、纯空白一律拒绝
  `INVALID_ARGUMENT`，不会产生空指令。
- **写操作范围**：只写 bridge 自己的目录。对 WorkBuddy 数据（`sessions.json` / `*.jsonl`）
  只有 `stat` / `readdir` / `readFileSync`，且经 `assertSafeReadable` 拦截
  `workbuddy.db`、`workbuddy.db-wal`、`workbuddy.db-shm`、`workbuddy.db-journal`。
- **stdout 洁净**：stdout 只输出 JSON-RPC 消息，所有日志走 stderr（`console.log` 全程未使用）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_BRIDGE_STORE` | — | 队列**根目录**完整路径（优先级最高）。指向 `.json` 或已存在的文件会被拒绝（`STORE_CONFIG_INVALID`），且**零副作用** |
| `WB_BRIDGE_DIR` | — | 指定 bridge 根目录 |
| `TASK` | — | 任意真值即隔离模式，bridge 目录重定向到系统临时目录 |
| `WB_BRIDGE_LOG` | 非 `"0"` | 设为 `"0"` 关闭 stderr 日志 |
| `WB_PROJECTS_DIR` | `~/.workbuddy/projects` | 覆盖只读数据源（诊断用） |
| `WB_SESSIONS_INDEX` | `~/.workbuddy/app/sessions.json` | 覆盖只读数据源（诊断用） |
| `WB_WORKBUDDY_DIR` | `~/.workbuddy` | 覆盖 WorkBuddy 根目录 |

## 测试

```bash
"C:\Users\TinaD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" test/smoke-test.js
```

22 个用例，覆盖：`initialize` → `tools/list`（断言 8 个工具名与 schema）→ 逐个 `tools/call` →
指令三段闭环（`pending` → `picked` → `done`）→ 真实会话读取与搜索命中 → 三组缺陷回归：

- **BUG-1 并发零丢失**：4 个 server 子进程各投递 16 条（共 64 条），同时有独立进程持续裸读 store
  制造 Windows `rename` EPERM 竞争窗口；断言落盘数 === 成功入队数、id 全唯一、JSON 未损坏、无残留临时/锁文件。
- **BUG-2 slug 规则**：以 `~/.workbuddy/projects/` 下的**真实目录名**与真实 `sessions.json` 为基准
  逐条校验 slug 化结果在磁盘上存在，并覆盖中文目录（`d-OneDrive-4、董娣相关-4、专利知识库`）。
- **BUG-3 越级路径**：在隔离目录外侧放置测试文件 `.jsonl`（含标记值），6 种越级/非法 `conversationId`
  全部被拒且外部文件内容未出现在响应中；另覆盖 10 种 Windows 设备名（含 `CON.jsonl`）在单元级被拦截，
  同时验证 4 个真实非 UUID 会话 ID 仍可放行（未回退 UUID 白名单）。
- **BUG-4 空指令**：缺失 / 空串 / 纯空白 / `\t\n ` 四种输入全部拒绝，且队列总数不变。

测试通过 `TASK=1` + `WB_BRIDGE_STORE=<临时目录>/store` 把写操作隔离到
`%TEMP%\wb-session-bridge-smoke\`，**不向任何真实 WorkBuddy 目录写入**；
只读访问真实 `sessions.json` 与**至多 1 个**真实会话 jsonl。

另有 QA 独立验证脚本 `test/qa-verify.js`（80 用例，零依赖，与本 smoke-test 无共享代码），
覆盖 syscall 级写入边界审计、协议合规、并发原子性（含**并发领取唯一性**与**状态机无重复**）、缺陷回归。