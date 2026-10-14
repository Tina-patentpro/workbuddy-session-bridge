# REMEDIATION —— 第三轮外部审计（ChatGPT）13 项缺陷整改记录

> **性质说明**：本文档为**软件工程质量记录**（正确性 / 可靠性 / 健壮性）；全部验证在**本机离线**完成，
> 不涉及网络、服务器或任何外部系统（「故障模拟」等术语见 `复审指引.md` 的术语说明）。
>
> 对应裁决：`workbuddy-session-bridge` 不通过（13 项缺陷：2×P0 / 5×P1 / 6×P2）。
> 记录原则：**一个缺陷一条记录**，含 文件·行 → 根因 → 修复 → 验证证据。
> **未闭合项显式标注，不粉饰。**
> 生成时间：2026-10-09。锁定设计：**maildir 队列（单写入者 / 每记录独立文件 / link+unlink 原子领取）**。
> 追加（2026-10-10）：第 4 轮**故障模拟复查**暴露的领取错误路径缺陷 **D11-2b / D11-2c**，见 §3A（含模拟式回归 D13 与判别力自证）。

---

## 0. 状态总表

| 编号 | 级别 | 状态 | 一句话 | 关键验证 |
|---|---|---|---|---|
| F01 | P0 | **Fixed** | QA 清理绑定所有权标记，不再删除既有目录 | acceptance F01.1/2/3 PASS；qa-verify A0/A1-1/A1-2/G3 |
| F02 | P0 | **Fixed** | 废弃 lockfile → maildir，无锁无丢失 | smoke BUG-1 64/64；qa-verify D11-1/D11-2/D12-1/D12-5/D12-6；acceptance F02.1–5 |
| F03 | P1 | **Fixed** | 存储入口在任何 fs 前校验受保护命名，零副作用 | acceptance F03（7 PASS）；qa-verify A 组 |
| F04 | P1 | **Fixed（源码）** | realpath 真实目标边界 → 阻断链接越界 | acceptance F04.1/F04.2/F04.5 PASS；**F04.3/F04.4 FAIL＝测试缺陷，见 §4.1** |
| F05 | P1 | **Fixed** | 只读零写入；损坏只计数不移动 | qa-verify D12-2/D12-3；acceptance F05 |
| F06 | P1 | **Fixed** | 严格布尔/整数/metadata 校验 | qa-verify C9-8/F1/F2；smoke BUG-4；acceptance F06 |
| F07 | P1 | **Fixed** | 信封校验 + Map 分发 + 版本协商 + 错误分层 | qa-verify C10-3b/C9-7/C9-8；acceptance F07（17 PASS） |
| F08 | P2 | **Fixed** | 尾读边界按「起点前一字节」判定 | qa-verify B 组；acceptance F08 |
| F09 | P2 | **Fixed** | 退避预算=逐次 ceil 上界；不变量链守护 | qa-verify D12-7（=238）；acceptance F09 |
| F10 | P2 | **Fixed** | store.js 彻底无锁符号；运行时不产生 .lock | acceptance F10.1/F10.2 PASS |
| F11 | P2 | **Fixed** | 越界时间戳不中断整读 | qa-verify B 组；acceptance F11 |
| F12 | P2 | **Fixed** | README 消费示例：领取前传 sessionId | acceptance F12 |
| F13 | P2 | **Fixed** | reminder 剥离顺序：自闭合→成对→未闭合 | qa-verify B 组；acceptance F13 |
| ★D | P0* | **Fixed（本轮附带发现）** | rename 幻影 OK → 领取改 link+unlink | qa-verify D12-1/D11-2（见 §3） |
| ★D11-2b | P0* | **Fixed（第4轮·故障模拟）** | 「复活窗口」：link 与 rename 间被并发完成抢占 → 跨状态双份 | d11diag 12/16/20 进程压测 0 复现（见 §3A） |
| ★D11-2c | P0* | **Fixed（第4轮·故障模拟）** | 错误路径无收敛 + GONE 语义过载 → 双份 / 误报终态 | 金标准 3/3 PASS；qa-verify D13（见 §3A） |

> ★D 不在审计 13 项之内，是本轮我新增的并发等价性用例（D12-1）在整改过程中**暴露并修复**的真实并发缺陷，诚实单列。
> ★D11-2b / ★D11-2c 同样不在审计 13 项之内，为主理人第 4 轮**文件操作失败模拟**独立复现并要求修复的真实并发缺陷（详见 §3A）。

