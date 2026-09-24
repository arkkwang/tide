# 中断恢复插件

这两个插件随 Tide 打包，但只有配置后才运行。它们属于 Tide 插件，不是安装进 Codex 或 Claude Code 的扩展。不扫描 CLI 历史，不读取 JSONL，不关闭或重开 CLI。

## 启用和操作

在 `TIDE_STATE_DIR/plugins.json`（默认安装目录旁 `.tide/plugins.json`）配置：

```json
{"plugins":["cxr","ccr"]}
```

也可以用 `tide plugin enable cxr` / `tide plugin enable ccr` 写入同一个文件（`tide plugin disable <名称>` 相反）。配置后用 `tide run` 或 `tide launch` 启动新会话，然后在该 shell 中启动对应 CLI。原有本地模块路径仍然可用。每个会话各自管理插件状态，退出 Tide 会话会停止定时器并取消探测子进程。

```bash
tide plugin list
tide plugin status <id>
tide ccr --help
tide ccr status --all      # 所有匹配会话的状态
tide ccr status <id>
tide ccr watch <id>
tide ccr unwatch <id>
```

两个插件默认**不监听**会话：在 `plugins.json` 中列出只表示启用插件进程，不会自动启动配额/连接中断的探测与恢复。准备好目标 CLI 后显式调用 `tide <插件 ID> watch <id>` 才会开始观察和计时；`unwatch` 停止本会话的自动恢复并取消正在运行的探测，进程仍驻留。`status` 始终可读，返回 `monitor.enabled` 区分是否正在监听。`watch` / `unwatch` 针对一个会话：第一个参数是会话 ID，CLI 据此路由到该会话的宿主执行，缺少会话 ID 时报错。`status` 跑一次 observe + decide + 读内存，无网络副作用，不创建或重置任何 episode、不取消在飞探测，返回 `observation`（当前屏识别）、`decision`（下一次 tick 会干啥）、`monitor`（持久状态含 `enabled`、`phase`、当前追踪的 `interruption`、各时间戳、上次探测结果/错误/恢复时间，时间均为 Unix 毫秒）。它是只读的，因此支持 `tide ccr status --all`：CLI 向每个匹配该插件的会话各问一次，返回 `[{id, result}]`，每个会话的状态仍由该会话的宿主给出，不存在跨会话汇总状态。命令只在匹配的 CLI 画面中可用。

## 判定与恢复

插件识别当前输入提示符和 CLI 底部状态区域，结合光标位置确认空输入框。从输入框上方向上检查最近的响应，识别 `You've hit your limit`、`Usage limit reached`、`API Error: 429` 等明确提示。遇到较新的普通响应就停止，不穿过它去匹配旧限额。不是搜索整个屏幕，也不假定错误永远在倒数第五行。

同一检测器还识别明确的连接失败，例如 `API Error: Connection error.`、`API Error: Request timed out.`、`stream disconnected before completion` 和最终重试耗尽的临时服务错误。401/403 等鉴权错误不作为可自动恢复的网络问题。`Retrying`、`Reconnecting` 或倒计时等仍在重试的画面不是最终中断。

两类中断共用 `ResumeMonitor` 的计时、取消、发送前复核和防重复机制；检测器只返回中断类型与文案，CLI 策略负责决定是否可以尝试继续。

发现中断后：

1. 从确认最终错误、空输入框就绪时开始，要求当前画面连续稳定 **3 分钟**（`cooldown`）。不是从第一次 API 报错计时。画面内容、尺寸或缓冲区变化会重新计时；相同内容的重复绘制不影响。出现自身重试、用户输入、正常回复或退出 CLI 则撤销本次中断。
2. 限额：Codex 在缓冲结束后查询额度；Claude 默认在发现中断满 5 分钟且满足稳定时间后探测。连接中断：Claude 通过 `claude -p`、Codex 通过 `codex exec --ephemeral` 做独立 ping/pong，成功后才操作原窗口。探测失败或未知均每 5 分钟再查。
3. 允许尝试后重新抓屏，确认同一中断仍为最新响应、画面未变化且输入为空。复用 Tide 的 `send` 发送对应的 `继续完成刚才因限额中断的任务。` 或 `继续完成刚才因连接中断的任务。`，确认输入框显示原文后，通过 `sendKey("Enter")` 提交。

