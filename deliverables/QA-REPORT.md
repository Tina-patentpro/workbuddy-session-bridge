# QA 独立验证报告 —— workbuddy-session-bridge

> **性质说明**：本文档记录一次**软件工程质量验证**（正确性 / 可靠性 / 健壮性），
> 全部测试在**本机离线**运行、不访问网络、不涉及任何外部系统。
> 本文档为**历史记录**（含当时被推翻的判断与假设，留痕），不代表当前最终状态；当前状态见 `REMEDIATION.md`。

| 项 | 值 |
| --- | --- |
| 被测对象 | `C:\Users\TinaD\WorkBuddy\2026-10-07-11-15-23\workbuddy-session-bridge\` |
| 验证脚本 | `test/qa-verify.js`（77 用例，零依赖，独立于 `test/smoke-test.js`） |
| 辅助工具 | `test/helpers/write-audit.js`（fs 写 syscall 审计 preload，仅测试用） |
| 运行环境 | Node v22.22.2-6 / win32，真实数据 = `C:\Users\TinaD\.workbuddy\`（23 个项目目录、70 个 jsonl、最大 167MB） |
| 执行日期 | 2026-10-07 |
| **总计** | **77 用例 | PASS 73 | FAIL 4（94.8%）** |
| 复跑一致性 | 连续 2 次结果一致（PASS 73 / FAIL 4） |
| **智能路由判定** | **Engineer** —— 4 个失败项全部为源码 Bug，其中 1 个 P0、2 个 P1、1 个 P2 |

## 结论摘要

工程师的 18/18 冒烟测试在**它自己设定的断言范围内**是成立的，但存在盲区。QA 独立验证发现
**4 个真实缺陷**，其中最严重的一个会在真实部署形态下**静默丢失用户投递的指令**。

同时，本轮验证对工程师的正面结论予以确认（这些是冒烟测试没覆盖、但我实测通过的部分）：

- **受保护文件边界有效**：`workbuddy.db` 及 `-wal`/`-shm`/`-journal` 在 `assertSafeReadable` 层被拦截，
  且**大小写变体也无法通过**（`lib/paths.js:137` 先 `toLowerCase()` 再比对）。
  经 `tools/call` 用 5 种 db 路径输入均返回 `SESSION_NOT_FOUND`，未读到任何 db 内容。
- **协议流未被文本内容污染**（重点输入项，未触发致命 bug）：会话文本中的裸 `\n`、`\r\n`、`"`、
  `\` 均被 `JSON.stringify` 正确转义，**响应始终是单行合法 JSON**。
  实测 8 条含换行的大消息（28323 字节）与单条 800KB 消息截断后均为 1 行。
- **只读前提下的容错健壮**：半截 JSON 末行、空文件、仅 session-meta、缺字段、未知 content type、
  混入 `[1,2,3]`/`"str"`/`12345`/`null` 等非法行，均不崩溃且 `skipped` 计数正确。
- **JSON-RPC 错误码规范**：-32700 / -32600 / -32601 / -32602 全部正确，服务在 20 次连续畸形输入后仍健康。
- **锁语义正确**：陈旧锁（mtime 15 秒前）被抢占；活锁重试耗尽后返回明确 `LOCK_TIMEOUT`（不静默失败）。
- **原子写本身有效**：14550 次并发读取**从未**读到半截 JSON（tmp+rename 的设计是对的）。
- **交付完整性**：README 的工具名/参数/错误码清单/配置片段与实现一致，8 个工具手工 JSON-RPC 全部调通。

---

## 失败项（4 个，均为源码 Bug）

### 【P0】BUG-1：并发读存在时 `rename` 报 EPERM，指令被静默丢弃

- **位置**：`lib/store.js:113-120`（`writeRaw` 中的 `fs.renameSync`）
- **影响面**：`wb_send_instruction` / `wb_pending_instructions` / `wb_complete_instruction` 全部写入路径。
  外部 agent 投递的指令**没有任何提示地消失**——调用方拿到的是成功或一个可被忽略的
  `STORE_WRITE_FAILED`，而指令从未进入队列。WorkBuddy 侧永远等不到这条指令。
- **根因**：Windows 上当目标文件被其它进程打开读取时，`rename(over)` 会失败（EPERM / EBUSY）。
  `writeRaw` **没有任何重试**，直接抛 `STORE_WRITE_FAILED`。
  这不是"隔离目录内的极端时序"，而是**本连接器的目标部署形态**：
  README 设计里明确写了两进程模型——「两个进程必须指向同一个 instructions.json」，
  即 Codex 侧写、WorkBuddy 侧读。读侧只要在写的瞬间持有文件句柄，写侧就丢数据。
- **复现步骤**（`test/qa-verify.js` D12-6，已固化）：
  1. 进程 A 循环 `readFileSync(store)` 持续读 4 秒；
  2. 进程 B 用 `wb_send_instruction` 连续投递 60 条；
  3. 结果：**落盘 51~55 条，丢失 5~9 条**（多次运行波动），错误码全为
     `STORE_WRITE_FAILED | 原子写入失败: EPERM: operation not permitted, rename ...`。
  丢失率约 **8%~15%**。
- **补充实测（D12-7）**：当读侧改用 bridge 自己的工具（`wb_instruction_stats` /
  `wb_pending_instructions`）而非裸 `fs` 时，本次运行丢失 0 条。
  说明触发条件是**读侧持有句柄的时刻**，bridge 内部 `readFileSync` 是同步短读，命中概率较低但非零。
  **不能据此认为安全**——只要 WorkBuddy 侧任何一次取件恰好与投递重叠就会丢。
- **修复建议**：`writeRaw` 的 rename 增加有限重试（例如 5 次、指数退避 10/20/40/80/160ms），
  覆盖 Windows 的瞬时共享冲突；或改用 `fs.copyFileSync` + 降级方案。
  同时建议把 rename 失败时的 `tmp` 文件保留一段时间（而非立即 unlink）以便人工恢复。

### 【P1】BUG-2：`slugifyPath` 双破折号，索引路径 100% 失效

- **位置**：`lib/paths.js:28`（`SLUG_REPLACED_CHARS = /[\\/:]/g`）+ `lib/paths.js:45`
- **根因**：WorkBuddy 的真实规则是「盘符冒号 + 紧随的分隔符合并为**单个** `-`」，
  即 `C:\Users` → `c-Users`。当前实现把 `:` 和 `\` **各自**替换成一个 `-`，
  于是 `C:\Users\TinaD` → `c--Users-TinaD`（双破折号）。
- **实证**（A4-1，对真实 `sessions.json` 逐条比对）：

  | workDir | 实现产出 | 磁盘真实目录 |
  | --- | --- | --- |
  | `C:\Users\TinaD\WorkBuddy\2026-08-24-13-40-25` | `c--Users-...-13-40-25` ❌ | `c-Users-...-13-40-25` ✅ |
  | `C:\Users\TinaD\WorkBuddy\2026-08-24-13-23-16` | `c--Users-...-13-23-16` ❌ | `c-Users-...-13-23-16` ✅ |

  中文路径同样错（A4-2）：实现 `d--OneDrive-4、董娣相关-4、专利知识库`，
  真实 `d-OneDrive-4、董娣相关-4、专利知识库`。**中文路径不是特例，是通病**。
  正斜杠路径经归一化后同样错（A4-3）。
- **下游影响（F3/F4 实测）**：
  - `resolveSession` 的索引分支**100% 落空**（2/2 会话 `via=project-scan`），
    每次读取都退化为遍历 `projects/` 全目录做 `existsSync` 扫描 —— 项目数增长后是 O(n) 性能悬崖。
  - `wb_list_sessions` 对**所有**会话报 `fileExists: false`、`messageCount: 0`、`sizeBytes: 0`，
    即**该工具在真实数据上基本不可用**（2/2 会话全错，F4）。
- **为什么冒烟测试没抓到**：冒烟测试只断言 `'fileExists' in first`（键存在），
  不断言值为 `true`；而 `realConversationId` 走的 `project-scan` 兜底路径恰好能读到内容，
  把 bug 掩盖了。这是典型的"断言写太松 + 兜底路径掩盖主路径"。
- **修复建议**：`normalized.replace(/[\\/:]+/g, '-')`（连续分隔符合并为单个），
  并补一条以真实目录名为基准的回归断言。注意需保留 `lib/paths.js:42` 的正斜杠归一化。

### 【P1】BUG-3：`conversationId` 越级路径，可读 `projects/` 之外的任意 `.jsonl`

- **位置**：`lib/sessions.js:65-70`（`resolveSessionFile`）+
  `lib/sessions.js:79-90`（`findSessionByScan`）
- **根因**：`path.join(projectDir, `${conversationId}.jsonl`)` 未对 `conversationId` 做
  路径越出校验。`path.join` 会**规范化** `..`，因此传入
  `..\..\..\AppData\Local\Temp\...\outside` 即可把目标带出 `projects/` 树。
  兜底的 `findSessionByScan` 同样拼接未校验的 id。
- **实证（A2-5）**：`conversationId` = 相对路径，工具返回
  `filePath = C:\Users\TinaD\AppData\Local\Temp\...\outside\outside.jsonl`，
  **内容完整返回**（标记值命中），`resolvedVia: "project-scan"`。
- **危害评估（诚实降级）**：
  - 受 `.jsonl` 后缀硬约束，**无法**读取任意扩展名文件（A2-6 已验证：`.txt` 读不到）；
  - 但 `.jsonl` 是 agent 会话/日志的通用格式，跨项目、跨应用读取其他工具的
    `.jsonl` 日志是现实可行的信息泄露面；
  - 外部 agent 若受外部内容影响，可借此探测本机任意 `.jsonl`。
  故定为 **P1 而非 P0**。
- **修复建议**：在 `resolveSession` 入口校验 id 不含路径分隔符与 `..`
  （如 `if (/[\\/\.]/.test(id)) throw INVALID_ARGUMENT`），
  或对 `filePath` 做 `path.relative(projectDir, filePath)` 必须不以 `..` 开头的前置断言。
  注意 `subagents` 路径（`lib/sessions.js:278`）也由 `conversationId` 拼成，需一并防护。

### 【P2】BUG-4：`wb_send_instruction` 接受空指令，`required` 约束形同虚设

- **位置**：`lib/tools.js:289-292`
- **根因（死代码）**：
  ```js
  const instruction = optionalString(args.instruction, 'instruction', '');  // 缺省返回 ''，不是 null
  if (instruction === null) {   // 永远不成立
    throw new AppError('INVALID_ARGUMENT', ...);
  }
  ```
  `optionalString`（`lib/tools.js:76-83`）的第 3 参 fallback 传的是 `''`，
  所以 `undefined`/`null`/空白三种输入都返回 `''`，`=== null` 恒为假 —— 校验形同虚设。
  对比 `wb_complete_instruction`（`lib/tools.js:328`）传 fallback `''` 后判断 `=== null`，
  是同一个错误模式的另一处。
- **实证（F1）**：`{instruction 缺失}`、`{instruction: ""}`、`{instruction: "   "}`
  三种输入**全部成功入队**并返回 `instructionId`。
- **影响**：违反自身 JSON Schema 声明的 `required: ['instruction']`；
  外部 agent 传错参数不会收到任何错误，会往 WorkBuddy 队列里灌入空指令，
  浪费 WorkBuddy 侧一次取件-执行-回填往返。
- **修复建议**：fallback 传 `null`（或直接用 `if (!instruction)` 判断空串）。

---

## 记录项（不计入失败，供参考）

| 编号 | 项 | 说明 | 级别 |
| --- | --- | --- | --- |
| OBS-1 | `initialize` 回显客户端的 `protocolVersion` | 客户端请求 `1999-01-01`，服务端原样回显，未按 MCP 规范回落到自身支持版本。C10-2 | P2 |
| OBS-2 | 会话文本无来源标注 | `wb_read_session` 返回的原文不含 untrusted/来源标注，附加内容风险完全依赖外部 agent 自身判断。默认剥离 `<system-reminder>` 是有效的一层防护（A3-3/A3-4 已验证含仿造块与未闭合块均被剥离） | P2 |
| OBS-3 | 高并发下 `LOCK_TIMEOUT` | 8 进程竞争时约 1/48 次入队返回 `LOCK_TIMEOUT`（重试预算 20×50ms=1s）。**不丢数据**（返回明确错误、落盘数 == 成功数，D11-2/D11-3 已验证），属可接受的可恢复失败 | P3 |
| OBS-4 | `~/.workbuddy/mcp.json` 未包含本连接器 | 文件存在但只有 `paddleocr`，README 只是"配置示例"未声称已配置。属交付待办 | P3 |

---

## 测试方法说明（可复核）

1. **不复用工程师的断言**：`qa-verify.js` 自行 spawn server 子进程、手写原始 JSON-RPC 帧，
   自行构造 fixture 与畸形数据，与 `smoke-test.js` 无任何共享代码。
2. **写入边界用 syscall 审计而非 mtime 快照**：
   初始版本用"调用前后 mtime 快照"判定只读，**该方法不成立**——
   对照实验证明 WorkBuddy 桌面端自身在空闲 3 秒内就会改动
   `logs/2026-10-07/edge-sync.log`、`logs/daemon.log`、`logs/main.log`、
   `logs/renderer.log`、`workbuddy.db-wal` 共 5 处。
   改用 `test/helpers/write-audit.js`（monkey-patch `fs` 写函数并落审计日志）后，
   获得的是"被测进程自己执行过的写 syscall"，是确定性证据。
3. **B/C/E 组用合成 fixture**：通过 `WB_PROJECTS_DIR` / `WB_SESSIONS_INDEX` 指向 `%TEMP%`，
   不读真实会话；只读的 1 个真实会话 jsonl 用于格式验证。
4. **B0-0/B0-1 自检**：B/C/E 组 fixture 的 `workDir ↔ slug` 往返按**真实规则**生成，
   并显式断言"当前实现与真实规则不一致"——确保这些用例失败时归因于源码而非测试夹具。
5. **缺陷用例可反向收敛**：A2-5 / D12-6 / B0-1 / F3 / F4 / F5 都是"断言缺陷存在"的复现用例，
   修复后会失败并提示更新；已在断言消息中写明修复后应改成什么。

### 我自己犯过的测试 bug（已修正，记录以示区分）

首轮 17 个失败中，**13 个是我自己的测试缺陷**，逐一修正后才得出上面的 4 个真实缺陷：

| 曾经的失败 | 真实原因 | 修正 |
| --- | --- | --- |
| A1-1/A1-3/G1 | mtime 快照无法区分 WorkBuddy 自身写入 | 改用 fs syscall 审计 |
| A2-5 | 我构造的越级路径多加了 `.jsonl` 后缀，双重后缀导致没命中 | 修正路径构造 |
| A3-1 | 我在**整个响应文本**里搜 `<system-reminder`，命中的是 `notes[]` 里的说明文案；且 `maxMessages:3` 取尾部窗口，恰好漏掉唯一含系统附加块的第 1 条消息 | 改为只查 `messages[]` 并读全量 |
| C9-1 | 我把无 id 的请求塞进 `pending` 表等待，协议上根本不会有响应 | 改为按行断言 + `id=null` |
| C10-3 | 我断言 `properties` 是数组，实际 JSON Schema 规定是对象 | 改为断言对象 |
| D11-1 | worker 脚本里 `${k}` 在外层模板作用域中不存在（`k is not defined`） | 改为函数拼装脚本 |
| D11-2 | 我把"每 worker 必完成 1 条"当作通过判据，实际高竞争下会 `LOCK_TIMEOUT` | 改为"落盘数 == 成功数" |
| D12-5 | 混入了 BUG-1 的影响，把原子性判据和丢数据判据混在一个用例 | 拆成 D12-5（原子性，通过）与 D12-6（丢数据，失败） |
| E13-2 | README 里反斜杠是 TOML/JSON 转义形式（`\\`），我按原样比对 | 改为按转义形式比对 + 解转义反验 |
| E14-1 | fixture 目录名按真实规则命名，却断言 `fileExists=true` | 改为条件断言（`fileExists` 本身是 BUG-2 的表现） |
| F2 | `registry.dispatch` 是 async，我忘了 await | 加 await |

---

## 复现全部结果

```bash
"C:\Users\TinaD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" test/qa-verify.js
```

预期输出末行：`TOTAL 77 | PASS 73 | FAIL 4`。

## 遗留与建议

1. **P0 优先**：BUG-1 会造成用户指令静默丢失，且在目标部署形态（两进程共享 store）下必然可能触发。
   建议修复前不要把本连接器用于真实指令投递。
2. **P1 并行修**：BUG-2 使 `wb_list_sessions` 在真实数据上不可用，属功能性缺陷；
   BUG-3 需补路径越出校验。
3. **建议工程师补测试**：冒烟测试对 `fileExists` / `messageCount` 只做了"键存在"断言，
   且真实会话读取被 `project-scan` 兜底掩盖，导致 BUG-2 完全漏过。
   建议在 `smoke-test.js` 中增加"以 `projects/` 真实目录名为基准"的 slug 回归断言。
4. **round 控制**：按 ≤2 轮规则，本轮为**第 2 轮**（第 1 轮完成分析并修正自身测试缺陷，
   第 2 轮确认为稳定复现的源码缺陷）。剩余 4 项已完整定位到文件/行号/复现步骤，不再自行修改源码。

---
---

# 第 2 轮回归验证（qa-round2 / 严过关）

| 项 | 值 |
| --- | --- |
| 被测对象 | `C:/Users/TinaD/WorkBuddy/2026-10-07-11-15-23/workbuddy-session-bridge/` |
| 验证者 | QA 独立验证（**未采信被测方修改过的任何断言**） |
| 新增独立脚本 | `test/helpers/qa2-adjudicate.js`(534) `qa2-path-checks.js`(497) `qa2-concurrency.js`(288) `qa2-readonly.js`(288) `qa2-rename-amplify.js`(156) `qa2-lockhold.js`(120) |
| 运行环境 | Node v22.22.2-6 / win32，真实数据 = `C:/Users/TinaD/.workbuddy/` |
| **主套件** | **修复前** 24 轮：21 轮 77/77、3 轮 76/77（偶发 100% 为 `D11-1` 的 `LOCK_TIMEOUT`）<br>**修复后 12 轮：12/12 全绿 77/77，零偶发** |
| **独立套件** | 裁决 13/13 · 越级 10/10 · 只读 4/4 · 并发 5 轮全绿 · smoke FAIL 0 |
| **最终路由判定** | **NoOne** —— 4 个原 Bug 真实修复；本轮新报 F-1/F-2 已被工程师修复并经我第 3 次复验确认（12/12 零偶发） |

## 本轮一句话结论

工程师的 4 处修复**经独立复验全部为真修复**（不是「让测试变绿」）：我用自建的
4 进程 × 240 条并发压测证明 P0 真的不再丢指令，用真实磁盘数据证明 slug 修复生效。

本轮我另外发现并报告了 2 个问题（**F-1 P2 锁预算失衡** / **F-2 P3 设备名缺口**），
工程师**已当场修复**，我做了第 3 次独立复验：
`qa-verify.js` **12/12 轮全绿零偶发**（修复前同口径 9/12），
锁预算从 0.40× 逆转为 **20.18×**，设备名全部拦截且**零误伤真实数据**。

**最终路由判定：NoOne**（详见第六节与第十节）。

---

## 一、9 处测试用例改动的裁决：**全部可接受，未弱化任何断言**

我逐项比对了源码文本（`test/qa-verify.js`）与我第 1 轮的原始判据，13 项独立断言全绿
（`qa2-adjudicate.js`）。**特别说明：主理人怀疑的 A2-3/A2-5「错误码放宽」经查证并不存在。**

| 用例 | 工程师改动 | 我的原始判据是否被弱化 | 裁决 |
| --- | --- | --- | --- |
| **D12-6**（P0 回归，最关键） | 加 `strictEqual(renameErrs.length,0)` 等 | **未弱化，且更严** | ✅ 接受 |
| **A2-3** | 错误码放宽为「INVALID_CONVERSATION_ID 或 SESSION_NOT_FOUND 均可」 | ⚠️ 放宽，但**不影响拦截结论** | ✅ 接受（附条件） |
| **A2-5** | 改为断言 `INVALID_CONVERSATION_ID` | **未弱化，外部文件内容未出现在响应中仍是硬断言** | ✅ 接受 |
| **A4-5** | 改为断言 `via==='sessions.json'` | **未弱化，且有区分力** | ✅ 接受 |
| **B0-1** | 改为与「独立实现的真实规则」比对 | **未弱化（规则断言 > 常量断言）** | ✅ 接受 |
| **F1** | 三种空指令断言 `isError` | 未弱化 | ✅ 接受 |
| **F2** | 断言 `INVALID_ARGUMENT` + 无 `instructionId` | 未弱化 | ✅ 接受 |
| **F3** | 索引全命中 + `scanHit===0` | 未弱化 | ✅ 接受 |
| **F4** | `fileExists=true` 必须 `messageCount>0` | 未弱化 | ✅ 接受 |
| **F5** | slug 合并为单 `-` + 无双破折号 | 未弱化 | ✅ 接受 |

### 1.1 D12-6：并发条件与原复现**完全等价**，未调小压力

这是主理人最担心的一处。我的核对结论（`qa2-adjudicate.js` 裁决6）：

| 参数 | 我第1轮原始复现 | 工程师版 D12-6 | 是否等价 |
| --- | --- | --- | --- |
| 写进程数 | 1 | 1 | ✅ |
| 投递条数 | 60 | 60 | ✅ |
| 裸 fs 读者 | 1 | 1 | ✅ |
| 读者持续时长 | 4000ms | 4000ms | ✅ |

**并发压力没有被调小。** 且三项核心断言全是 `strictEqual` 硬断言（非 `assert.ok` 松散判断）：
`persisted===wreport.ok`、`wreport.ok===60`、`renameErrs.length===0`，
并保留了「读侧至少读 50 次」的有效性门槛（防止测试空转）。

**我用自己的脚本做了 4 倍压力加强验证**（不只跑工程师那个）：4 写进程 × 60 条 = 240 投递
+ 2 个裸 fs 忙轮询读者 + 1 个用 bridge 工具轮询的读者，连续 5 轮：

```
round 1: 落盘 239 === 成功入队 239（零静默丢失）；裸fs读 23605 次 0 损坏；残留文件 0
round 2: 落盘 240 === 成功入队 240（零静默丢失）；裸fs读 27139 次 0 损坏；残留文件 0
round 3: 落盘 239 === 成功入队 239（零静默丢失）；裸fs读 24961 次 0 损坏；残留文件 0
round 4: 落盘 240 === 成功入队 240（零静默丢失）；裸fs读 27757 次 0 损坏；残留文件 0
round 5: 落盘 239 === 成功入队 239（零静默丢失）；裸fs读 26610 次 0 损坏；残留文件 0
总投递 1200 | 成功 1197 | 总裸fs并发读 130072 次 | JSON 损坏 0 次 | 指令id重复 0
```

判据比原用例更严：不仅数个数，还**逐条比对内容**（每条成功入队的 instruction 文本
都必须在落盘 JSON 中找到）、检查 id 无重复、检查无残留 `.tmp-`/`.lock` 文件。
**P0 修复判定为真修复。**

### 1.2 A2-3 / A2-5：主理人的怀疑**部分不成立**

主理人担心「错误码放宽为二选一，会出现『返回了错误码但其实没拦住越级』」。
我的实测结论：

- **A2-3 确实放宽了**（`text.includes('INVALID_CONVERSATION_ID') || text.includes('SESSION_NOT_FOUND')`）。
- **但 A2-5 没有放宽**，它硬断言 `INVALID_CONVERSATION_ID`（`qa-verify.js:467`），
  且标记值未出现在响应中是 `assert.ok(!text.includes(TEST_MARK))` 硬断言，**不是 ignore/告警**。
- A2-3 那 5 个 db 路径输入在当前实现下**全部返回 `INVALID_CONVERSATION_ID`**（我实测 5/5），
  二选一的放宽在实践中不会掩盖失败——因为这些输入必然含路径分隔符，必然命中字符集拒绝。

我进一步证明了二者**语义不可互换**（`A2-3-裁决` 用例）：构造「id 合法但文件缺失」
→ 返回 `SESSION_NOT_FOUND`；而含越级语义的 id → 返回 `INVALID_CONVERSATION_ID`。
所以「越级被拦截」和「文件恰好不存在」在错误码上是可区分的。

> **但我仍给出一条改进建议（不构成阻塞）**：A2-3 应收紧为硬断言
> `INVALID_CONVERSATION_ID`，理由是 `SESSION_NOT_FOUND` 语义上表示「id 已被接受并拼进路径，
> 只是没找到文件」，用它兜底会让未来的回归（比如字符集被放宽）逃过测试。
> 当前实现下收紧后仍会全绿，故这是**测试严格性问题，不是源码缺陷**。

### 1.3 A4-5：`via==='sessions.json'` 是真行为，未掩盖扫描兜底

这条我做了**双向反证**（`A4-5-反证`），证明该断言有区分力：
- 索引可用 + 文件存在 → `via='sessions.json'`
- 索引里 workDir 失效 → `via='project-scan'`

即两个分支可区分，若实现退化为扫描兜底，用例立刻失败。真实数据 2/2 会话
`via=sessions.json`（第 1 轮时是 2/2 `project-scan`）。**确认为真实修复，非掩盖。**

### 1.4 F1~F5：断言的是「真实规则」而非「恰好等于某常量」

- **B0-1/F5**：断言 `slugifyPath` 输出等于**QA 独立实现的真实规则**
  （我在测试里重新实现一遍 `/[\\/:]+/g` 合并逻辑），并**反向校验磁盘真实目录名存在**。
  这是规则断言，比「值恰好等于 `c-Users-TinaD`」更强。
- **F1**：我加强了反向验证——5 种合法指令（含 5000 字符、含换行、emoji、首尾空白）
  必须能入队，防止「一刀切拒绝」式修复。
- **F4**：我加强了独立比对——不信 `fileExists` 自报值，而是**用真实磁盘路径独立判定**
  应为何值，再逐一比对 `fileExists`/`messageCount`/`sizeBytes`，2/2 吻合。

---

## 二、安全字符集决策裁决：**工程师的取舍正确，主理人的假设被数据否证**

主理人的判断依据是：「若纯 UUID 更安全但会误伤 fixture，那是**测试数据的问题不是你实现的问题**，
应改 fixture 为 UUID，而非放宽实现。」

**我必须诚实地说：这个前提在真实数据上不成立。** 我实测了全部真实会话文件：

```
真实 sessions.json 索引会话数：2 个，conversationId 全部为标准 UUID（长度均 36）
真实 projects/ 下 .jsonl 会话文件：50 个，其中 5 个 conversationId **不是 UUID**
  例：0210327a89244abea944d98682323895   (32 位无连字符的 hex)
      c0dfc1f41e2a422981be9fd822621d59
      bcf4bd72aa874ec09604e8e772a09965
  这 5 个文件大小 3.6KB ~ 981KB，是**真实的、用户的历史会话**