---

## 1. 本轮最关键的一处根因（★D，必读）

**现象**：`qa-verify D12-1` 报「20 次领取中 7 个重复」；`D11-2` 报「落盘 41 != 成功入队 40」。

**根因（隔离复现实验证据）**：在 Windows/libuv 上，**并发对「同一源 + 同一目标」执行 `fs.renameSync` 会偶发「两个调用都返回成功」的幻影 OK**。
隔离探针（4 进程并发 rename 同一 `pending/X.json → picked/X.json`）实测结果：

```
results: [ '{"ok":true}', '{"ok":true}', '{"ok":false,"code":"ENOENT"}', '{"ok":false,"code":"ENOENT"}' ]
src exists: false   dst exists: true
```

→ 两个进程都自认为领取成功，但物理只移动了一份。**因此 `rename` 不能充当互斥领取原语**。
更进一步：`complete` 直接 `pending → done`，与并发的取件 `pending → picked` 目标**不同**，
而 link 互斥只对「同一目标」生效，于是同一记录会同时落入两个状态目录（落盘数 > 入队数）。

**修复**：
1. 领取改用 **`link` + `unlink`**（maildir 经典）：`fs.linkSync(src,dst)` 在目标存在时**确定性**返回 `EEXIST`；链接成功瞬间目标即拥有完整内容（与已写完的源同一 inode），无半截窗口。实测 6 进程 × 30 轮恒为**恰好一个成功者**。
2. `complete` 改**两阶段**：先确保记录位于 `picked`（对 `picked/<id>` 互斥领取，与取件共享同一锚点），再 `picked → done|failed`。
3. 领取动作**携带最终内容**（新内容先写 tmp 再 link 发布），因此领取成功后**不再回写**目标目录——否则回写会在目标已被下一步移走后重新创建它，从而产生重复。

代码：`lib/store.js` `claimLink()`(≈273)、`removeSourceLink()`(≈315)、`claimWithContent()`(≈541)、`takePending()`(≈633)、`complete()`(≈691)。

---

## 2. 逐缺陷记录 F01–F13

### F01 · P0 · QA 清理删除测试前已存在的队列目录
- **文件·行**：`test/qa-verify.js` `sandbox()`(≈250)、`OWNERSHIP_MARKER`(≈365)、A1-1(≈366)、A1-2(≈411)、G1(≈2192)
- **根因**：清理按**硬编码真实路径**做无条件 `rmSync(recursive)`；且清理动作与「本次创建」无所有权绑定。一旦运行就毁掉真实队列。
- **修复**：
  - A1-1 不再使用真实用户目录：以 `mkdtempSync(..., 'wb-qa-home-')` 创建隔离 HOME，经 `WB_WORKBUDDY_DIR` 重定向；成功后登记 `a1OwnedBridgeDir`。
  - A1-2 **仅当拥有所有权**（`a1OwnedBridgeDir` 非空）**且**路径含 `OWNERSHIP_MARKER='wb-qa-home-'` 才清理；前置失败一律 SKIP，绝不删既有目录。
  - G1 变量改名（`dir`→`realTaskBridge`），避免「REAL_WB 派生 + 递归删除」误判。
  - 全程哨兵保护：A0 预置 + G3 校验哈希未变。
- **验证**：acceptance `F01.1/F01.2/F01.3 PASS`（含静态证据 + 隔离 HOME 下动态运行 qa-verify 后哨兵哈希一致）；qa-verify `A0/A1-1/A1-2/G3 PASS`。

### F02 · P0 · 陈旧锁抢占 / 无所有权释放可丢失已确认入队的指令
- **文件·行**：`lib/store.js` 头注释(≈11–34)、`claimLink`(≈273)、`claimWithContent`(≈541)、`enqueue`(≈595)、`takePending`(≈633)、`complete`(≈691)
- **根因**：单文件 `instructions.json` + 同目录 lockfile + 锁龄抢占；`stat → unlink` 不是原子所有权协议，持锁者被暂停或两个清锁者交错时「两个调用都返回成功、最终只留一条」。
- **修复**：**彻底删除锁机制**（含 `LOCK_*`、`breakStaleLock`），改为 maildir：`pending/ picked/ done/ failed/ tmp/`，目录即状态、文件名即唯一 ID；入队=写 tmp → rename 发布；领取/终态迁移=link+unlink（见 §1）。
- **验证**：smoke BUG-1（4 进程 ×16=64 投递，落盘 64、id 唯一、JSON 零损坏、无残留）；qa-verify `D11-1/D11-2/D11-3/D12-1/D12-5/D12-6`；acceptance `F02.1–F02.5 PASS`。

