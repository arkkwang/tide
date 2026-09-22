# Tide

启动原生 Claude Code / Codex，监控会话，并在额度恢复后续跑原任务。

## 日常操作

主流程是：启动原生 CLI 做任务，Tide 自动监控；需要了解情况时查看状态与快照；需要取消自动恢复时取消监控。

| 用户要做什么 | 命令 | 结果 |
| --- | --- | --- |
| 开始任务 | `tide claude ...` / `tide codex ...` | 在当前终端交互，绑定会话后自动监控 |
| 找会话、查看监控情况 | `tide status --cli claude` | 会话列表、最后历史事件、监控状态，不调用模型 |
| 看最近执行内容 | `tide snapshot <id> --cli claude` | 最近用户/助手文本及历史事件，不是实时执行保证 |
| 纳入已有会话 | `tide watch --session <id> --cli claude` | 登记持续监控与限流后自动恢复，完成登记后返回 |
| 取消自动恢复 | `tide unwatch <完整id> --cli claude` | 取消监控，CLI 继续运行 |
| 手动续跑 | `tide resume <id> --cli claude` | 使用配置中的续跑提示；Claude 请求恢复窗口，Codex 排队 |

例如，先运行 `tide claude`；另一个终端执行 `tide status --cli claude` 找到完整 ID，再用 `snapshot` 查看文本。结束后如果不希望 Tide 再自动恢复这个会话，执行 `unwatch`；关闭原生终端本身不会取消监控。需要立即停止当前执行时，使用原生 CLI 自己的交互；目前没有可跨 CLI 保证成功的 Tide 回合打断命令。

`watch` 的产品语义包含自动恢复；单纯查看用 `status/snapshot`。`resume` 是一次明确续跑，不负责登记监控，也不是进入原生会话的通用命令。要在当前终端进入 Claude 旧会话，使用 `tide claude --resume <id>`；Codex 使用 `tide codex resume <完整UUID>`。

`send/tail/wait` 用于脚本协作：`send` 补充任务，`tail` 增量读取并返回游标，`wait` 从游标等待结束事件。日常查看优先用 `snapshot`。Claude 当前不支持 `send`，两个提供方当前都不支持 `--mode interrupt`；不支持会明确失败。

交互约定：

- 默认输出面向人；自动化使用命令支持的 `--json`。`status/snapshot/tail/send/wait/resume/quota/unwatch` 支持 JSON，`watch/doctor/deny-current` 不支持。
- 参数只作用于所属命令，不适用的参数、多余的位置参数、`--session` 与 `--session-all` 同用均报错。原生启动后的参数全部交给原 CLI。
- `--cli` 对单会话查看、脚本操作和取消监控必填；`status/quota/watch/resume/deny-current` 省略时使用已启用的 CLI，可能覆盖两种 CLI。日常操作建议明确指定。
- `--dry-run` 仅支持 `send/resume/quota/watch`；`watch` 的 dry run 是前台模拟，Ctrl-C 退出。`status/snapshot/tail` 本来就只读，无需 dry run。
- `doctor` 只检查配置与二进制；`quota` 才探测额度，Claude 会发送真实请求。`deny-current` 是批量持久化排除操作，解除需修改配置中的 `sessionDenyList`，不属于日常停止入口。
- 脚本退出码：0 表示该命令成功（排队或请求窗口不表示任务完成）；1 表示操作失败、能力不支持或观察到错误/中止；2 表示参数、读取或配置等错误；`wait` 超时为 3，结果未知，不自动重发。

本轮收紧了参数校验：以前被忽略的参数现在会报错。`quota/unwatch` 默认输出也改为文本，依赖原 JSON 输出的脚本须添加 `--json`。

## 安装与启动

```bash
npm install
npm run build
tide claude
tide claude --model <model> --permission-mode plan "检查项目"
tide codex
tide codex resume <完整会话 UUID>
```

未安装本地命令时使用 `node /绝对路径/tide/dist/tide.mjs`。Windows 包装入口通过 Git Bash 启动；macOS 在当前终端直接启动前台托管进程。CLI 保持当前终端前台交互，后续参数交给原 CLI。帮助、版本及已识别的非交互子命令仅透传，不创建监控。

Windows 的 Git Bash 可通过 `CLAUDE_CODE_GIT_BASH_PATH` 指定，例如 `D:/workspace/utils/Git/bin/bash.exe`。目标平台为 Windows 与 macOS；当前实机验证环境仅有 Windows Git Bash。macOS 前台启动不需要 Git Bash，恢复窗口使用 Terminal 和 `.command` 脚本，尚需 macOS 实机验收。平台差异集中在终端入口，不使用系统进程扫描或窗口操作作为会话通信通道。

