# Tide

把用户可见的交互式 shell 提供给人和 Agent 共同使用：启动会话、输入文本、发送按键、读取屏幕。Claude Code / Codex 是 shell 中的普通程序，Tide 用自己的 Session ID 定位窗口。

## 快速开始

```bash
npm install
npm run build

# Git Bash：在项目根目录定义当前窗口的快捷函数
tide() { bash /d/workspace/program/personal/tide/bin/tide "$@"; }

tide run                    # 在当前终端启动托管 shell
# 或 tide launch            # 新开可见系统终端窗口（Windows / macOS）
```

需要全局 `tide` 命令时，在项目目录执行 `npm run link:local`，会先构建再刷新 npm 全局入口。普通代码修改执行 `npm run build` 即可；`package.json` 的 `bin` 改动后必须重新 link，build 不会重建 npm 已生成的启动脚本。尤其从旧的 `dist/tide.mjs` 入口升级时，需要这一步才能启用 Git Bash 文本保护。`npm pack` 前自动构建，包内只包含运行入口、构建产物、示例及文档，不包含本地会话数据。

另开一个 Git Bash 窗口，同样定义上面的 `tide` 函数：

```bash
tide list
tide send 5fefa 'claude'     # 填入文本，尚不执行
tide send-key 5fefa Enter
tide capture 5fefa --plain-text

# 观察到 Claude 输入框后
tide send 5fefa '/help'
tide send-key 5fefa Enter
tide capture 5fefa --plain-text
```

例子中的 `5fefa` 替换成 `tide list` 中的实际 ID 前缀。所有接收 Session ID 的命令都支持无歧义前缀，完整 ID 精确匹配优先；有多个候选就列出并拒绝执行。

Git Bash 应使用 `bin/tide` 入口，它在 Node 启动前对文本/插件参数关闭 MSYS 路径转换，避免 `/help` 被改成 `D:/.../Git/help`。引号本身不能阻止这种转换。PowerShell 可直接 `node dist/tide.mjs ...`；在 Git Bash 直接调用 Node 时，文本命令需要 `MSYS2_ARG_CONV_EXCL='*' node dist/tide.mjs send ...`。

包的 `bin` 也指向该 shell 入口；使用 npm 安装的 Windows 命令需要 Git Bash 在 PATH 中。尚未全局安装时直接 `bash bin/tide ...` 即可。

## 命令

命令自带完整帮助，Agent 无需先读 README：`tide --help` 查看能力和操作流程，`tide help send` 或 `tide send --help` 查看参数、输出、示例和失败处理。`--help` 必须紧跟命令单独使用；`tide send <id> '--help'` 仍会发送原文。插件通过 `tide plugins <id>` 发现；命令描述应说明参数、行为和返回值。

| 命令 | 行为 |
| --- | --- |
| `run [--shell executable] [--cwd directory] [-- shell-args...]` | 在现有终端托管 shell |
| `launch [--shell executable] [--cwd directory] [-- shell-args...]` | 新开可见窗口，注册后返回会话信息 |
| `list` | 列出本机当前托管的 shell 会话，不扫描 CLI 历史 |
| `info <id>` | 返回 Tide ID、PID、shell、目录等进程信息 |
| `send <id> <text>` | 写入文本，不自动按回车 |
| `send <id> --stdin` | 从管道读取 UTF-8 原文，适合长文本与多行 |
| `send-key <id> <key> [keys...]` | 顺序发送具名按键或组合键 |
| `capture <id> [--lines N] [--plain-text]` | 获取解析后的终端画面 |
| `wait-idle <id> [--idle-time seconds] [--timeout seconds]` | 等待画面连续不变，或到达超时 |
| `close <id>` | 结束该托管 shell 和会话；不是 CLI 回合打断 |
| `plugins <id>` | 查看插件匹配结果、扩展命令和插件错误 |
| `plugin <id> <plugin> <command> [args...]` | 调用匹配的插件命令 |

默认输出 JSON。`capture --plain-text` 只打印快照里的文本，保留空格、换行和屏幕空行，无 JSON、颜色转义或额外标题；输出区域比原窗口窄时，外层终端仍可能自动折行。

`send-key` 示例：

```bash
tide send-key 5fefa Ctrl+U
tide send-key 5fefa Ctrl+C
tide send-key 5fefa Up Down
tide send-key 5fefa Ctrl+Left
tide send-key 5fefa Ctrl+Shift+Left
tide send-key 5fefa Shift+Tab
tide send-key 5fefa Alt+b
```

支持 Enter/Escape/Tab/Backspace/Space、方向键/Home/End、Insert/Delete/PageUp/PageDown、F1–F12，以及可明确编码的 Ctrl/Alt/Shift 组合。Ctrl+字母映射控制字符，Alt+字母按字面大小写编码；导航键使用 xterm 修饰键序列。Shift+Enter、Ctrl+Enter、Win 等依赖额外协议或桌面行为的按键明确报错，不猜测或静默降级。多个键一次请求先全部校验再投递；需要观察中间画面时分次调用。

`written: true` 只表示输入写进 PTY，不确认 CLI 已提交、执行或完成。请求断连/超时可能已经投递，不自动重发。用户手动输入和 Agent 输入可能交错，调用方应先观察画面再操作；核心不判断当前是否处于输入框或权限弹窗。

`send` 和 `send-key` 均支持在文本/按键之后追加 `--wait-idle` 和 `--with-capture`，可单独使用或组合：

