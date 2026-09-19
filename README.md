# tide

在 CLI 额度恢复后，把”继续”发回原会话。

## 三大能力

tide 只做三件事，三件都需要凭结构化字段，而不是错误文案或文件名：

1. **识别中断的会话**。扫描本机该 CLI 的会话记录，找出因额度上限而被停止的那一条。
   - Codex 认 `task_complete.error.codex_error_info`（`usage_limit_exceeded` / `rate_limit_exceeded`）。
   - Claude Code 认转录里的 `error: "rate_limit"`（尾部 `assistant` 记录的 `isApiErrorMessage: true` + `error` 枚举）。两条线互不猜对方。

2. **判断额度是否恢复**。
   - Codex：直接读结构化额度接口（`account/rateLimits/read`），不靠试错。
   - Claude Code：没有稳定的额度字段，只能用真实请求去探——`claude -p` 起一个最小探测，看响应是否再次落到 `rate_limit`。每次探测消耗一次 API，没有等价的不消耗方式。

3. **向那条会话投递一条”继续”消息，让它接着做原本的任务**。命中 (1) ∩ (2) 才发。
   - 我们只把”投递**收到确认**”视为完成；不重定义它失败，也不等模型整轮。
   - CLI / 桌面进程不在 tide 的管辖范围：用户必须保持目标打开。如果 CLI 此刻是关闭的，这条消息会留到下次启动再被消费——那是 CLI 自己的事。

当前收尾范围：**Windows Git Bash 中的 Codex CLI / Codex 桌面端 / Claude Code CLI**。用户保持目标 CLI 或桌面任务打开。tide 负责检查和投递，不持有会话进程，不等待任务完成，也不因整轮超时杀掉 CLI。

```bash
npm install
npm run build
node dist/tide.mjs doctor
node dist/tide.mjs status --cli codex
node dist/tide.mjs status --cli claude
node dist/tide.mjs resume <session-id> --cli codex --dry-run
node dist/tide.mjs resume <session-id> --cli claude --dry-run
node dist/tide.mjs resume <session-id> --cli codex --json
node dist/tide.mjs watch --cli codex
node dist/tide.mjs watch --cli claude --session <id>
```

## 投递：Codex 自己的队列

Codex CLI 的 `queue` 命令按 thread id 投递，**不区分**会话来自桌面端还是 CLI 本身——`session_meta.source` 不影响 `codex queue` 的行为。

```bash
codex queue --thread <session-id> --message <text>
```

- **投递成功**：进程退出码 0。tide 不接管 TUI、不等模型整轮。
- **持久化**：进程退出后，队列消息留在 Codex 自己手里；之后只读 `app-server` 的 `thread/queue/list` 仍能读到原文。

`resume --json` 的 `ok: true` 是 Codex CLI 接受了这则入队，**不是任务做完**。

## 投递：Claude Code 的后台 resume

Claude Code 没有 `queue` 子命令。tide 用 `claude --bg --resume <id> "<prompt>"` —— 这是 Claude Code 的投递等价物：起一个后台会话（必要时分叉成新会话），把 prompt 塞进去，立刻返回 `backgrounded · <id>`，不阻塞当前进程。

```bash
claude --bg --resume <session-id> "<prompt>"
```

- **投递成功**：进程退出码 0，且 stdout 包含 `backgrounded`。tide 不接管 TUI、不等模型整轮。
- **会话被占用时**：原 TUI 仍开着，Claude Code 会分叉一个新会话，stdout 会带一行 `note: started a copy as <id>`。这是 Claude Code 的正常行为；tide 不挑会话 id。
- **消息落点**：消息在那个后台会话里继续；用户用 `claude attach <id>` 或 `claude logs <id>` 看后续。
- **每个 session 只投一次**：Claude Code 每次 `--bg --resume` 都可能 fork 新会话。tide 在 `<stateDir>/claude-resumed.json` 里记录已经投过的 session id，之后**不再把该 session 报为中断**——watcher 不会再看它，`tide status` 里也不出现，防止一个卡住的 session 在多次 sweep 里堆出 N 个 fork。要重新尝试，手动把那个 id 从文件里删掉（没有命令行开关）。

`tide resume --cli claude` 的 `ok: true` 是 Claude Code CLI 接受了这则入队，**不是任务做完**。

## 验证投递这件事