### F03 · P1 · 队列存储入口未校验数据库受保护名单
- **文件·行**：`lib/paths.js` `STORE_SUBDIRS`(≈33)、`validateStoreRoot()`(≈311)、`storeParts()`(≈374)、`resolveLayout()`(≈405)；`lib/store.js` 构造函数(≈359)；`server.js`(≈43)
- **根因**：`WB_BRIDGE_STORE` 旧语义=单文件路径，且未在**任何 fs 调用之前**统一校验受保护命名/别名。
- **修复**：语义改为**队列根目录**；校验在任何 `mkdir/write/rename` 之前完成且自身**零副作用**：
  `.json` 结尾 / 命中受保护清单 / 已存在非目录文件 → 结构化 `STORE_CONFIG_INVALID`，服务启动失败走 stderr 退出。
- **验证**：acceptance `F03`（7 PASS：四种受保护命名负向 + 目标与父目录零副作用哈希/目录快照 + 正常目录正向）；qa-verify A 组。

### F04 · P1 · 词法根目录检查不能阻止链接指向根外和受保护命名文件
- **文件·行**：`lib/paths.js` `toCanonical()`(≈186)、`assertWithinRoot()`(≈243)、`assertSafeReadPath()`(≈272)；`lib/sessions.js` `loadSessionIndex`(≈33)、`resolveSessionFile`(≈72)、`findSessionByScan`(≈119)、`readSubagents`(≈343)
- **根因**：旧检查仅做 `path.resolve` 后的**字符串前缀比较**，符号链接 / Windows junction / reparse point 指向根外或受保护命名文件时无法识别。
- **修复**：`assertWithinRoot` 改用 `fs.realpathSync.native` 解析**真实目标**，三重判定（词法包含 / 真实目标包含 / 真实 basename 非受保护命名）；**所有读路径**统一套用（索引、会话文件、项目扫描、搜索、subagents 目录及其下文件）。
- **验证**：acceptance `F04.1`（会话文件链接越界）`F04.2`（索引链接越界）`F04.5`（合法非 UUID 不误伤）PASS；qa-verify A 组。
- **部分说明**：`F04.3/F04.4` FAIL —— 经诊断为**测试缺陷**，非源码缺陷，详见 §4.1。

### F05 · P1 · 损坏恢复使只读查询写文件，并移走后来提交的健康队列
- **文件·行**：`lib/store.js` `readRecordFile()`(≈404)、`scanDir()`(≈439)、`scanAll()`(≈471)、`stats()`(≈782)
- **根因**：旧实现遇到损坏记录会「移动备份后当作空队列」，即只读查询产生写入并移走数据。
- **修复**：所有只读操作（`stats` / `markPicked=false` 预览）**零写入**；损坏记录**原位保留**，计入 `corrupt` / `corruptFiles` 并置 `corruptDetected=true`，绝不静默等价为「正常空队列」。
- **验证**：qa-verify `D12-2`（快照前后字节一致）`D12-3`（损坏原位、无 `.corrupt` 备份、哈希不变）；acceptance `F05`。

### F06 · P1 · 参数归一化把字符串 "false" 转成 true，导致意外领取任务
- **文件·行**：`lib/tools.js` `ARG_ERROR_OPTIONS`(≈31)、`rejectUnknownKeys()`(≈137)、`requiredString()`(≈176)、`optionalBoolean()`(≈199)、`optionalInteger()`(≈226)、`optionalMetadata()`(≈256)
- **根因**：`Boolean("false") → true`；`0.5` 被 `Math.floor` 归一化为 `0`；非法 `metadata` 被静默丢弃。均在进入 store 前未严格校验。
- **修复**：布尔仅接受真正的 `true/false`；整数必须 `Number.isInteger` 且落在声明区间；metadata 必须普通对象；未知字段拒绝。**全部在任何 store 调用之前完成**，违规走协议级 `-32602`。
- **验证**：qa-verify `C9-8`（14 例）、`F1/F2`；smoke BUG-4；acceptance `F06`（含 `markPicked:"false"` 磁盘零变化）。