包装入口绑定到确定的会话后，会启动独立监控进程。前台存在时由包装入口处理恢复，后台进程待命；前台进程退出后后台接续。因此关闭原终端不会取消已登记的监控。只有有效限流记录才会触发恢复，普通退出或正常回合完成不会自动重新拉起 CLI。

Claude 按启动进程 PID 从原生 `agents --json` 绑定会话；在绑定成功前不宣称已经完成监控登记。Codex 新会话仍使用原有 App Server 创建、写入启动说明、交给原生 TUI resume 的流程，不调用模型。Codex 包装目前要求显式 UUID 恢复，不支持选择器、`--last` 或远程会话；更换会话需退出后重新包装启动。

## 监控已有会话

```bash
tide watch --cli claude --session <id>
tide watch --cli codex --session-all
tide unwatch <完整会话 ID> --cli claude
tide unwatch --session-all --cli codex
```

普通 `watch` 完成后台监控登记后返回。`--session-all` 使用一个后台 watcher 持续扫描，不为每条历史记录创建进程。单会话监控支持无歧义 ID 前缀；`unwatch` 要求完整 ID。

`unwatch` 取消自动监控，不终止 CLI 或当前回合。单会话取消也阻止全会话 watcher 自动恢复该会话；`--session-all` 取消该 CLI 的全会话及已登记的单会话监控。后续明确重新登记会话会重新启用它。

`watch --dry-run` 或 `--skip-quota-check` 是前台调试模式，Ctrl-C 停止；dry run 不投递、不探测额度。包装启动不继承调试开关的模拟行为，仍按真实恢复运行并提示。

自动恢复共用一份策略：筛选限流记录、等待、检查额度、重新核对原记录、投递。不同 watcher 使用按会话的锁与持久回执，避免对同一中断重复投递。确认丢失或进程在投递中崩溃时，结果保持未知，不自动重发。已知未投递的拒绝（例如 Claude 被占用）可以在后续检查重试。

## 查看状态与执行快照

```bash
tide status --cli codex --limit 10 --json
tide snapshot <id> --cli claude --limit 10 --json
tide quota --cli claude
```

`status` 只读，不查询额度、不调用模型、不保存本次参数。显示会话最后记录、排除规则和监控进程状态：`standby` 是等待前台进程退出，`watching` 是后台监控，`stopped` 表示已停止或缺少新鲜存活证据。

会话 JSON 的 `lastEvent` 替代原先含糊的 `status`。它描述最后的历史记录：`unknown`、`running`、`completed`、`aborted`、`errored` 或 `quota-limited`，不是进程存活证明。当前接入不能可靠提供全局实时状态，所以 `currentState` 明确为 `unknown`。`completed` 只表示回合结束，不代表任务通过验收。

`snapshot` 提供同一事件解释下的最近用户/助手文本、观测时间和截断标记，不包含模型思考或工具原始输出。状态扫描和等待使用相同的事件解码规则；Claude 助手文本本身不再被当作回合完成。

`quota` 才会显式查询/探测额度。Claude 的探测发送真实模型请求，会消耗额度；成功只代表该次探测可用，不保证任意模型或会话均可恢复。

## 手动投递与可选协作入口

```bash
tide resume <id> --cli codex --json
tide send <id> --cli codex --message-file ./task.txt --json
tide send <id> --cli codex --message "补充要求" --dry-run --json
tide tail <id> --cli claude --limit 5 --json
tide wait <id> --cli claude --after <cursor> --timeout 60 --json
```

`resume` 使用配置中的续跑提示；`send` 必须且只能提供 `--message` 或 UTF-8 `--message-file`。手动投递不查询额度。Codex `send` 是入队，不等于模型已经处理或完成。`--mode queue` 为默认行为；`--mode interrupt` 明确请求立即纠正，当前接入返回不支持，绝不退化成排队。

Claude `send` 现在明确返回不支持，不再暗中启动窗口。关闭后的恢复仍可明确调用 `resume`，请求打开可见终端（Windows Git Bash / macOS Terminal）并携带启动输入；结果分别报告 `launchRequested: true`、`delivered: false`，不把请求启动当成消息送达。这是对原有混合行为的语义调整。

Claude 恢复仍拒绝启动被交互/后台进程占用的会话，不接管其他进程。包装入口仅在核对限流记录和唯一持有者后重启自己启动的 Claude。重启与关闭后恢复复用已保存的启动选项，不重复首次任务文本。普通恢复不再自动追加跳过权限参数；没有保存过的选项不能声称完整还原。

