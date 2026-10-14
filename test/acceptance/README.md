# test/acceptance —— 独立审计反例验收套件

针对外部审计（ChatGPT）对 `workbuddy-session-bridge` 出具的不通过裁决（13 项缺陷：2×P0 / 5×P1 / 6×P2），
把审计的**可复现反例**与**闭合验收条件**落成可执行测试。

- **不修改任何既有文件**（`lib/`、`server.js`、`README.md`、`test/smoke-test.js`、`test/qa-verify.js`、`test/helpers/`）。
- **零第三方依赖**，与既有测试**无共享代码**。
- 按「整改后的目标语义」编写：在源码修好之前会**失败**，修好之后**通过**。

## 如何运行

```bash
# 全部（F01 优先，含哨兵保护在前）
node test/acceptance/run-all.js

# 单项（可单独运行，每个文件自包含）
node test/acceptance/f02-mutex-no-loss.js
```

退出码：存在 `FAIL` 时为 `1`，否则 `0`（`ENV` / `SKIP` 不算产品失败）。

## 结果分类（审计方明确要求区分）

| 标记 | 含义 |
|---|---|
| `PASS` | 断言成立（整改已达成该验收条件） |
| `FAIL` | 产品缺陷：反例成立 / 目标语义未满足 |
| `SKIP` | 前置条件不满足（如依赖的文档尚未修订），非产品缺陷 |
| `ENV` | 环境限制（如 Windows 无 SIGSTOP、无法建文件符号链接），**绝不计作通过** |

每个文件末尾输出机器可读行：`__RESULT__ {"id":"F02","verdict":"FAIL",...}`，供 `run-all.js` 汇总。

## 缺陷 ↔ 用例 ↔ 目标语义

| 编号 | 级别 | 用例文件 | 对应目标语义 / 闭合条件 |
|---|---|---|---|
| F01 | P0 | `f01-cleanup-sentinel.js` | QA 清理不得删除测试前已存在文件；清理须绑定所有权标记；**放在所有写测试之前** |
| F02 | P0 | `f02-mutex-no-loss.js` | 无锁 maildir；**逐 ID** 比对成功回执 vs 最终持久状态；允许明确失败，不允许两个成功回执只留一个 |
| F02B | P0 | `f02b-claim-window-pause.js` | 领取临界窗口内**暂停/崩溃**（`NODE_OPTIONS` 模拟 `fs.linkSync` 故障，替代不可用的 SIGSTOP）：暂停→并发领取单赢家（EEXIST 跳过）；崩溃→记录不丢失且不重复投递。**含判别力自证**（幻影成功模拟必检出双赢家） |
| F02C | P0 | `f02c-shared-handle.js` | **共享只读句柄**下领取（Windows share-mode）：成功则内容完整、失败则记录仍在 pending；并发无重叠、无丢失、无重复。**含判别力自证** |
| F03 | P1 | `f03-store-boundary.js` | `WB_BRIDGE_STORE` 指向四种受保护命名 → 拒绝，且目标与父目录**零读写/移动/新建副作用**（哈希+目录快照） |
| F04 | P1 | `f04-link-boundary.js` | 符号链接/junction 指向根外或受保护命名 → 拒绝读取（会话/索引/subagents/根内指向根外）；保留合法非 UUID。**含判别力自证**：禁用 realpath 收口后标记值必须出现，否则判 FAIL。会话自身文件用非标记值内容，仅根外测试文件携带标记值|
| F05 | P1 | `f05-readonly-no-write.js` | 只读操作（stats / preview）**零写入**；损坏只计数上报（`corruptCount`/`corruptFiles`），**永不自动移动或修复**，不得等价为「正常空队列」 |
| F06 | P1 | `f06-param-strictness.js` | `markPicked:"false"`（字符串）被拒绝且磁盘零变化；`limit:0.5`、非法 metadata 类型同理；保留真布尔 false 预览 / true 消费 / 空白 instruction 拒绝 |
| F07 | P1 | `f07-protocol-boundary.js` | 协议矩阵：`-32700/-32600/-32601/-32602` 分层、原型名不得执行、未知工具走协议层 `-32602`、`arguments` 容器类型、版本协商不得原样回显、合法通知不回包、错误后 ping 存活 |
| F08 | P2 | `f08-tail-window.js` | 尾读窗口起点恰在完整行边界时**不得丢弃**该行（库级 + 搜索端到端一致） |
| F09 | P2 | `f09-backoff-budget.js` | `totalBackoffBudget()` 为**不低估的精确上界**（逐次 ceil、含抖动、attempts-1 次等待）；破坏加载期不等式 → 拒绝启动 |
| F10 | P2 | `f10-lock-removed.js` | 目标语义「无锁」：`lib/store.js` 不再含陈旧锁/加解锁符号；运行时不产生 `.lock` |
| F11 | P2 | `f11-timestamp-overflow.js` | `timestamp:1e100` 的坏消息不得中断整份读取；相邻正常消息可读；服务随后存活 |
| F12 | P2 | `f12-cross-session.js` | 定向会话端到端：A 不改变 B 的 pending、B 能领取并完成；保留全局消费；README 已修订 |
| F13 | P2 | `f13-reminder-order.js` | `A<system-reminder/>KEEP<system-reminder>HIDDEN</system-reminder>B` → `AKEEPB`；覆盖自闭合/成对/未闭合/属性/交错 |