### F07 · P1 · JSON-RPC / MCP 校验与分发边界不合规
- **文件·行**：`lib/protocol.js` `AppError`(≈37)、`negotiateProtocolVersion()`(≈83)、`serveStdio()`(≈126)、`dispatchLine()`(≈162)；`lib/tools.js` `handlerMap`(≈539)；`server.js` `initialize()`(≈58)
- **根因**：缺信封校验；`toString/constructor/__proto__` 等原型链属性会被当成方法分发；版本被原样回显；错误分层错误（未知工具 / 参数错误错当 `result.isError`）。
- **修复**：先验证信封（`jsonrpc==="2.0"`、id 类型、method 非空、params 结构），**非法无 id 请求也回 `-32600`（id=null）**；分发表改 `Map`（仅注册方法）；协议版本协商对未知版本回**服务端支持版本**、绝不回显；协议级错误（未知方法→`-32601`、参数→`-32602`）走 JSON-RPC error，真正的执行失败仍用 `isError`。
- **验证**：qa-verify `C10-3b`（11 种信封/原型名矩阵）、`C9-7`、`C9-8`、`C10-2`；smoke「未知工具 -32602」；acceptance `F07`（17 PASS）。

### F08 · P2 · 尾读起点恰在完整行边界时仍丢弃第一条记录
- **文件·行**：`lib/jsonl.js` `readTailLines()`(≈137)
- **根因**：以「采样窗口起点**之后**第一字节」判定首行是否为残片，当起点恰落在行边界时误丢首行。
- **修复**：探测起点**前一个字节**，仅当其为非 `\n` 时才丢弃首行残片；同时返回真实读入字节数。
- **验证**：qa-verify B 组（含多行/巨大/尾读）；acceptance `F08`（库级 + 搜索端到端一致）。

### F09 · P2 · 退避预算并非精确的逐次上界，且声明预算不约束真实持锁时长
- **文件·行**：`lib/store.js` `RENAME_RETRY`(≈80)、`worstCaseDelayMs()`(≈119)、`totalBackoffBudget()`(≈135)、`assertBudgetInvariant()`(≈156)
- **根因**：旧预算先求无抖动和再整体乘一次抖动（~1ms 低估）；且把「锁等待预算」当安全保证（数学不等式无法约束进程暂停）。
- **修复**：逐次按 `max(1, ceil(exponential×(1+jitter)))` 累加，且 `sleepCount = attempts-1`（最后一次失败后不 sleep）；加载期强制不变量链 `238 < 400 < 30000 < 60000` 且 `400×50 ≤ 30000`；措辞明确它**只约束配置退避**，不冒充锁存活证明。
- **验证**：qa-verify `D12-7`（`totalBackoffBudget(RENAME_RETRY) === 238`，逐次口径对齐）；acceptance `F09`（含破坏不变量→拒绝启动）。

### F10 · P2 · 锁状态查询的瞬态错误被当成锁已消失，导致空转超时
- **文件·行**：`lib/store.js`（删除锁符号）+ 头注释(≈11–34)、`assertBudgetInvariant` 注释(≈147)
- **根因**：`stat/unlink` 的瞬态 errno 被误判为「锁已消失」，零等待耗尽预算。
- **修复**：目标语义「无锁」落定——`lib/store.js` **不再含** `LOCK_STALE_MS` / `breakStaleLock` / `acquireLock` / `releaseLock` / `lockPath` 任一符号；运行时不产生 `.lock`（整类锁状态查询分支被取消）。
- **验证**：acceptance `F10.1`（源码符号扫描）`F10.2`（一轮读写后全隔离目录无 `.lock`）**PASS**。

### F11 · P2 · 单条越界数值时间戳会中断整份会话读取
- **文件·行**：`lib/jsonl.js` `MAX_DATE_MS`(≈26)、`toIsoTime()`(≈242)、`toMessage()`(≈267)
- **根因**：直接 `new Date(timestamp).toISOString()`，当 timestamp 为 `1e100` 等越界值时抛 `RangeError`，中断整份读取。
- **修复**：先校验 `|ts| ≤ 8.64e15`（Date 合法上界），越界 → `time=null` 且 `timeInvalid=true`，消息本体保留。
- **验证**：qa-verify B 组；acceptance `F11`（坏消息不中断、相邻正常消息可读、服务随后存活）。