`tail/wait` 暂保留已有游标接口。`wait` 从 `send/tail` 返回的基线观察，超时不会杀进程或重发。退出码为 0 回合正常结束、1 回合错误/中止、2 参数或读取失败、3 超时。消息文本 hash 关联不能唯一识别重复同文输入，不能视为精确的任务 ID。

目前没有可靠的通用“立即打断当前执行”接口。排队补充、关闭后恢复和执行打断不混称为同一种能力。

## 文件组织

```text
src/
  core/session.ts          提供方接口及会话、观测、发送、启动结果契约
  core/sessions.ts         会话选择、只读监控、状态、快照、发送与启动入口
  core/process.ts          原生进程启动、退出等待、停止自有进程
  providers/               Claude/Codex 接入、事件解码、原生终端启动
    claude/adapter.ts      Claude CLI 查询、额度探测及显式窗口恢复
    claude/history.ts      Claude 历史目录扫描与文件尾部摘要（只读）
    transcript.ts          两种 CLI 共用的历史读取入口、事件解码与快照
    terminal.ts            平台终端入口、shell 引用及恢复参数
  features/                恢复、前台托管、后台监控生命周期、tail/wait
  cli/                     参数、命令路由与输出
  config.ts                配置读取及本次覆盖
  util.ts                  共用进程和格式处理
```

核心已有实际行为，不再只有类型定义。`Sessions.monitor()` 只发布观测，取消后停止发布，不查询额度、不发消息、不恢复。外围 watcher 消费它，再运行恢复策略。状态、快照、发送和历史读取统一经过 `Sessions`；`tail/wait` 在外围消费历史观测，游标解码仍由提供方负责。核心不依赖 CLI 命令或恢复策略。

`Execution.launch()` 创建原生进程并返回持有句柄；`stop()` 只停止该句柄创建的进程，不接受历史文件中的任意 PID。停止等待有上限，POSIX 进程忽略 SIGTERM 时会升级为 SIGKILL；不保证终止该进程另行创建的后代。它是进程停止，不是回合打断，也不等于 `unwatch`。前台托管组合这些能力，保留原生交互和自动监控；Claude/Codex 的协议、进程识别和启动参数仍由提供方处理。

恢复属于外围组合。当前 Claude 只能在启动时携带输入，尚不具备独立实时发送，因此不能宣称已实现通用的“启动完成后发送”链路。核心会暴露这个能力缺口，不以恢复窗口模拟发送成功。

## 状态与配置

`TIDE_STATE_DIR` 指定 Tide 自己的状态目录；默认是安装目录旁的 `.tide/`。配置固定为 `config.json`，每个进程启动时读取。命令行选项只覆盖本次调用，不再自动写回配置；显式传 `--session` 会覆盖配置中原有的 `sessionAll`。`deny-current` 是明确修改黑名单的命令，仍持久化。

常用配置仍为 `codex/claude.enabled`、`codex/claude.bin`、`watchPolicy.sweepIntervalMinutes`、`watchPolicy.idleMinutesBeforeResume`、`sessionAllowList`、`sessionAll`、`sessionDenyList`、`resume.prompt`。修改配置后需取消并重新登记已有后台监控。

`monitors/` 保存 Tide 自己的监控登记、心跳、停止标记和包装启动选项，`recovery/` 保存恢复锁与投递结果，`launches/`、`deliveries/` 保存启动日志/脚本。没有系统服务、开机自启或远程调度平台。

发生硬崩溃后可能留下锁。日志会报告相应路径；应先确认旧进程已退出并核对投递结果，再移除对应锁。不要在投递未知时清空恢复记录重试。

## 接入与验证边界

本次重构保留了原先已验证的 CLI 路径，没有因 daemon/proxy 测试失败而禁用 Codex。Git Bash 中，原有 `app-server` 调用可用；独立 App Server 连接的 `notLoaded` 不能直接推断其他窗口中的会话已经离线。

接入收敛尚未完成：Codex 当前仍有 App Server、CLI queue 和历史文件读取；Claude 仍使用原有历史观测与原生恢复。没有增加私有 socket、终端输入注入或新的兜底通道。Claude Plugin/Channels 实验保持暂停；未宣称活跃发送、立即打断或单一路径验证成功。

扫描仍限于最近七天范围，已知历史读取和游标成本尚未消除。

2026-09-22 的独立 Codex App Server 验证通过了：两个 WebSocket 客户端共享实时状态、原生 TUI 恢复同一会话、真实回复及结构化快照、运行时排队、跨连接打断确认、关闭原生终端后继续控制、监控连接重连。尚未替换正式提供方；让 TUI 创建新会话并完整保留参数的验证遇到新目录信任提示，未通过验收。用户确认后续优先处理 Claude。

