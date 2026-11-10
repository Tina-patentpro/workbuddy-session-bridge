# 从 Codex 或 WorkBuddy 开始安装

连接器在同一台电脑上通过本地 MCP 服务共享任务队列。任选一端先装 Skill，它就能指导后续配置和安装另一端 Skill。Skill 提供操作指引，MCP 提供会话读取、任务投递、领取和回填工具。

| 你要做什么 | 需要配置 |
| --- | --- |
| 在 Codex 查看、搜索 WorkBuddy 的本机会话 | Codex Skill 和 Codex 侧 MCP |
| Codex 派任务，WorkBuddy 领取、执行并回填 | 两端 Skill、两端 MCP，以及同一个本地队列目录 |

## 先从 Codex 开始

1. [下载 Codex Skill 0.1.0](../skills/packages/codex-workbuddy-bridge-0.1.0.zip?raw=true)，解压得到 `codex-workbuddy-bridge` 目录。
2. 将整个目录放到用户级 `~/.agents/skills/` 下。Windows 对应 `%USERPROFILE%\.agents\skills\`。最终文件应为 `~/.agents/skills/codex-workbuddy-bridge/SKILL.md`。已下载完整仓库、只在该仓库使用时，也可直接使用仓库自带的 `.agents/skills/codex-workbuddy-bridge/`，在该仓库目录打开 Codex。
3. 新开 Codex 会话，输入下面这句话。

   > 使用 $codex-workbuddy-bridge 指导我安装并配置 MCP。我想从 Codex 给 WorkBuddy 派任务，请同时指导我安装 WorkBuddy 取件 Skill。先用只读工具验连。

4. 按下面的配置步骤准备源码、配置两端 MCP，并将 [WorkBuddy Skill 0.1.2](../skills/packages/workbuddy-bridge-consumer-0.1.2.zip?raw=true) 上传到 WorkBuddy。

只查历史时，可以把第 3 步改成「使用 $codex-workbuddy-bridge 指导我配置 MCP，只在 Codex 读取 WorkBuddy 本地历史」。

## 先从 WorkBuddy 开始

1. [下载 WorkBuddy Skill 0.1.2](../skills/packages/workbuddy-bridge-consumer-0.1.2.zip?raw=true)，保留 ZIP 用于上传。
2. 在 WorkBuddy 桌面端进入「专家·技能·连接器 → 技能 → 添加技能 → 上传技能」，选择该 ZIP。在「已安装」中确认「WorkBuddy 会话桥取件」已启用。
3. 在本地会话中输入下面这句话。

   > 使用 WorkBuddy 会话桥取件 Skill 指导我配置本地 MCP，再指导我在 Codex 中安装配套 Skill、配置同一个 MCP。先用只读工具验连。

4. 按下方配置准备源码与 WorkBuddy MCP，再下载 [Codex Skill 0.1.0](../skills/packages/codex-workbuddy-bridge-0.1.0.zip?raw=true)，按上一节放入 Codex 的 Skill 目录。新开 Codex 会话调用 `$codex-workbuddy-bridge`。

## 准备本地运行环境

安装并登录你要使用的 Codex 和 WorkBuddy 客户端。在同一台电脑上保存一份连接器源码，两端可共用这份源码。

可通过仓库页面的 **Code → Download ZIP** 下载解压，也可以运行下面的命令。

```sh
git clone https://github.com/Tina-patentpro/workbuddy-session-bridge.git
```

把源码放在稳定目录，确认里面存在 `server.js`。运行时要求 Node.js ≥18，连接器零第三方依赖，无需 `npm install`。终端中执行 `node --version` 检查版本。macOS 可用 `command -v node` 查 Node 路径，Windows PowerShell 可用 `(Get-Command node).Source`。

记录 Node 可执行文件和 `server.js` 的本机绝对路径。桌面客户端的 PATH 可能与终端不同，配置中使用绝对路径。MCP 客户端会按配置启动服务进程。

## 配置 Codex MCP

把下面条目合并到 `~/.codex/config.toml`。Windows 对应 `%USERPROFILE%\.codex\config.toml`。保留已有服务，替换示例中的 Node 和源码路径。

macOS 示例使用 TOML 字面字符串。

```toml
[mcp_servers.workbuddy-session-bridge]
command = '/absolute/path/to/node'
args = ['/absolute/path/to/workbuddy-session-bridge/server.js']
```

Windows 示例同样使用单引号，可以直接保留反斜杠。

```toml
[mcp_servers.workbuddy-session-bridge]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\tools\workbuddy-session-bridge\server.js']
```

CLI 用户也可选择 `codex mcp add workbuddy-session-bridge -- "/absolute/path/to/node" "/absolute/path/to/workbuddy-session-bridge/server.js"`。已有同名条目时先核对并更新所需字段。重开 Codex 后，请它调用 `wb_bridge_info({})`。`codex mcp list` 可检查服务登记，实际工具调用用于确认当前会话验连。

## 配置 WorkBuddy MCP

在桌面端「自定义连接器」添加本地 stdio 服务，也可将条目合并到 `~/.workbuddy/mcp.json` 的 `mcpServers`。Windows 对应 `%USERPROFILE%\.workbuddy\mcp.json`。保留已有条目。

macOS 示例使用 JSON。

```json
{
  "mcpServers": {
    "workbuddy-session-bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/workbuddy-session-bridge/server.js"]
    }
  }
}
```

Windows 的 JSON 路径需要双反斜杠。命令和参数各自是一个字符串，带空格的 Node 路径仍作为单个 `command` 值。

```json
{
  "mcpServers": {
    "workbuddy-session-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\tools\\workbuddy-session-bridge\\server.js"]
    }
  }
}
```

重开 WorkBuddy，在目标本地会话中请它调用 `wb_bridge_info({})`。

## 核对同一个队列

两端运行的 MCP 进程通过同一个队列目录交接。比较两端 `wb_bridge_info` 返回的 `paths.storeRoot`。同一系统用户、默认配置下通常为 `~/.workbuddy/task-bridge`，Windows 为 `%USERPROFILE%\.workbuddy\task-bridge`。

需要自定义目录时，在 Codex 配置中增加下面的表，替换为实际绝对目录。

```toml
[mcp_servers.workbuddy-session-bridge.env]
WB_BRIDGE_STORE = '/absolute/path/to/shared-queue'
```

WorkBuddy 在对应服务条目中增加 `env` 对象，例如 `"env":{"WB_BRIDGE_STORE":"/absolute/path/to/shared-queue"}`。Windows JSON 路径仍需双反斜杠。两端保存后重新验连，核对实际返回路径。`WB_BRIDGE_STORE` 指向目录。日常配置应使用日常队列，`TASK=1` 是测试隔离选项。

## 第一次使用

先做只读检查，再选择一项具体任务。

1. 在 Codex 中说「用会话桥列出最近五个 WorkBuddy 会话」。对应工具为 `wb_list_sessions({limit:5,includeCounts:false})`。需要精读时用列表返回的 `conversationId` 调用 `wb_read_session`。macOS 可能返回 `indexSource:"project-scan"`，结合实际会话列表判断读取是否可用。
2. 在 WorkBuddy 的目标会话中确认实际会话 ID。对话标题和业务任务编号各有用途，投递的 `sessionId` 应绑定实际会话。仅查看时说「看看发给当前会话的待处理任务，只做只读预览」，明确使用 `markPicked:false`。
3. 选定一个专用目标会话、一项任务及允许的输入输出。在 Codex 中说「将业务任务 DEMO-001 投递给已确认会话 SESSION_ID，仅在指定输出文件写三行摘要，投递一次」。把 `SESSION_ID` 和文件路径换成实际值。Codex 记录返回的 `instructionId`。
4. 在那个 WorkBuddy 会话中说「领取并执行刚才授权的 DEMO-001，核对指令 ID，完成后用同一 ID 回填」。WorkBuddy 会话需由用户触发主动取件。接口按会话筛选，预览不会锁定某个指令 ID，首次任务使用只有获准任务的专用会话。
5. Codex 根据具名回执核对指令 ID、业务编号、会话和产物，分别报告队列状态及产物验收结果。`queued` 表示已入队，`done` 表示队列已回填。统计计数仅提供汇总。

投递或回填超时时保留本次 ID、产物和原始参数，先查原任务证据。将暂时无法确认的状态保留为待核实，避免重复投递和重做业务。两个 Skill 会指导这类恢复判断。MCP 当前没有按指令 ID 查询结果的工具，双方通过具名回执、目标会话或授权读取的单条队列记录核对。

## 更新与排查

- **更新 Skill**　下载对应新版包。Codex 更新同一安装目录，避免仓库级和用户级重复安装同名 Skill。WorkBuddy 通过技能管理界面更新上传的包，按当前客户端提示处理同名包。新开会话后确认加载到目标版本。
- **更新源码**　在稳定目录更新源码；源码或 Node 路径改变时同步修改两端配置并重新验连。队列迁移需单独核对未完成任务和原队列，保留原任务身份。
- **工具没有出现**　检查 Skill 是否已加载、MCP 服务是否启用、配置格式、Node 和 `server.js` 路径、文件访问权限及宿主日志。
- **安装了 Skill，但 MCP 仍不可用**　继续按本指南配置 MCP，再用当前会话的 `wb_bridge_info` 验证。Skill 可在配置前提供安装指引。
- **两边都连上但看不到同一任务**　比较 `paths.storeRoot`，核对投递与领取使用的实际 `sessionId`，确认使用同一台电脑、相应本地账号与源码。先只读核对原任务。
- **macOS 索引不可读**　查看 `readAccess.sessionsIndexError` 和 `paths.projectsDir`，用会话列表验证 `project-scan` 结果。空列表仍需区分无记录和路径或权限问题。
- **搜索没有命中**　搜索覆盖近期会话及各文件的尾部，以返回的范围为准。已知会话时直接读取。

本次发布包含 Skill 文稿、安装指南及可导入 ZIP。配置示例、工具参数和包内字节经过静态核对；两条 Skill 起步路线的目标客户端实装与完整行为仍待验证。用户实际使用时，模型费用与工具权限按各自客户端和当前任务处理。

相关官方说明见 [Codex MCP](https://developers.openai.com/codex/mcp)、[Codex Skills](https://developers.openai.com/codex/skills)、[WorkBuddy 技能管理](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)及 [WorkBuddy 自定义连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)。