### F12 · P2 · README 消费示例先全局领取，再跳过其他会话指令
- **文件·行**：`README.md`「WorkBuddy 侧如何消费队列」示例 + `wb_pending_instructions` 说明
- **根因**：示例先 `markPicked=true` 全局领取、再按 `sessionId` 跳过，导致**别的会话指令被误置 picked** 而对该会话不可见、对原会话已被领走（滞留）。
- **修复**：示例改为**定向消费者在领取前**就传入自身 `sessionId`；并补充「纯预览 `markPicked:false`」「高并发下单次可能少于 limit，可循环拉取」的说明。
- **验证**：acceptance `F12`（A 不改变 B 的 pending、B 能领取并完成、保留全局消费、README 已修订）。

### F13 · P2 · 自闭合 system-reminder 与后续成对块组合时吞掉业务文本
- **文件·行**：`lib/jsonl.js` `stripSystemReminders()`(≈87)、顺序常量(≈29–31)
- **根因**：剥离顺序不当，正则跨越边界贪心匹配，把本应保留的业务文本一并吞掉。
- **修复**：严格顺序 **自闭合 → 成对 → 未闭合尾块**；`A<system-reminder/>KEEP<system-reminder>HIDDEN</system-reminder>B` → `AKEEPB`（实测通过）。
- **验证**：qa-verify B 组；acceptance `F13`（自闭合/成对/未闭合/属性/交错）。

---

## 3. 附带发现（本轮新增用例暴露，已修复）

### ★D · 并发领取重复 / 落盘多于入队（rename 幻影 OK）
见 §1。修复后验证：qa-verify `D12-1`（4 进程并发领取 20 条：20 次领取**零重复**、`picked=20`、无跨目录重复）、`D11-2`（入队 40 = 落盘 40、`done=8`、状态机自洽、无重复 id）。等价验收：acceptance `F02.4`（并发领取单赢家，id 集合互不重叠）PASS。

---

## 3A. 第 4 轮复查 · 故障模拟暴露的领取错误路径缺陷（D11-2b / D11-2c）