```

进一步实测这 3 个非 UUID 会话经工具读取的结果：

| conversationId | 纯 UUID 白名单 | 当前实现 | 工具实际可读? |
| --- | --- | --- | --- |
| `0210327a89244abea944d98682323895` | ❌ BLOCK | ✅ PASS | **YES**（256KB 内容） |
| `c0dfc1f41e2a422981be9fd822621d59` | ❌ BLOCK | ✅ PASS | **YES**（981KB 内容） |
| `bcf4bd72aa874ec09604e8e772a09965` | ❌ BLOCK | ✅ PASS | **YES**（153KB 内容） |

**结论：纯 UUID 白名单会「误伤 10% 的真实用户会话」，而不只是误伤测试夹具。**
WorkBuddy 自身存在两种会话 ID 形态（带连字符 UUID 与 32 位 hex）。
工程师选择「`[A-Za-z0-9._-]` 允许集 + 禁 `..` + 根目录前缀判定」是**正确的**，
若按主理人建议改成纯 UUID，会造成真实功能回归。**决策正确，不应回退。**

### 2.1 越级变体穷举：25 种全部被精确拒绝，外部文件内容未出现在响应中

`qa2-path-checks.js` T1 组，全部为**硬断言**（外部文件内容未出现在响应中 + `isError===true` + `INVALID_CONVERSATION_ID`）：

| 类别 | 变体 | 结果 |
| --- | --- | --- |
| 典型越级 | `..\..\..\outside`、正斜杠绝对路径 | BLOCK |
| 多点/混合 | `....//`、`..;/`、`..\/`、`..\t..\x` | BLOCK（`FORBIDDEN_CHARS`） |
| URL 编码 | `%2e%2e%2f`、`%09../x` | BLOCK（`UNSAFE_CHARS`） |
| 双重编码 | `%252e%252e%252f` | BLOCK |
| Overlong | `..%c0%af` | BLOCK |
| NUL 字节 | `a\0b`、前导 `\0../../x` | BLOCK（控制字符域） |
| 超长 | 129 / 5000 字符 | BLOCK（`TOO_LONG`）；**128 边界正确放行** |
| UNC | `\\?\C:/Windows/System32`、`\\.\pipe\x` | BLOCK |
| ADS | `foo.jsonl:stream` | BLOCK |
| 盘符 | `C:foo` | BLOCK |
| 点变体 | `.`、`..`、`...`、`a..b`、`outside..`、`.. ` | BLOCK（`PARENT_REF`） |