`ok: true` 仅代表对应 CLI 接受了这则入队——不是任务做完。命令退出 ≠ TUI 已消费；要确认 TUI 真消费了，仍需一条真任务。

状态与日志在项目旁的 `.tide/`，不注册系统服务、不设置自启动。程序不直接修改 `~/.codex` 或 `~/.claude`；CLI 接受指令后自行维护历史和队列。

## 项目笔记

工作记录、交付报告、证据档都在 Obsidian 笔记库的 `D:/workspace/utils/obsidian-note/20_projects/cli-auto-resume-2026-09-19/` 下，不在仓库里。仓库只装代码、规则文档和构建产物；要回看背景、找历史证据、改动前的判据，去那里。

## 规则

**CLI 数据由 CLI 自己维护** — 不写 `~/.codex`、`~/.claude` 或它们的配置替代目录；所有落盘经过受检的写函数。自己的配置、状态和日志落在项目旁的 `.tide/`。

**判断依据结构化字段** — Codex 限流用 `task_complete.error.codex_error_info`；Claude Code 限流用转录里的 `error: "rate_limit"`；额度用结构化窗口与允许状态。不读错误文案猜测。新 `task_started`、`turn_aborted` 或提交的 `UserMessage` 覆盖旧限流。

**配置决策，不堆魔法值** — 超时、冷却、长度上限在声明式配置或具名常量。不写厂商模型名或端点判断，不靠文件名找会话，不解析面向人的输出做业务判断。

**投递收到确认即停** — `ok: true` 是投递被确认接收，不是任务做完。tide 不持有 CLI 进程、不等模型整轮。

**注释** — 只写代码本身不能表达的事实——外来依赖的怪癖、平台陷阱、跨文件不变量。不写"为什么这样做"或"为什么没那样做"——那是工作记录的事。

**`status` 描述 session 的运行时状态** — 6 个值,从结构化事件推断:`completed`(task 正常完成)、`running`(模型在响应用户 prompt)、`awaiting-input`(assistant 响应完了等用户下一条 prompt)、`aborted`(`turn_aborted` 外部中止)、`errored`(task_complete + 非 quota 错误)、`quota-limited`(task_complete + quota 错误)。`status` 跟 `parentThreadId`(subagent fork 标记)是**正交的两个轴**——一个 subagent 可以是 6 个 `status` 里的任何一个,subagent 标在 session metadata 上,不进 status 枚举。Codex 6 个都可达;Claude Code 没有 `task_started` / `turn_aborted` / 显式 task 完成事件的等价物,实际只产出 `completed` / `running` / `errored` / `quota-limited` 这 4 个,`aborted` 和 `awaiting-input` 对 claude 不可达。

**Adapter 描述,Watcher 决策** — `Adapter.findSessions()` 扫盘、推断每个 session 的 `status` / `lastAssistantAt` / metadata,按 `lastAssistantAt` 倒序截前 `MAX_INTERRUPTED_SESSIONS` 条。`lastAssistantAt` 是 assistant 最后一次响应(纯文本或工具调用)的时间——同一语义,codex 用 `item_completed + AssistantMessage | FunctionCall`,claude 用最后一条 `assistant` 记录。`Watcher` 只对 `status === "quota-limited"` 的 session 做后续决策。`aborted` 几乎总是用户自己停的——tide 自动 resume 会覆盖用户的明确决定;`errored` 下次大概率还会挂;`completed` / `running` / `awaiting-input` 都不是中断状态。`tide resume <id>` 是用户主动命令,**不**做 status 判断——按 sessionId 匹配,任何 status 都接受,用户自己决定给哪个 session 发 prompt。Watcher 在 quota-limited 上叠 3 层:`!parentThreadId`(skipSubagents) → `lastAssistantAt <= now - idleMinutesBeforeResume` → `--session` allow list。`status` 命令展示 adapter 的原始列表,不替 watcher 做决策;`--limit <n>` 在 status 命令层把列表再截前 n 条,默认 `MAX_INTERRUPTED_SESSIONS`。

**JSON schema 在 1.0 之前不稳定** — 字段可能改名、合并、删除,无 compat 层,无 deprecation warning。当前是 0.1.0,`policy.filter` 在 refactor 里已改为 `policy.watchPolicy`,未来还会有同类变化。外部消费者应当在 1.0 之前把 JSON 当成 unstable 来对待。

macOS 不在本轮支持范围。

```bash
npm run typecheck
```
