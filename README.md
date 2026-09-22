# tide

在 CLI 额度恢复后，把”继续”发回原会话。

## 启动并自动监控

在 Git Bash 中构建后，可用 `node /绝对路径/tide/dist/tide.mjs`；已安装本地命令时直接用 `tide`：

```bash
tide claude
tide claude --model <model> --permission-mode plan "检查这个项目"
tide claude --resume <session-id>
tide codex
tide codex -m <model> --no-alt-screen
tide codex resume <session-id>
```

CLI 在**当前终端前台**运行，输入、输出与原 CLI 一样。`claude` / `codex` 后的参数交给原 CLI，不按 Tide 的 `--cli` / `--json` 等参数解析。`--help`、`--version` 和常见非交互子命令只透传，不监控。

同一个 Tide 进程在后台检查这次会话，日志写入 `.tide/launches/`，不刷进 CLI 界面。退出 CLI 就停止监控，不留下常驻 watcher；关闭终端也不再自动恢复。启动包装按正常恢复运行，忽略旧配置里的调试开关 `dryRun` / `skipQuotaCheck`（启动时提示），仍尊重 `sessionDenyList`、等待时间和检查间隔。不要再为同一会话额外启动 `tide watch`。

- Claude 按启动进程的 PID，从 `claude agents --json` 取得会话 ID；不按目录、文件名或“最新聊天”猜。限流恢复时，再核对该进程仍独占同一限流会话，然后只重启这个由 Tide 启动的进程，在当前终端恢复原会话。用户已经发送新消息则不重启。首次参数原样传递；恢复不重复最初的任务文本，保留代码中列明的模型、权限、settings、工具和目录选项。未列明的新 CLI 选项仅保证首次透传。
- Codex 新会话由原生 App Server 创建，并通过原生接口写入一条简短的 Tide 启动说明使空会话可恢复，再把确定的 ID 交给前台 CLI；这一步不调用模型。`resume` 目前要求显式 UUID，选择器 / `--last`、远程会话请直接用原 `codex`。恢复时向同一会话入队，不重启 Codex。此版本只绑定启动时的 Codex 会话，换会话请退出后重新运行包装命令。
- 正常启动不会主动查询额度；只有观察到限流且达到等待时间才检查。Claude 的额度检查会产生真实请求费用。

Windows Git Bash 是本轮验证平台。`npm run dev -- claude` 不用于包装启动，请先构建再运行 `dist/tide.mjs`。

## 读取、发送与等待

```bash
tide tail <id> --cli claude --limit 5 --json
tide tail <id> --cli codex --after <cursor> --limit 10 --json
tide send <id> --cli claude --message-file ./task.txt --json
tide send <id> --cli codex --message "继续修复测试" --dry-run --json
tide wait <id> --cli claude --after <cursor> --timeout 60 --json
```

`tail` 读取用户和助手的文本，不输出思考、工具参数或工具结果。首次给最近 N 条；`--after` 给后续新增消息，`hasMore` 为 true 时继续用返回的 cursor 读取。多行、中文原样保留；尚未写完的 JSONL 行留到下次读取。游标绑定会话和已有内容，文件被替换或截断会明确报错。

`send` 必须且只能指定 `--message` / `--message-file` 之一。文件按 UTF-8 读取；不改配置中的默认续跑提示。返回的 `cursor` 是投递前的基线，并关联这次消息。Codex 的 `stage: queued` 表示入队，Claude 的 `stage: window-requested` 只表示已请求打开**可见 Git Bash 终端窗口**；都不是执行完成。Claude 若被任何交互或后台会话占用，或无法确认占用情况，就拒绝发送，不终止原进程。可在原窗口输入，或关闭原窗口后再发送。`--dry-run` 不投递、不打开窗口。

`wait` 必须使用 `send` 或 `tail` 的 cursor；不会拿旧回复当作本轮完成。使用 `send` 的 cursor 时，先看到该消息真正提交才接受后续结果。Codex 认 `task_complete` / `turn_aborted`，Claude 认 `system.turn_duration` 或 API 错误，不把工具调用或静默当作完成。这里的 `completed` 仅指一轮执行结束，质量仍需验收；等待输入/权限等缺少可靠终态的情况会超时。退出码：0 本轮正常结束，1 本轮错误/限流/中止，2 输入或读取失败，3 等待超时。超时返回原基线，便于继续等待，不杀进程、不重发。