```bash
tide send 5fefa '/help' --with-capture
tide send-key 5fefa Enter --wait-idle --idle-time 2 --timeout 60 --with-capture
```

执行顺序为发送、可选等待、可选抓屏；JSON 保留 `id`、`written`，按选项增加 `wait`（等待结果）和 `capture`（完整快照）。`--idle-time`、`--timeout` 必须与 `--wait-idle` 一起使用，默认值和独立等待命令相同。等待超时仍执行请求的抓屏，退出码为 3。只加 `--with-capture` 会立即抓屏，可能尚未看到程序响应；`send` 始终不自动提交。文本是 ID 后的第一个参数，即使内容恰好为 `--wait-idle` 也按原文发送。`--stdin` 后同样可追加选项。

发送确认后若等待或抓屏失败，仍返回 `written: true`，并附带 `error: {stage, message}`、stderr 错误和退出码 1，避免把观察失败误认为输入未送达。这些步骤不独占终端；其他人或 Agent 仍能同时输入。

`wait-idle` 默认从调用时开始观察，画面连续 2 秒不变返回 `idle: true`（退出码 0），最多等待 30 秒；超时返回 `idle: false`（退出码 3）。两个参数单位为秒，支持小数，上限 3600 秒；`--idle-time` 必须大于 0，`--timeout 0` 表示立即超时。它比较解析后的屏幕文本、尺寸和缓冲区类型，忽略重复绘制相同内容、颜色码和标题变化，不读取历史空闲时间。

画面安静不等于任务完成或输入框已就绪；需要随后 `capture` 判断，加载中的程序也可能暂时无输出。等待不重发输入、不停止目标，调用连接断开后停止这次观察。

## 终端和环境

仍使用用户终端显示、手动输入和调整尺寸；内部由 `node-pty` 托管 shell，`@xterm/headless` 维护屏幕副本。后者解析颜色、清屏、光标移动、覆盖和 alternate screen，不通过正则删颜色码来伪造快照。

默认 shell 按 `--shell`、`TIDE_SHELL`、`SHELL` 选择；Windows 未指定时查找 Git Bash，再使用系统 shell。Bash/zsh/sh/fish 默认交互式 login 参数，PowerShell 加载其常规 profile，也可通过 `--` 显式指定 shell 参数。继承导出的环境变量，启动文件仍由 shell 自己读取；父 shell 中未导出的变量、临时 alias/function 不会自动复制。

子进程继承 `TIDE_SESSION_ID`、`TIDE_STATE_DIR` 和 `TIDE_ENTRY`，可调用 Tide 访问其他会话。macOS Terminal.app 的环境通过一次性本地文件传递，宿主读取后删除。

默认 capture 是当前活动屏幕，`--lines` 可多取滚动缓冲，最大 2000 行。全屏 TUI 的 alternate screen 一般没有普通 shell 的历史滚动区；这不是结构化对话日志。

CLI 退出后仍回到同一个 shell 和 Tide ID；shell 退出或 `close` 后注销会话并返回原终端，不在后台恢复。进程树和窗口强制关闭行为仍受系统及 shell 子进程行为影响。

## Plugin

通过 `.tide/plugins.json` 显式加载本地模块，提供 `detect`、扩展命令、可选 `start` 和输出变化订阅。未来的限流/额度恢复插件可调用同一套 `send`、`sendKey`，不需要独立投递路径。

[插件契约和示例](docs/plugins.md)。本轮没有内置 Claude/Codex 状态识别或自动恢复。

## 验证与迁移

后续问题记录在 [待验证问题](docs/open-questions.md)：快照 token 消耗和调用轮次，以及多个 capture 的相互影响。

```bash
npm run typecheck
npm test
```

测试覆盖终端控制序列、组合键、短 ID 歧义、Git Bash 斜杠参数、真实 PTY/shell、纯文本输出、Plugin 检测与生命周期、本地通信和关闭注销。Windows 本机验证；macOS 新窗口和人工交互仍需实机验收，CI 保留 Windows/macOS 矩阵。

2026-09-23 Windows 手动验收还覆盖了：通过 Tide 给 Claude 创建模块的小任务、观察并确认单次文件写入、独立执行产物验收；Node REPL 表达式、历史键和 Ctrl+U；一个会话内调用 Tide 读取/发送到另一个会话；持续刷屏超时与停止后 idle、11 秒长等待、CLI 退出回到同一 shell。入口脚本是 `scripts/acceptance.mjs`，本机结果在 `.tide/acceptance-latest.json`。该执行环境的 shell rc/CLI 历史目录存在权限提示，因此未验证 CLI 自己的历史持久化；终端操作和产物验收不依赖它。

旧的 `watch/unwatch/resume/quota/status/snapshot/tail/wait`、CLI 历史扫描和自动恢复实现已移除。`tide send` 现在表示终端文本输入，旧的 `--cli/--message/--mode` 用法不再适用。旧配置/历史状态不会导入新会话，新核心不读取它们；升级前已运行的旧版本进程需结束，新版本不会接管它们。

本地运行数据位于 `TIDE_STATE_DIR`（默认安装目录旁 `.tide`）：`sessions/` 保存当前宿主的私有登记，`terminal-launches/` 保存一次性启动交接；不写 CLI 的历史或配置。异常终止留下的失效登记会在确认端点不存在后清理，无法确认的端点会报错，避免错误消除短 ID 歧义。