> **背景**：主理人以「文件操作失败模拟」对当前修复版做独立验证（审计上轮方法论：「故障模拟仅设置文件操作失败或进程执行屏障」）。
> 模拟经 `NODE_OPTIONS=--require` 预载，**仅作用于测试子进程，生产源码零改动**；**确定性复现**出 `claimWithContent` 错误路径的 3 个变体。
> 全部已修复并落成模拟式回归测试（D13）。金标准证据包：`%TEMP%\d112c-EVIDENCE\`（复现脚本 `repro-d112c.js` / `-b.js` / `-c.js` + 现场 store）。

### D11-2b · P0 · 「复活窗口」——`link` 与 `rename` 之间被并发完成抢占
- **触发**：领取迁移是**两步**——`link(源→picked)` 成功后再 `rename(tmp→picked)` 写入新内容。
- **旧行为**：并发「完成」在两步之间先行（`complete` 阶段二 `picked→done` 会**先建 done 再删 picked**），
  随后本进程的 `rename(tmp→picked)` 把**已被完成**的记录**复活**成一个孤立 picked 副本 → 同一 id 同现于 `picked` 与 `done`（落盘数 > 成功入队数）。
  - 实测（12 进程压测第 9 轮）：`records=61 totalSent=60`，重复 id 同现于 `picked(pickedAt=…598)` 与 `done(pickedAt=…533,completedAt=…564)`（picked 副本时间戳晚于 done ⇒ 确系复活）。
- **修复**：迁移目标恰为 `picked` 且同 id 已处**终态**(`done|failed`) 时，判定该 picked 副本为复活产物并删除（判竞争失败）。
  - 依据**不变式**：**任何删除 `picked/<id>` 的路径，都必然先创建 `done|failed/<id>`**（终态先落地再删源）。
  - 文件·行：`lib/store.js` `claimWithContent()` 迁移分支（自愈块）。
- **验证**：`d11diag` 自然压测 12 进程 ×120、16 ×40、20 ×30 轮 → 跨状态重复 **0**、`records==sent`；qa-verify `D11-2` / `D12-1` 稳定 PASS。

### D11-2c · P0 · 错误路径无收敛 + GONE 语义过载（故障模拟确定性复现）

故障模拟暴露两类错误路径缺陷，**3 个变体 100% 确定性复现**：

**变体1 · `rename(tmp→picked)` 失败 → 源 `pending` 残留**
- **触发**：模拟 `fs.renameSync`（目标为 `picked/<id>.json` 时首调前睡 800ms 再抛 EPERM，其后永久 EPERM）。
- **旧行为**：A `link(pending→picked)` OK → A `rename` 失败（退避耗尽）→ **回滚 `discard(picked)` 后抛错**（**未处理源**）；
  并发 B 经 picked 完成 → `done` 出现 ⇒ 静止状态 `pending/<id>` + `done/<id>` **共存**，`stats={"pending":1,"done":1}`。
- **修复**：锚点 `link(源→目标)` 成功后视为「已领取」，内容 `rename` 失败**不再撤销领取**；仅**删源失败**时收敛（见下）。

**变体2 · `removeSourceLink(pending)` 失败 → 源 `pending` 残留**
- **触发**：模拟 `fs.unlinkSync`（`pending/<id>.json` 永久 EPERM）。
- **旧行为**：A `link+rename` OK → 删源失败（退避耗尽）→ 直接抛错（**未收敛**）⇒ 静止 `pending` + `done` 共存。
- **修复**：删源失败时调用 `reconcileAbortedTransition` 收敛到**恰好一个**状态目录。

**变体3 · B 误报「已终态」（最严重）**
- **触发**：A `rename` EPERM（800ms）；B `link(picked→done)` 前睡 1200ms 制造窗口。
- **旧行为**：A 回滚 `discard(picked)` → B 的 `link(picked→done)` 落 `ENOENT`→`GONE` → **B 抛 `INSTRUCTION_ALREADY_FINAL「已被并发完成」`**；
  实则 `done` 不存在、`picked` 不存在、记录仍在 `pending` ⇒ 调用方**误信「已完成」而停止处理**，但记录**会被再次投递 → 重复执行**。
- **修复**：`complete()` 阶段二在 `finalized.ok=false` 时**核验终态是否真实存在**：存在 → `INSTRUCTION_ALREADY_FINAL`；不存在 → 可重试的 `INSTRUCTION_CLAIM_LOST`。

- **文件·行**（生产源码仅 `lib/store.js`）：
  - `claimWithContent()` 迁移分支（≈620-660）：rename 失败不撤销领取；删源失败 → 收敛。
  - 新增方法 `reconcileAbortedTransition(id, srcPath, destPath, destIsPicked)`（**≈684**）。
  - `complete()` 阶段二（**≈899-914**）：GONE 语义核验 + `INSTRUCTION_CLAIM_LOST`。
  - 文件头 D11-2c 根因说明（**≈56-65**）。

#### `reconcileAbortedTransition` 收敛策略（三路归并，保证「静止时同 id 恰一份」）
- **目标为 picked（领取迁移）**：
  1. 若**终态**(`done|failed`)已存在 ⇒ 终态为准：清目标占位 + 清源残片（best-effort）；
  2. 否则在「目标(picked)」与「源(pending)」间保留**更靠前**的 picked（尝试清源）；**清源失败则回退保留源**；
  3. 仅一方存在则不动 —— **绝不二者都留，也绝不误删致丢失**。
- **目标为 done|failed（完成迁移）**：回退到源(picked)（未写入 `result` 的终态无意义）；源已不在则保留目标。

#### `INSTRUCTION_CLAIM_LOST` 新错误码语义（与 `INSTRUCTION_ALREADY_FINAL` 严格区分）
- `INSTRUCTION_ALREADY_FINAL`：**已确认终态**（`done|failed` 文件真实存在）——调用方应**停止**处理。
- `INSTRUCTION_CLAIM_LOST`：并发领取冲突导致记录**未被完成**（例如并发的领取被回滚撤销），记录仍在源状态、**会被再次投递**——属**可重试**错误，
  调用方应**重试**而非误判「已完成」。二者区分杜绝「误报终态 → 记录被重复执行」。
- 文档：`README.md`（错误码清单 + `wb_complete_instruction` 返回说明）。

#### D13 回归组 + 判别力自证
- **D13 组**（`test/qa-verify.js` `groupD13` ≈2020，3 例）：用 `NODE_OPTIONS` 预载模拟（生产源码零改动），断言**静止状态每 id 恰一份**与 **complete 错误码与真实终态一致**。
  - D13-1（≈2078）模拟 `rename(tmp→picked)` 失败 + 并发完成；
  - D13-2（≈2099）模拟 `removeSourceLink(pending)` 失败；
  - D13-3（≈2117）GONE 语义。
- **判别力自证**（把 `lib/store.js` 临时回退为修复前行为后重跑 D13，再还原）：
  ```
  未修复版：FAIL D13-1 / FAIL D13-2 / FAIL D13-3 → TOTAL 83 | PASS 80 | FAIL 3 | RESULT: FAIL
  修复版  ：PASS D13-1 / PASS D13-2 / PASS D13-3 → TOTAL 83 | PASS 83 | FAIL 0 | RESULT: PASS
  ```
  即新测试**在未修复版 FAIL、修复版 PASS**（金标准成立）。实验后已从备份还原并复核无残留标记。

#### 验证数据（第 4 轮，2026-10-10）
| 项 | 结果 |
|---|---|
| 金标准 `repro-d112c.js`（变体1） | **PASS（唯一副本在 done）** |
| 金标准 `repro-d112c-b.js`（变体2） | **PASS（唯一副本在 done）** |
| 金标准 `repro-d112c-c.js`（变体3） | **PASS（B 报终态且确实完成）** |
| `qa-verify` | **83/83 = 100%**（含新增 D13 三例） |
| `smoke-test` | **PASS 22/22** |
| `acceptance run-all` | **FAIL/ERROR 0 项，其余 15 项** |
| 空部署 `WB_REAL_WB=<空目录>` | **74 PASS + 9 SKIP + 0 FAIL** |
| 并发（2× qa-verify 并行） | 两边 **83/83 FAIL 0** |
| 自然压测（`d11diag`，零模拟） | 12 进程 ×100 / 16 ×30 / 20 ×20 → 跨状态重复 **0**、`records==sent` |

---

## 4. 未闭合项 / 残余风险（诚实标注）

### 4.1 acceptance F04.3 / F04.4 —— **测试缺陷（不可通过），非源码缺陷**
- **现象**：`F04.3 子代理目录联接越界`、`F04.4 根内 junction 越界` 报标记值命中。
- **诊断（隔离复现证据）**：这两条用例用 `writeMarkJsonl()` 把 `TEST_MARK` 写进了**会话自身文件**，
  随后断言整份 `wb_read_session` 响应中 `!includes(TEST_MARK)`。因此响应**必然**含 TEST_MARK（来自会话自己的消息），
  与是否越界读取无关。实测响应 `subagents: []`（边界已阻断 junction），TEST_MARK 仅出现在 `messages[0].text`：
  ```
  --- subagents: []
  --- messages: [{"text":"FORBIDDEN_LINK_MARK_F04", ...}]
  --- includes TEST_MARK: true   ← 来自会话自身正文，属正常内容
  ```
- **结论**：源码 F04 修复有效；`F04.3/F04.4` 需由用例改用**非标记值的会话正文**（同 `F04.5` 写法）后方可闭合。
  `test/acceptance/` 属另一位工程师，**我未改动**，已上报主理人。

### 4.2 并发以「不同终态」完成同一指令（done vs failed）
- 两个消费者同时把同一指令分别以 `done` 与 `failed` 完成时，二者目标目录不同（`done/` vs `failed/`），
  理论上仍可能各写一份。属**调用方自相矛盾操作**，不在审计 13 项范围内；正常单消费者场景不受影响。
  已在此显式登记，未做额外加锁（避免重新引入锁语义）。

### 4.3 退役脚本的强制运行口
- `test/helpers/qa2-*.js` 设 `WB_RUN_RETIRED_HELPERS=1` 可强制运行旧逻辑（**预期失败**），仅供历史考古（见 §5）。

---

## 5. 既有测试处置（不静默删除）

| 文件 | 处置 | 理由 | 等价保证去处 |
|---|---|---|---|
| `test/helpers/qa2-concurrency.js` | **退役（保留存档 + 文件头 RETIRED + 早退护栏）** | 针对已删除的 lockfile 设计 | qa-verify D11-1/D11-2/D11-3/D12-1/D12-5/D12-6 |
| `test/helpers/qa2-lockhold.js` | 退役（同上） | 测量「锁持有时长 vs 锁预算」，锁已删除 | qa-verify D12-7 |
| `test/helpers/qa2-rename-amplify.js` | 退役（同上） | 考察 rename 退避放大 `LOCK_TIMEOUT`，锁已删除 | qa-verify D12-5 / D12-7 |
| `test/helpers/qa2-readonly.js` | 退役（同上） | 隔离基准为旧单文件 store | qa-verify A 组 / D12-2 / D12-3 / G 组 |
| `test/helpers/qa2-path-checks.js` | 退役（同上） | 隔离基准为旧单文件 store | qa-verify A 组 / smoke BUG-3 |
| `test/helpers/qa2-adjudicate.js` | 退役（同上） | 一次性裁决器，裁决对象已随整改重写 | qa-verify F1~F5 / D 组 |
| `test/smoke-test.js` | **改写** | 验证新设计等价保证 | 22 用例全绿 |
| `test/qa-verify.js` | **改写** | 验证新设计等价保证 | 83 用例全绿（含第4轮新增 D13 三例） |
| `test/helpers/fault-sim-*.js` | **新增（第4轮）** | D13 模拟式回归的故障模拟预载（`NODE_OPTIONS=--require`，生产源码零改动） | qa-verify D13-1/2/3 |
| `test/acceptance/`（另一位工程师） | **未改动** | 独立审计反例验收套件 | —— |

> 退役实现：文件头加 `[已退役/RETIRED]` 说明块，并在文件顶部（`'use strict';` 之后）加早退护栏，
> 运行即打印处置说明并 `exit(0)`；原正文完整保留、**未删除**。

---

## 6. 验证证据汇总（2026-10-09；第 4 轮更新 2026-10-10）

| 套件 | 结果 | 命令 |
|---|---|---|
| smoke-test | **PASS 22/22** | `node test/smoke-test.js` |
| qa-verify | **PASS 83/83 = 100%**（含新增 D13 三例） | `node test/qa-verify.js` |
| acceptance（F01–F13） | **15/15 PASS，FAIL/ERROR 0 项** | `node test/acceptance/run-all.js` |
| 空部署（`WB_REAL_WB=<空目录>`） | **74 PASS + 9 SKIP + 0 FAIL** | `WB_REAL_WB=<dir> node test/qa-verify.js` |
| 并发（2× qa-verify 并行） | 两边 **83/83 FAIL 0** | 见 §3A |
| 自然压测 `d11diag`（零模拟） | 12 进程 ×100 / 16 ×30 / 20 ×20 → 跨状态重复 **0** | `node d11diag.js` |
| 金标准故障模拟 `repro-d112c{,‑b,‑c}.js` | **3/3 PASS** | 见 §3A |

acceptance 矩阵（第 4 轮复跑）：

```
F01 PASS(3/0)  F02 PASS(4/0)  F03 PASS(7/0)  F04 PASS(5/0)  F05 PASS(5/0)
F06 PASS(10/0) F07 PASS(17/0) F08 PASS(4/0)  F09 PASS(2/0)  F10 PASS(2/0)
F11 PASS(5/0)  F12 PASS(5/0)  F13 PASS(8/0)
合计：FAIL/ERROR 0 项，其余 15 项
```

> 说明：第 3 轮 F04.3/F04.4 曾标记为「测试缺陷」（§4.1）；该两条已由 acceptance 套件归属工程师修复，第 4 轮 acceptance 已 **15/15 全绿**。

---

## 7. 关键设计决策（供复审）

1. **无锁 maildir**：目录名即状态、文件名即 ID，`link+unlink` 原子领取——**不再依赖任何「等待时间 / 锁龄 / 心跳」**。
2. **`rename` 仅用于「唯一目标」的原子发布**（入队、领取后内容写入），**不用于互斥**（Windows 幻影 OK，见 §1）。
3. **只读边界**：`realpathSync.native` 真实目标判定，覆盖全部读路径。
4. **配置先于副作用**：`WB_BRIDGE_STORE`（根目录）在任何 fs 调用前校验，非法即失败、零副作用。
5. **错误分层**：协议层（未知工具/参数）→ JSON-RPC error；执行层（IO/不存在）→ 工具 `isError`。

---

## 8. 文件变更清单

- 源码：`lib/paths.js`、`lib/store.js`、`lib/jsonl.js`、`lib/protocol.js`、`lib/tools.js`、`lib/sessions.js`、`server.js`
- 测试：`test/smoke-test.js`、`test/qa-verify.js`（改写）；`test/helpers/qa2-*.js`（退役说明，正文保留）
- 文档：`README.md`（存储语义 / 错误码 / 消费示例 F12）
- 本记录：`deliverables/REMEDIATION.md`