这三个命令不探测额度、不修改 CLI 数据、不把本次参数写进配置；当前只支持扫描范围内（最近 7 天）的主会话。第一版读整份转录校验游标，超大历史的读取性能尚未优化。

## 三大能力

自动恢复的核心有三件事，判断使用结构化字段：

1. **识别中断的会话**。扫描本机该 CLI 的会话记录，找出因额度上限而被停止的那一条。
   - Codex 认 `task_complete.error.codex_error_info`（`usage_limit_exceeded` / `rate_limit_exceeded`）。
   - Claude Code 认转录里的 `error: "rate_limit"`（尾部 `assistant` 记录的 `isApiErrorMessage: true` + `error` 枚举）。两条线互不猜对方。

2. **判断额度是否恢复**。
   - Codex：直接读结构化额度接口（`account/rateLimits/read`），不靠试错。
   - Claude Code：没有稳定的额度字段，只能用真实请求去探——`claude -p` 起一个最小探测，看响应是否再次落到 `rate_limit`。每次探测消耗一次 API，没有等价的不消耗方式。

3. **向那条会话投递一条”继续”消息，让它接着做原本的任务**。命中 (1) ∩ (2) 才发。
   - 投递完就走，落在同一个 sessionId 上，不 fork。Codex 侧以”`queue` 进程退出码 0”为完成，Claude Code 侧以”终端窗口已请求启动”为完成；都不重定义失败，也不等模型整轮。
   - Codex 侧消息留在 CLI 自己的队列里，用户保持目标打开即可；Claude Code 侧 tide 自己开一个终端窗口把这个会话跑起来，不需要目标开着。

当前范围：**Windows Git Bash 中的 Codex CLI / Codex 桌面端 / Claude Code CLI**。普通 `watch` / `resume` / `send` 的 Claude 窗口投递遇到占用就推迟，不接管别的进程；`tide claude` 包装入口只管理自己启动的前台进程。窗口投递另有未实测的 macOS 分支。

```bash
npm install
npm run build
node dist/tide.mjs doctor
node dist/tide.mjs status --cli codex
node dist/tide.mjs status --cli claude
node dist/tide.mjs resume <session-id> --cli codex --dry-run
node dist/tide.mjs resume <session-id> --cli claude --dry-run
node dist/tide.mjs resume <session-id> --cli codex --json
node dist/tide.mjs watch --cli codex --session-all
node dist/tide.mjs watch --cli claude --session <id>
```

## CLI 架构与配置

`src/main.ts` 解析参数，`src/commands.ts` 执行命令并负责 adapter 的生命周期；`src/watch.ts` 集中处理筛选、额度检查与监控循环；`src/codex.ts`、`src/claude.ts` 分别读取会话并投递消息。构建仅输出 `dist/tide.mjs`。

配置文件固定在 `<stateDir>/config.json`，`stateDir` 默认是 tide 安装目录下的 `.tide`，可通过 `TIDE_STATE_DIR` 环境变量覆盖。未指定的字段使用默认值。当前进程启动时读取配置，修改后需要重新启动监控。旧命令的配置参数会持久化；新增的 `tail` / `send` / `wait` 和启动包装不持久化本次参数。

`watch` 必须指定 `--session <id>` 或 `--session-all`，也可以在配置中设置 `sessionAllowList` / `sessionAll`。`sessionDenyList` 是按 session id 前缀排除的黑名单：命中的会话 watcher 既不 resume 也不显示，优先于 allow 列表。`tide status` 不过滤，把它们标成 `[excluded]`，方便确认规则命中得对不对。

Claude 的额度检查仍会发送真实探测请求。

```bash
npm run typecheck
npm run build
```

`npm test` 构建并运行会话控制测试（游标、终态、忙碌拒绝、参数处理及 CLI 只读行为），不发送真实模型请求。投递、前台窗口和真实限流恢复仍需实机验证。

## 投递：Codex 自己的队列

Codex CLI 的 `queue` 命令按 thread id 投递，**不区分**会话来自桌面端还是 CLI 本身——`session_meta.source` 不影响 `codex queue` 的行为。

```bash
codex queue --thread <session-id> --message <text>
```