## 隔离与数据保护

- 每个用例用 `harness.makeSandbox()` 建 `mkdtemp` 临时根，并把 `HOME`/`USERPROFILE`/`WB_WORKBUDDY_DIR` 重定向到隔离目录。
- `baseEnv()` 会清除 `TASK`、`WB_BRIDGE_STORE` 等可能影响布局的变量后再显式设置。
- **绝不触碰真实 `~/.workbuddy`**：F01 在静态检查未通过时**拒绝执行** `qa-verify.js`（该脚本当前会对硬编码真实路径做递归删除，运行会毁坏真实队列）。
- 只读证据以「文件 SHA-256 + 目录项快照」为准，而非 mtime 或「没有报错」。

## 已知环境限制（会以 ENV 如实标记）

- **F02.5（`f02-mutex-no-loss.js` 内）**：`SIGSTOP`/`SIGCONT` 本机不可用 → 记 `ENV`。但**同等语义已在本机真实覆盖**：`f02b` 用 `NODE_OPTIONS` 故障模拟（真实 link 后阻塞 / `process.exit(9)`）复现「临界窗口内暂停 / 崩溃」，`f02c` 覆盖「共享只读句柄竞争」。故该 `ENV` 不再构成覆盖缺口。
- **F04.1 / F04.2（文件级符号链接）**：本机 `fs.symlinkSync(target, link, 'file')` **不产生真实 reparse point**，而是退化为一个普通**空文件**（`lstat().isSymbolicLink()===false`、`readFileSync()===''`）。这意味着若不校验链接真实性，「无命中」只是因为文件为空 —— 是**空过（vacuous pass）**，并非边界生效。故本用例会校验链接真实性，无法创建真实符号链接时如实记 `ENV`（不在本机伪装通过）。目录 junction 免管理员、可正常工作，故 F04.3/F04.4 改用**目录联接**承载越界场景，覆盖同一段 realpath 收口逻辑。
- **F09.2**：若 `lib/store.js` 的预算常量被重命名/移除，则跳过（记 SKIP），不伪装通过。

## 文件说明

```
harness.js            共享工具：隔离目录、快照、MCP 客户端、结果四分类
f01..f13-*.js         每个缺陷一个独立、可单独运行的用例
f02b-*.js f02c-*.js   F02 补充场景（临界窗口暂停/崩溃、共享只读句柄竞争）
_probe-lexical-realpath.js  仅供 F04 判别力自证：把 realpath 退化为词法 resolve 的预载
_fault-sim-link.js       仅供 F02B/F02C：包装 fs.linkSync 模拟 pause/crash/phantom 故障
run-all.js            汇总运行器 + 矩阵输出
README.md             本文件
```

> 故障模拟与判别力自证预载**只经测试子进程的 `NODE_OPTIONS=--require` 生效**，**不修改任何生产源码**。