同时验证**合法 id 未被误伤**（防止「一刀切拒绝」式修复）：合法 UUID 会话正常读取。

### 2.2 Windows 保留名情形：**主理人担心的三类风险，实测均不成立**（诚实降级）

我按主理人清单逐项实测了 Windows 保留名情形，**结论与预期相反**，如实汇报：

**(a) 保留设备名 `CON`/`NUL`/`COM1`~`COM9`/`LPT1`~`LPT9` 及带扩展名形式**

- `validateConversationId` 单元级**确实放行**（`CON`、`NUL`、`COM1`、`LPT1`、`CON.jsonl`…）→ 这是**客观存在的待强化项**。
- **但工具层未返回内容**：`wb_read_session` 对 34 个设备名输入全部返回 `SESSION_NOT_FOUND`，外部文件内容未出现在响应中。
- 根因（实测）：**Node v22 的 `fs` 走 `\\?\` 长路径语义，不解析 Win32 设备名**。
  `fs.readFileSync('...\CON.jsonl')` 抛 `ENOENT` 而非打开控制台设备。
  即使 `statSync` 抛 ENOENT，`fs.writeFileSync('CON.jsonl')` 反而能创建出一个**普通文件**。
- **判定：P3 待强化项，非可触发缺陷。** 建议加设备名黑名单以 defense-in-depth，
  但**不构成安全风险**，因为没有任何路径能借此读到内容或越出 `projects/`。
  → 记录为 `F-2`（P3）。

**(b) trailing dot / trailing space（Windows 会静默剥离）**

- 主理人的前提「`outside.` 等价于 `outside`」在**本平台不成立**：实测 `outside.` → `outside..jsonl` → `ENOENT`，
  **与 `outside.jsonl` 是不同文件**（Node 长路径同样不做尾点剥离）。无别名读取。
- 尾空格 `'outside '` 被 `validateConversationId` 的 `trim()` 归一为 `outside`，
  **语义与直接传 `outside` 完全相同**——这是输入归一化，不是越级访问（没有扩大可触达范围）。
- **判定：无风险。** 我第一版测试在这里写错了断言（误以为会发生剥离），
  已修正为「尾点不得指向别的文件」的正确判据。

**(c) UNC 前缀 / 混合分隔符 / ADS**：全部 BLOCK（见上表），无风险。

### 2.3 额外发现：`workDir` 未校验，但被 `assertWithinRoot` 有效兜住

`slugifyPath` 对异常 `workDir`（如 `'..'`）会产出 slug `'..'`（`lib/paths.js:69-75` 不做校验）。
若 `sessions.json` 被污染（`workDir: '..'`），理论上可把读取指向 `projects/` 之外。
**实测：`assertWithinRoot`（`lib/paths.js:118`）成功拦截**，
`resolveSessionFile` 抛 `PATH_OUT_OF_ROOT`；`listSessions` 侧计入 `skippedInvalidIds` 并置 `fileExists=false`。
外部文件内容未出现在响应中。这是**有效的第二重保险**，不构成缺陷，但建议补 `workDir` 校验以减少纵深依赖。

---

## 三、只读边界：**通过**（fs syscall 审计，非 mtime 快照）

按主理人要求，用 `test/helpers/write-audit.js`（monkey-patch `fs` 写函数）审计
**被测进程自己执行过的写 syscall**，未使用 mtime 快照（WorkBuddy 桌面端空闲 3 秒即自改
`logs/*.log` / `workbuddy.db-wal`，mtime 法不成立）。`qa2-readonly.js` 4/4 通过：

| 用例 | 结果 |
| --- | --- |
| R1-1 写操作（send/pending/complete） | 18 次写 syscall **全部在 %TEMP% 隔离目录内**，真实 `.workbuddy` **零触碰** |
| R2-1 只读工具（list/search/read/stats/info） | **0 次写 syscall**（审计日志为空） |
| R3-1 读真实数据场景 | 审计 0 次写 syscall，真实 `.workbuddy` **零写入** |
| R4-1 真实 `task-bridge` 目录 | **不存在**（`C:/Users/TinaD/.workbuddy/task-bridge/`），未污染真实目录 |

---

## 四、4 处源码修复的独立复验：**全部为真修复**

| 原 Bug | 声称改法 | 独立复验方式 | 结论 |
| --- | --- | --- | --- |
| **P0** 并发丢指令 | `store.js:38` `RENAME_RETRY`(16次/4ms起/250ms上限) + `:146` `renameWithRetry()` 指数退避 | 自建 4 进程 × 240 投递 + 3 读者 × 5 轮；判据=落盘===成功入队、逐条内容比对、id 无重复、无残留 tmp/lock、JSON 零损坏 | ✅ **真修复**，1200 次投递零静默丢失，13 万次并发读零损坏 |
| **P1** slug 双破折号 | `paths.js:33` `SLUG_REPLACED_CHARS = /[\\/:]+/g` | 用 QA **独立实现**的真实规则比对 4 个 workDir；并反向校验 slug 产出命中磁盘真实目录；真实数据 `messageCount=27/19` 非零、`via=sessions.json` | ✅ **真修复** |
| **P1** 越级路径 | `paths.js:49,52,91,118` 新增字符集校验 + `assertWithinRoot` | 25 种越级变体穷举 + 异常 `workDir` 情形；外部文件内容未出现在响应中硬断言 | ✅ **真修复**（多重校验三层） |
| **P2** 空指令死代码 | `tools.js:97` `requiredString()`，`:311`/`:347` 接入 | 5 种空/空白输入全部被拒且队列保持为空；5 种合法输入（含 5000 字符/换行/emoji）仍能入队 | ✅ **真修复**（且未误伤合法输入） |

**没有任何一处是「让测试变绿」的假修复。** 特别说明 P2：我额外验证了
「合法 instruction 必须能入队」，排除了「用一刀切拒绝来让测试变绿」这种投机做法。

---

## 五、本轮新发现并已修复的问题（F-1 / F-2，详见第十节复验）

### 【P2】F-1：`rename` 退避在**持锁状态**下进行，可靠性预算失衡

- **位置**：`lib/store.js:38-44`（`RENAME_RETRY`）+ `lib/store.js:146`（`writeRaw` 内持锁调用）
  与 `lib/store.js:25`（`LOCK_RETRY`）的预算对比
- **根因（实测数据）**：

  | 参数 | 值 | 来源 |
  | --- | --- | --- |
  | 锁获取总预算（EEXIST 路径） | **1000ms**（20 次 × 固定 50ms，`store.js:197` 用的是**固定** delayMs，非指数） | `LOCK_RETRY` |
  | 单次 rename 最坏退避总时长 | **2502ms**（4·2ⁿ，封顶 250ms × 15 次） | `RENAME_RETRY` |
  | 比值 | **2.50×** | — |

  `transact()`（`store.js:261-273`）在 `acquireLock()` 后执行 `writeRaw()`，
  而 `writeRaw` 内的 `renameWithRetry` **退避期间一直持有锁文件**。
  因此一次长退避会独占锁 2502ms，而其它进程的总等待预算只有 1000ms →
  **必然耗尽预算返回 `LOCK_TIMEOUT`**。
  且 `LOCK_STALE_MS=10000` 远大于 1000ms，慢持锁**不会**被当作陈旧锁抢占，只会等到预算耗尽。
- **复现步骤**（我的 `qa2-concurrency.js`，4 写进程 × 60 条 + 2 裸 fs 读者）：
  ```
  5 轮中 4 轮出现 1~5 次 LOCK_TIMEOUT（约 0.4% ~ 2% 的投递）
  例：round 5: 5 次 LOCK_TIMEOUT，错误码分布 {"LOCK_TIMEOUT":5}
  ```
  - 主套件 `qa-verify.js` 的偶发失败**已 100% 定位**（见下）。
- **主套件偶发失败的定位结果（本轮共 24 轮复跑）**：

  | 项 | 结果 |
  | --- | --- |
  | 复跑轮数 | **24 轮**（qa-verify.js，分 4 批连续执行） |
  | 出现失败的轮次 | 3 轮，均为 `TOTAL 77 \| PASS 76 \| FAIL 1`（偶发率约 1/8） |
  | **失败用例** | **`D11-1 6 进程 x 8 条并发入队` —— 24 轮中 100% 唯一** |
  | **失败原因** | **100% 是 `LOCK_TIMEOUT`**：`入队成功 47/48；错误码分布={"LOCK_TIMEOUT":1}` |
  | 是否数据丢失 | **否**。`D11-1` 里「落盘===成功入队」那条核心断言**每轮都通过**，失败的只是「48 条必须全部成功」 |
  | `D12-2`（另一个计时敏感用例） | 单独隔离复跑 **12/12 全绿**（耗时 1451~1656ms，稳定） |
  | `smoke-test.js` | 3/3 轮 `FAIL 0 / RESULT: PASS`，稳定 |

  即：`D11-1` 的失败判据把「显式可恢复的 `LOCK_TIMEOUT`」当成了失败。
  这在第 1 轮是**正确的严格判据**（当时 `LOCK_TIMEOUT` 极少出现）；
  但修复 P0 引入 rename 退避后，`LOCK_TIMEOUT` 概率上升，导致该断言变得不稳定。
  **修 F-1 即可同时消除此偶发**；或按第 1 轮 D11-2 的既有先例，把 D11-1 的判据
  与 D11-2 对齐（只保留「落盘===成功入队」，把 `LOCK_TIMEOUT` 记为记录性指标）。
- **影响评估（诚实降级为 P2）**：
  - **不丢数据**：实测每一轮都满足「落盘数 === 成功入队数」，`STORE_WRITE_FAILED` 与
    `STORE_RENAME_FAILED` 均为 **0 次**。失败以 `LOCK_TIMEOUT` 显式返回，调用方可见可重试。
  - 与第 1 轮的 P0（静默丢失）**性质完全不同**：P0 是「指令消失且调用方不知道」，
    本项是「调用方明确收到 LOCK_TIMEOUT」。
  - 真实影响：Codex 侧高频投递时偶发失败，重试即可成功；不会造成数据损坏或队列不一致。
- **建议修复**（任选其一，均为小改动）：
  1. 把 `LOCK_RETRY` 的 EEXIST 分支（`store.js:197`）从**固定 50ms** 改为**指数退避**
     并把总预算提到 ≥3000ms，使其 ≥ rename 最坏退避时长；
  2. 或**缩小 `RENAME_RETRY` 上限**（如 8 次 / 封顶 64ms，最坏 ≈ 300ms < 1000ms 预算），
     在「快速失败并让调用方重试」与「长时间阻塞持锁」之间取平衡；
  3. 或**缩小临界区**：先在锁外完成 tmp 写入，只把 `rename` 放进锁内（缩短持锁时间）。
- **严重级别**：**P2**（可恢复失败、无数据丢失、概率低）。

### 【P3】F-2：`validateConversationId` 放行 Windows 保留设备名（待强化项）

- **位置**：`lib/paths.js:91-109`（`validateConversationId`）
- **现状**：`CON`/`NUL`/`PRN`/`AUX`/`COM1`-`COM9`/`LPT1`-`LPT9` 及带扩展名形式
  （`CON.jsonl` 等）**全部被放行**。
- **实际风险：低（P3）**。工具层未返回内容——`wb_read_session` 对 34 个设备名输入
  一律返回 `SESSION_NOT_FOUND`，外部文件内容未出现在响应中、不挂起、不崩溃。
  根因是 Node v22 的 `fs` 采用 `\\?\` 长路径语义，不解析 Win32 设备名
  （`readFileSync('...\CON.jsonl')` → `ENOENT`，而 `writeFileSync` 反而能创建同名普通文件）。
- **建议**：在 `validateConversationId` 中加一条保留设备名黑名单
  （`/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i`）作为 defense-in-depth。
  属强化建议，非缺陷。

### 记录项（本轮新增，不计入失败）

| 编号 | 项 | 说明 | 级别 |
| --- | --- | --- | --- |
| OBS-4 | `slugifyPath` 不校验 `workDir` | 异常 `workDir='..'` 会产出 slug `'..'`，但 `assertWithinRoot` 成功拦截（抛 `PATH_OUT_OF_ROOT`）。建议补校验以减少纵深依赖 | P3 |
| OBS-5 | 主套件偶发失败（已定位） | **失败用例 100% 是 `D11-1`**，失败原因 100% 是 `LOCK_TIMEOUT`（`入队成功 47/48，错误码={"LOCK_TIMEOUT":1}`），**从不是数据丢失**（`落盘===成功入队` 那条断言始终通过）。即 OBS-5 是 F-1 的测试侧表现 | P3（随 F-1 一并解决） |

---

## 六、最终路由判定：**NoOne**

| 问题 | 级别 | 文件 / 行号 | 状态 |
| --- | --- | --- | --- |
| **F-1** `rename` 退避持锁导致 `LOCK_TIMEOUT` 预算失衡 | **P2** | `lib/store.js` | ✅ **已修复并复验**（锁预算 0.40× → 20.18×，12/12 轮零偶发） |
| **F-2** 设备名未拦截（待强化项，非缺陷） | **P3** | `lib/paths.js:67-70` | ✅ **已修复并复验**（14 个设备名全拦，零误伤真实数据） |
| OBS-4 `workDir` 未校验 | ✅ **已闭环**（见下） | `lib/paths.js:119` | 已修复并复验 |
| OBS-5 主套件偶发 | — | — | ✅ **已消除**（随 F-1 修复，12/12 全绿） |

**判定 NoOne 的理由**：
1. 第 1 轮的 4 个 Bug（P0 并发丢指令 / P1 slug / P1 越级路径 / P2 空指令）
   经我独立复验**全部为真修复**，不是「让测试变绿」。
2. 我在本轮新报的 F-1（P2）与 F-2（P3），工程师**已当场修复**，
   我做了第 3 次独立复验：主套件 **12/12 轮全绿零偶发**，
   锁预算从不足（0.40×）逆转为充足（20.18×），设备名全部拦截且**零误伤真实数据**。
3. 剩余唯一遗留项 OBS-4 有 `assertWithinRoot` 作为有效第二重保险兜住，
   实测外部文件内容未出现在响应中，属 P3 纵深依赖建议，**不构成缺陷**。

**同时必须明确（供后续维护参考）**：
- 工程师的 9 处测试用例改动**全部可接受，无一构成弱化断言**。
- 安全字符集放宽的决策**正确，不应回退为纯 UUID 白名单**（会误伤 10% 真实会话）。
- 唯一建议收紧的测试是 A2-3 的错误码二选一（属测试严格性，不阻塞）。

---

## 七、我在本轮犯过的测试 bug（记录以示区分，避免与源码缺陷混淆）

诚实第一：以下 5 处是我自己的测试缺陷，修正后才得出上面的结论。

| 我第一版写错的地方 | 真实原因 | 修正 |
| --- | --- | --- |
| 并发判据「投递 240 条必须全部落盘」 | `LOCK_TIMEOUT` 的投递本就**应该**不落盘，把它算成「内容缺失」是判据错误 | 改为「**仅对成功入队的指令**要求内容可查」，并把 `LOCK_TIMEOUT` 单独记为显式可恢复失败 |
| `new Set(allIds).filter(...)` | `Set` 没有 `.filter` 方法 | 改为 `new Set(ids)` 与数组长度比较 |
| T3 断言「尾点必须被拒绝」 | 前提错误：**本平台 Node 不剥离尾点**（实测 `outside.`→`outside..jsonl` ENOENT）。且尾空格被 `trim()` 归一，语义等同直接传入，非越级访问 | 改为正确判据：「尾点不得指向别的文件」 |
| T2 断言「设备名必须被工具层拒绝且 `code=INVALID_*`」 | 混淆了「单元级校验」与「工具层结果」两层 | 改为分别记录：单元级**放行**（待强化项）+ 工具层**未出现在响应中**（无实际风险） |
| `qa2-rename-amplify.js` 场景 2 报「静默丢失：有！」 | 脚本 bug：场景 2 复用同一 store，累计值当成了本场景值（120+239=359 被误判） | 扣除场景 1 已有量后为 0 丢失 |
| 复验 F-2 时把 `COM0`/`LPT0` 列入设备名黑名单 | **我的事实错误**：Windows 保留设备名只有 `COM1-9`/`LPT1-9`，**没有 `COM0`/`LPT0`**（实测 `COM0.jsonl` 可正常创建为普通文件）。工程师的实现是对的 | 从黑名单移除，并把它们加入「必须放行」的反向清单 |
| T2-2 断言写成「设备名必须仍被放行」 | 该断言是按「缺陷仍存在」写的，工程师修好后自然失败 | 改为正向断言「设备名被拒 + 合法 id 零误伤」，并新增 11 个反向用例防误伤 |

**另有一处自我纠正**：主理人建议的「改 fixture 为 UUID 而非放宽实现」，
我实测发现**真实数据里就有 5 个非 UUID 会话**（32 位 hex），
若照此修改会造成真实功能回归。故我**否决了这条建议**并附上数据证据。

---

## 八、复现全部结果

```bash
NODE="C:/Users/TinaD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

# 主套件（工程师改过 9 处断言，我不采信，独立裁决见下一条）
$NODE test/qa-verify.js                    # 预期 TOTAL 77 | PASS 77 | FAIL 0（F-1 修复后 12/12 轮全绿）

# 本轮新增的 6 个独立脚本（均可单独复现）
$NODE test/helpers/qa2-adjudicate.js        # 9 处被改用例裁决  -> TOTAL 13 | PASS 13 | FAIL 0
$NODE test/helpers/qa2-path-checks.js         # 越级+Windows 保留名情形  -> TOTAL 10 | PASS 10 | FAIL 0
$NODE test/helpers/qa2-readonly.js          # 只读边界审计       -> TOTAL 4  | PASS 4  | FAIL 0
$NODE test/helpers/qa2-concurrency.js 5     # 4进程并发 5 轮     -> rounds=5 | failed=0
$NODE test/helpers/qa2-rename-amplify.js    # 跨进程放大效应     -> 静默丢失 0
$NODE test/helpers/qa2-lockhold.js          # 锁预算诊断         -> 预算充足(20.18x)

# 工程师冒烟测试
$NODE test/smoke-test.js                    # 预期 FAIL 0 / RESULT: PASS
```

## 遗留与建议（按优先级）

1. **✅ 已闭环**：F-1（锁预算失衡）与 F-2（设备名缺口）已由工程师修复并经我第 3 次复验确认。
2. **✅ 已闭环**：OBS-4（`workDir` 未校验）—— 工程师已补 `validateWorkDir`（`paths.js:119`
   + `sessions.js:82`），我第 4 次复验确认两层校验生效、外部文件内容未出现在响应中。**单点依赖风险已消除，
   原「补文档」建议随之作废，无遗留待办。**
3. **测试建议**：A2-3 的错误码断言可从「二选一」收紧为硬断言 `INVALID_CONVERSATION_ID`
   （当前实现下收紧后仍全绿，属测试严格性提升，不阻塞交付）。
4. **不要回退字符集**：请勿改为纯 UUID 白名单，会导致 10% 真实会话不可读（见第二节数据）。
5. **交付放行**：4 个原 Bug + 本轮 2 个新报问题全部闭环，
   `qa-verify.js` 12/12 轮全绿、smoke `FAIL 0`、只读边界零污染，**可放行**。
6. **round 控制**：本轮为第 2 轮回归，已达上限。F-1/F-2 报出后由工程师当场修复，
   我已完成第 3 次独立复验并确认闭环；剩余 OBS-4 均已记录，不再自行修改源码。

---

## 十、【追加】工程师已修复 F-1 / F-2，我的第 3 次独立复验

在我发出 bug 报告后，工程师**当场修复了 F-1 与 F-2**（`lib/store.js` 与 `lib/paths.js`
mtime 更新至 19:19 / 19:20）。我对修复后的代码做了第 3 次独立复验，结果如下。

### 10.1 F-1 修复确认（`lib/store.js`）

工程师采用了**方案 2 + 方案 1 的组合**：

| 参数 | 修复前 | 修复后 | 变化 |
| --- | --- | --- | --- |
| `RENAME_RETRY` | 16 次 / 4ms 起 / 250ms 封顶 | **8 次 / 2ms 起 / 64ms 封顶 / 带 25% 抖动** | 最坏退避 **2502ms → 190ms** |
| `LOCK_RETRY` | 20 次 / **固定 50ms** / 无抖动 | **16 次 / 5ms 起 / 400ms 封顶 / 带 25% 抖动** | EEXIST 分支改为**指数退避**（`store.js:303` `sleepSync(backoffDelay(LOCK_RETRY, attempt))`） |
| 锁等待最坏预算 | 1000ms | **3835ms** | — |
| **预算比（锁等待 ÷ 临界区）** | **0.40×（不足）** | **20.18×（充足）** | ✅ 根本性解决 |

**复验结果**（我的 `qa2-concurrency.js`，4 写进程 × 240 投递 + 3 读者 × 5 轮）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| LOCK_TIMEOUT 次数（5 轮合计） | **9 次**（0/1/1/2/5） | **2 次**（0/1/0/0/1） |
| 静默丢失（`STORE_WRITE_FAILED`/`STORE_RENAME_FAILED`） | 0 | **0（保持）** |
| 落盘 === 成功入队 | 每轮成立 | **每轮成立** |
| JSON 损坏 / id 重复 / 残留文件 | 0 | **0** |

且 `qa2-rename-amplify.js` 场景1（贴近真实部署的 2 写进程）**LOCK_TIMEOUT 归零**。
**F-1 判定为已修复，且未牺牲 P0 修复效果**（缩短退避 ≠ 放弃重试：
仍有 8 次带抖动的指数退避，且失败仍抛结构化 `STORE_RENAME_FAILED`）。

### 10.2 F-2 修复确认（`lib/paths.js`）

新增 `WINDOWS_DEVICE_NAMES` 集合（`paths.js:67-70`，含 `CON/PRN/AUX/NUL/COM1-9/LPT1-9`），
按 **stem**（去最后一个扩展名）比对，故 `CON`、`con.jsonl`、`NUL.jsonl` 都会被拦下。
实测：

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| `CON` / `NUL` / `COM1` / `LPT9` | ALLOW | **BLOCK `RESERVED_DEVICE_NAME`** |
| `CON.jsonl` / `con` / `nul` | ALLOW | **BLOCK `RESERVED_DEVICE_NAME`** |
| `conv-partial`（测试 fixture） | ALLOW | **ALLOW（未误伤）** |
| `0210327a89244abea944d98682323895`（真实非 UUID 会话） | ALLOW | **ALLOW（未误伤）** |
| 合法 UUID | ALLOW | **ALLOW** |

**关键：强化没有误伤真实数据**（那 5 个非 UUID 真实会话仍可读），也未误伤测试夹具。
我用 11 个反向用例验证了这一点，含 `console` / `communicate` / `auxiliary` 这类
**含设备名子串的正常词**——工程师的 stem 精确匹配正确地放行了它们，
若用朴素的 `includes()` 就会误伤。

> **修正我自己的一处事实错误**：我先前建议的黑名单正则里写了 `COM[1-9]|LPT[1-9]`，
> 但我在复验时一度把 `COM0`/`LPT0` 也当成保留设备名写进测试。
> 实测证明 **`COM0`/`LPT0` 不是 Windows 保留设备名**（`COM0.jsonl` 可正常创建为普通文件），
> **工程师的实现是对的**，是我的测试写错了。已修正。

### 10.3 修复后回归

| 套件 | 结果 |
| --- | --- |
| **`qa-verify.js` × 12 轮连续复跑** | **12/12 全绿 `TOTAL 77 \| PASS 77 \| FAIL 0`，零偶发**（修复前同口径为 9/12 绿、3 次 `D11-1` 偶发） |
| `qa2-adjudicate.js`（9 处裁决） | **13/13 PASS** |
| `qa2-path-checks.js`（越级 + Windows 保留名情形） | **10/10 PASS**（修复前 9/10，失败项即 F-2 本身） |
| `qa2-readonly.js`（只读边界） | **4/4 PASS** |
| `qa2-concurrency.js` 5 轮 | **5/5 PASS**，1200 投递零静默丢失，18 万次并发读零损坏 |
| `qa2-rename-amplify.js` | 静默丢失 **0**；场景1 LOCK_TIMEOUT 归零 |
| `qa2-lockhold.js` | **预算充足**（锁预算已是临界区的 20.18 倍） |
| `smoke-test.js` | **FAIL 0** |

**结论：F-1 与 F-2 均已修复且未引入回归。第 2 轮最终路由判定由 Engineer 改为 NoOne。**

### 10.4 OBS-4 闭环：`validateWorkDir` 已加入（此前我判定为「不推动改动」）

我在第六节曾建议「不推动 OBS-4 改动，仅补文档说明单点依赖」。
**读代码时发现工程师已先行补上了 `validateWorkDir`（`paths.js:119`）并接入
`resolveSessionFile`（`sessions.js:82`，失败抛 `INVALID_WORKDIR`）**，
故那条「补文档」的建议已无必要——单点依赖风险实际已被消除。复验如下：

| 输入 | `validateWorkDir` 结果 |
| --- | --- |
| `C:\Users\TinaD` | ALLOW（合法） |
| `C:\Users\TinaD\4、董娣相关`（真实中文路径） | **ALLOW（未被误伤）** |
| `a\0b` / `a\1b`（NUL / 控制字符） | **BLOCK `FORBIDDEN_CHARS`** |
| 超长（>2048） | **BLOCK `TOO_LONG`** |
| 空串 | **BLOCK `EMPTY`** |

端到端复验异常 `workDir`（测试文件放在 `projects/` 之外）：

| workDir | 结果 |
| --- | --- |
| `..` | 抛 `PATH_OUT_OF_ROOT`（`assertWithinRoot` 兜住） |
| `a\0b` | 抛 `INVALID_WORKDIR`（**新增的入口校验拦下**） |
| `..\..` | slug 化为字面量 `..-..`，路径仍在 `projects/` 内，**外部文件内容未出现在响应中** |
| `C:\Users\..\..` | slug 化为字面量 `c-Users-..-..`，仍在 `projects/` 内，**外部文件内容未出现在响应中** |

即：`workDir` 现在有**两层**防护（`validateWorkDir` 入口校验 + `assertWithinRoot` 兜底），
不再是「全部可靠性押在单点」。**OBS-4 关闭。**

**OBS-4 关闭后的完整回归**：`qa-verify` 77/77 · `qa2-path-checks` 10/10 ·
`qa2-adjudicate` 13/13 · `qa2-readonly` 4/4 · `smoke-test` `FAIL 0`。
**最终路由判定维持 NoOne，可放行；无遗留待办。**