复现脚本为 `scripts/probe-codex-app-server.mjs`，仅依赖 Node 和本机 Codex，通过 `CODEX_BIN` 可指定二进制。`node --experimental-websocket scripts/probe-codex-app-server.mjs` 只验证协议，不发模型任务；`--turns` 会发真实请求；`--native` 必须从真实交互终端运行，会在当前终端显示原生 TUI。脚本不调用 PowerShell 或 Windows 进程/网络查询 API。原生界面的跨平台重现仍需实机验证；它不会自动接受信任或权限提示。

Claude 接入调查仍未通过单一路径验收。[官方 agent view](https://code.claude.com/docs/en/agent-view) 提供状态查询与后台会话管理，但不等价于完整外部控制 API；[Agent SDK](https://code.claude.com/docs/en/agent-sdk) 是程序化代理入口，不能直接当作现有原生终端的控制接口。[当前 Channels 文档](https://code.claude.com/docs/en/channels) 已允许 Anthropic Console API key，先前本机不可用的具体原因仍未确定，不能笼统归因于 API key 或 MiniMax。没有重新启用 Plugin 实验，也没有添加跨会话 socket 等补充通信路径。

### Claude 维护边界

当前实现是保留的混合接入，不是已完成的单一官方协议接入。代码按职责隔离，不能把目录整理视为能力补齐。

| 机制 | 负责什么 | 不能据此推断什么 |
| --- | --- | --- |
| 原生 CLI + `agents --json` | 启动、按 PID 绑定、核对会话持有者 | 一次查询不能消除查询后其他进程启动的竞态，也不是实时消息接口 |
| `history.ts` + `transcript.ts` | 只读历史扫描、事件解释、文本快照与游标 | 文件格式不是稳定控制协议；历史完成不表示进程退出，助手文本不表示回合结束 |
| `readQuota()` 的 `claude -p` | 真实请求探测当次可用性 | 会消耗额度；不能代表原会话所用模型一定可用 |
| `launchSession()` + `terminal.ts` | 为关闭后的会话请求可见恢复窗口 | 启动请求不是投递确认；不能替代运行中的 `send` 或回合打断 |

修改时遵守以下边界：

- Claude 没有实现 `Adapter.send`；不支持由核心明确返回。不要通过恢复窗口、JSONL 写入、输入注入或另加 socket 将其伪装成支持。
- 历史事件语义统一在 `transcript.ts` 的 `parseEvent` 中维护；`history.ts` 复用它。增加事件格式时同步验证状态和快照，避免两套解释。
- 进程持有者未知或查询失败时拒绝恢复。前台仅停止自己启动且核对为唯一空闲持有者的进程；不能按历史 PID 接管其他会话。
- Windows 的 Claude 命令通过 Git Bash 执行；不要用 PowerShell 中的认证结果判断 Claude 不可用。macOS 新窗口由 Terminal 打开，其环境不保证继承调用进程，认证与自定义 API 环境仍需实机验证。
- Plugin/Channels 实验保留在独立的 `../claude-plugin-probe` 中，没有接入产品。Hooks 成功、MCP 启动成功均不代表 Channel 投递成功；当前实验明确收到 Channels 不可用。

未来替换接入时，先在独立验证中确认原生终端、参数透传、会话绑定、状态/快照、排队发送、打断确认及断连后的行为，再整体替换 Claude 提供方。核心和恢复策略只消费提供方契约；不要继续在现有实现上拼补充通道。Windows/macOS 都必须单独验收，未知结果保持未知。

```bash
npm run typecheck
npm test
```

测试包含发送与启动隔离、打断不退化成入队、自有进程停止、只读监控取消、状态/快照一致性、参数只读、监控接续与重新登记、并发恢复、未知回执及原有会话控制行为，不发送真实模型请求。已配置 Windows/macOS GitHub Actions 测试矩阵，尚未在远端运行。Windows 本机 34 项测试中 33 项通过，忽略 SIGTERM 的 POSIX 专用测试跳过。macOS 原生终端交互、真实额度耗尽后的恢复和正式提供方的完整 Codex 模型回合仍需实机验证。

## 项目记录

参考快照：`codex/reference-before-core-redesign-20260922`（`21ba049`）。重构在独立工作分支进行，参考分支保持不动。

架构审查与交付记录放在 `D:/workspace/utils/obsidian-note/20_projects/cli-auto-resume-2026-09-19/`。CLI 自己的数据由 CLI 维护，Tide 不直接写其历史、队列或配置。