- **投递成功**：进程退出码 0。tide 不接管 TUI、不等模型整轮。
- **持久化**：进程退出后，队列消息留在 Codex 自己手里；之后只读 `app-server` 的 `thread/queue/list` 仍能读到原文。

`resume --json` 的 `ok: true` 是 Codex CLI 接受了这则入队，**不是任务做完**。

## 投递：Claude Code 的 resume

Claude Code 没有 `queue` 子命令。tide 把要跑的命令写成一个脚本，再**开一个终端窗口**去跑它，然后立刻返回——不等窗口开起来，不等这一轮跑完，也不看它的输出。

脚本落在 `.tide/deliveries/<session-id>.sh`：

```bash
#!/bin/bash
cd '<session cwd>'
'<claude bin>' --resume <session-id> --dangerously-skip-permissions '<prompt>'
```

- **投递成功**：窗口已经请求启动（启动器给出 pid）。没有”窗口真的开了”或”CLI 已接受”这种回执可等。
- **窗口而不是无头进程**：窗口给了这个会话一个真 TTY，于是 `--resume` 起的是**常驻 TUI**——跑完这一轮不会退出，可以继续在里面说话。`--dangerously-skip-permissions` 是因为没人会去回答批准弹窗。
- **平台**：Windows 用 `cmd /c start` 开新控制台、由 Git Bash 跑脚本（Git Bash 取 `CLAUDE_CODE_GIT_BASH_PATH`，其次 `where.exe bash` 并跳过 `WindowsApps` 里的 WSL 桩；都找不到就报错不投递）。macOS 用 `open -a Terminal`——用 `open` 而不是 `osascript`，是为了不触发自动化授权弹窗。其他平台没有窗口启动器，直接失败。
- **投递窗口的环境**：带着发起 tide 的那个 Claude Code 会话的标记（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID`、`CLAUDE_CODE_MESSAGING_SOCKET` 等）的 TUI 会认定自己是嵌套子会话，报 "transcript saving is off" 而一个记录都不写。Windows 上把这些标记从继承来的环境里剥掉再交给窗口；macOS 上窗口由 Terminal 自己启动，环境取自 Terminal，本来就不带它们。
- **会话被占用时**：通过 Git Bash 运行 `claude agents --json`。匹配 sessionId 的交互进程（包括 idle）或后台条目都拒绝投递；列表读取失败也拒绝，不再调用 `process.kill` 接管。普通命令不会改变已有窗口。
- **接管方会补中断记录**：无论先杀还是被接管，接上来的那个进程都会在转录里补 `[Request interrupted by user for tool use]` 和一对 `Continue from where you left off.` / `No response requested.`，然后才写自己的回合。转录因此总是从"被打断"这个尾巴续上。
- **输出落点**：这一轮照样写进 `~/.claude/projects/` 的那条转录，用户下次 `claude --resume <id>` 就能看到。`.tide/deliveries/<session-id>.log` 只收启动器自己的输出，窗口里的内容不在里面——启动器正常不输出，所以这个文件一般是空的（追加写入，只留启动失败之类的痕迹）。
- **窗口会攒下来**：每个投递周期留一个窗口（跑完那一轮后 TUI 停在那里等输入），tide 不关它。
- **重复触发**：新输入会覆盖旧限流，已有持有者会阻止再次打开窗口。窗口启动与持有者登记并非原子操作；普通投递不保证并发幂等，不应并发投递或在结果不明时盲目重试。

`tide resume --cli claude` 的 `ok: true` 是窗口已经请求启动，**不是任务做完**。

## 验证投递这件事

`ok: true` 只到投递动作为止——Codex 是 CLI 确认入队，Claude Code 是终端窗口已请求启动，都不是任务做完。命令退出 ≠ TUI 已消费；要确认 TUI 真消费了，仍需一条真任务。

状态与日志在项目旁的 `.tide/`（投递脚本在 `.tide/deliveries/<session-id>.sh`，启动器的输出在 `.tide/deliveries/<session-id>.log`），不注册系统服务、不设置自启动。程序不直接修改 `~/.codex` 或 `~/.claude`；CLI 接受指令后自行维护历史和队列。

## 项目笔记

工作记录、交付报告、证据档都在 Obsidian 笔记库的 `D:/workspace/utils/obsidian-note/20_projects/cli-auto-resume-2026-09-19/` 下，不在仓库里。仓库只装代码、规则文档和构建产物；要回看背景、找历史证据、改动前的判据，去那里。

## 规则

**CLI 数据由 CLI 自己维护** — 不写 `~/.codex`、`~/.claude` 或它们的配置替代目录；所有落盘经过受检的写函数。自己的配置、状态和日志落在项目旁的 `.tide/`。

**判断依据结构化字段** — Codex 限流用 `task_complete.error.codex_error_info`；Claude Code 限流用转录里的 `error: "rate_limit"`；额度用结构化窗口与允许状态。不读错误文案猜测。新 `task_started`、`turn_aborted` 或提交的 `UserMessage` 覆盖旧限流。

**配置决策，不堆魔法值** — 超时、冷却、长度上限在声明式配置或具名常量。不写厂商模型名或端点判断，不靠文件名找会话，不解析面向人的输出做业务判断。

**投递即走，不等整轮** — Codex 的 `ok: true` 是 CLI 确认入队，Claude Code 的 `ok: true` 只是终端窗口已请求启动；两者都不是任务做完。tide 不持有投递出去的会话、不等模型整轮、不因整轮超时杀它。

**注释** — 只写代码本身不能表达的事实——外来依赖的怪癖、平台陷阱、跨文件不变量。不写"为什么这样做"或"为什么没那样做"——那是工作记录的事。

**`status` 描述 session 的运行时状态** — 6 个值,从结构化事件推断:`completed`(task 正常完成)、`running`(模型在响应用户 prompt)、`awaiting-input`(assistant 响应完了等用户下一条 prompt)、`aborted`(`turn_aborted` 外部中止)、`errored`(task_complete + 非 quota 错误)、`quota-limited`(task_complete + quota 错误)。`status` 跟 `parentThreadId`(subagent fork 标记)是**正交的两个轴**——一个 subagent 可以是 6 个 `status` 里的任何一个,subagent 标在 session metadata 上,不进 status 枚举。Codex 6 个都可达;Claude Code 没有 `task_started` / `turn_aborted` / 显式 task 完成事件的等价物,实际只产出 `completed` / `running` / `errored` / `quota-limited` 这 4 个,`aborted` 和 `awaiting-input` 对 claude 不可达。

**Adapter 描述,Watcher 决策** — `Adapter.findSessions()` 扫盘、推断每个 session 的 `status` / `lastAssistantAt` / metadata,按 `lastAssistantAt` 倒序截前 `MAX_INTERRUPTED_SESSIONS` 条。`lastAssistantAt` 是 assistant 最后一次响应(纯文本或工具调用)的时间——同一语义,codex 用 `item_completed + AssistantMessage | FunctionCall`,claude 用最后一条 `assistant` 记录。`Watcher` 只对 `status === "quota-limited"` 的 session 做后续决策。`aborted` 几乎总是用户自己停的——tide 自动 resume 会覆盖用户的明确决定;`errored` 下次大概率还会挂;`completed` / `running` / `awaiting-input` 都不是中断状态。`tide resume <id>` 是用户主动命令,**不**做 status 判断——按 sessionId 匹配,任何 status 都接受,用户自己决定给哪个 session 发 prompt。Watcher 先按 `sessionDenyList` 前缀剔除黑名单会话——这一步在 `MAX_SESSIONS_RETURNED` 截断**之前**,否则一批被排除的历史会话会占掉可见窗口、把真正在等的会话挤出去;剩下的再在 quota-limited 上叠 3 层:`!parentThreadId`(skipSubagents) → `lastAssistantAt <= now - idleMinutesBeforeResume` → `--session` allow list。`status` 命令展示 adapter 的原始列表,不替 watcher 做决策;`--limit <n>` 在 status 命令层把列表再截前 n 条,默认 `MAX_INTERRUPTED_SESSIONS`。

**JSON schema 在 1.0 之前不稳定** — 字段可能改名、合并、删除,无 compat 层,无 deprecation warning。当前是 0.1.0,`policy.filter` 在 refactor 里已改为 `policy.watchPolicy`,未来还会有同类变化。外部消费者应当在 1.0 之前把 JSON 当成 unstable 来对待。

macOS 不在本轮支持范围。

```bash
npm run typecheck
```