ping/pong 确认一次模型请求成功，不保证之后不会再次断线。若 CLI 再次自动重试并最终产生新的连接错误，会重新经历完整缓冲；同一个未变化的错误不会连续投递。限额与网络均不抢在 CLI 自身重试之前接管。CLI 重试和流超时可配置，因此不能把“错误出现一两分钟”当作完成重试的证据；参见 [Codex 重试配置](https://developers.openai.com/codex/config-reference)。

普通空闲或正常完成的窗口不会发起探测或接收继续文本。用户输入、新回复、退出 CLI 会撤销旧中断。同一中断在发送前就标记为已尝试；部分发送或无法确认的结果不会自动重试，状态为 `delivery-unknown`，需要查看屏幕处理。插件不清空用户输入，不代按权限确认。

终端仍由用户和 Agent 共享；复核不等于原子锁。检查后瞬间发生的并发输入仍可能竞争。自定义主题/底栏、非标准错误文案、折行造成无法确认的输入、非空占位提示等未知布局会跳过恢复。当前屏幕规则是启发式判定，不能把任意程序输出当作可靠的 CLI 状态协议。

## 探测方式与环境

Codex 网络探测使用官方 `codex exec --ephemeral --sandbox read-only --output-last-message <临时文件>`。禁用 hooks 和 shell 工具，关闭审批请求，提示只回复 pong。只读取最终回复文件，并同时要求退出码为 0、回复严格为 pong；不把日志里的 pong 当作成功，也不读取历史 JSONL。临时回复文件用后删除。超时为 30 秒，探测消耗少量模型 token，不恢复或改写原 TUI 会话。`doctor`、`/healthz` 仅能诊断本地环境/服务，不能替代这次模型请求。参考 [Codex CLI 参数](https://developers.openai.com/codex/cli/reference)。

Codex 启动短生命周期 `codex app-server`，完成 initialize/initialized 后调用 `account/rateLimits/read`，不启动模型回合。只有服务端明确返回 `ordinaryUsageAllowed: true` 才确认恢复；`false` 表示仍阻塞，缺失/null 表示未知。本机生成的协议明确禁止在该许可缺失时，仅靠额度百分比或重置时间推断恢复。没有可用账号认证、API key/第三方代理不支持该接口时保持未知，不发送继续、不更改登录态。

Claude 使用 `claude -p "Respond with the single word: pong" --no-session-persistence --output-format json`，禁用内置工具、MCP 工具及 hooks。保留正常鉴权环境，不使用会禁用 OAuth 的 `--bare`。只接受退出码 0、成功结果、`is_error: false` 且文本为 pong 的 JSON；429 为仍限流，网络失败、未登录、无效 JSON 或其他响应均为未知。每次探测会产生少量模型 token；超时为 30 秒，不做探测内部自动重试。

探测继承启动 Tide 宿主时的环境，工作目录为 Tide 会话初始目录。要使用相同账户、模型及项目配置，请在启动 Tide 前设置；shell 启动后临时 export、cd 或在 TUI 中切换模型/账户不会同步给宿主。

- `TIDE_CODEX_BIN` / `TIDE_CLAUDE_BIN`：可选的可执行文件路径，默认从 PATH 找 codex / claude。
- `TIDE_CODEX_MODEL`：可选 Codex 网络探测模型，应与待恢复窗口一致，默认使用 Codex 配置。
- `TIDE_CLAUDE_MODEL`：可选探测模型，应与待恢复窗口匹配；未指定时使用 Claude 默认配置。不同模型可能拥有不同额度，不能把另一模型的 pong 当作所有模型均可用的保证。
- `TIDE_RESUME_DELAY_SECONDS`：两类中断的最短连续稳定时间，默认 180 秒，允许 1..3600 秒。启动 Tide 前设置；调低可能增加与 CLI 自身重试发生竞争的概率。任何一次恢复尝试都受该值约束。
- `TIDE_INITIAL_DELAY_SECONDS`：发现中断后第一次探测的最短等待，默认 300 秒，允许 1..3600 秒；仅在 Claude 上生效（Codex 限额探测依赖缓冲结束）。

参考：[Codex App Server](https://developers.openai.com/codex/app-server)、[Claude CLI 参数](https://code.claude.com/docs/en/cli-reference)。

## 验证范围

自动测试覆盖新旧错误共存、正常完成、已有输入、两类中断的三分钟缓冲边界、强制 tick 不绕过缓冲、CLI 自身重试、探测期间变化、五分钟调度、失败不重发、停用及会话隔离。真实 PTY/Tide 集成测试将可配置缓冲缩短到 1 秒，用模拟 CLI 实现 App Server 握手和 Claude JSON 响应，验证两种中断到输入和 Enter 的完整链路，不消耗模型额度。

Windows 本机另验证了真实 Codex App Server 返回明确可用、真实 Codex exec 临时探测返回 pong，以及在用户 Git Bash 环境下真实 Claude 返回 pong。没有人为耗尽真实账号额度，实际限额到数小时后重置的长周期过程尚未实测；macOS 本轮未实机验证。
