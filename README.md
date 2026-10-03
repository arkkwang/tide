# Tide

把用户可见的交互式 shell 提供给人和 Agent 共同使用：启动会话、输入文本、发送按键、读取屏幕。Claude Code / Codex 是 shell 中的普通程序，Tide 用自己的 Session ID 定位窗口。

## 快速开始

```bash
npm install
npm run build

# Git Bash：在项目根目录定义当前窗口的快捷函数
tide() { bash /d/workspace/program/personal/tide/bin/tide "$@"; }

# 新开可见标签页，执行 echo hello，等待并返回会话 ID 和画面
tide launch --with-command "echo hello" --wait-idle --with-read
```

需要全局 `tide` 命令时，在项目目录执行 `npm run link:local`，会先构建再刷新 npm 全局入口。普通代码修改执行 `npm run build` 即可；`package.json` 的 `bin` 改动后必须重新 link，build 不会重建 npm 已生成的启动脚本。尤其从旧的 `dist/tide.mjs` 入口升级时，需要这一步才能启用 Git Bash 文本保护。`npm pack` 前自动构建，包内只包含运行入口、构建产物、示例及文档，不包含本地会话数据。

Windows 的 `launch` 通过 `wt.exe` 在当前 Windows Terminal 窗口新开一个标签页（`wt -w 0`，取当前虚拟桌面上最近使用的窗口）：从 Windows Terminal 内调用时沿用 `WT_PROFILE_ID` 对应的配置，否则使用用户默认配置，包括配色和字体。Windows Terminal 未运行、或当前虚拟桌面上没有窗口时仍新建窗口。Shell 仍按 `--shell` / 环境变量选择，并加载正常的启动文件。未安装 Windows Terminal 时可在已有终端使用 `tide run`。新启动方式只影响新标签页，不更改已有会话。

会话内的 bash 提示符前面带 `T<短 ID>` 标记（例如 `T3c3375b9`），用于区分 Tide 托管的 shell 和自己开的终端；标记无颜色，直接接在原本 prompt 的同一行前面，不改动原 prompt 内容。标记通过 `PROMPT_COMMAND` 注入，所以不会被重写 PS1 的启动文件（如 Git Bash 的 `git-prompt.sh`）覆盖，也不需要改你的 `.bashrc`。其他 shell 没有对应的环境变量入口，保持自己的提示符。

从返回的 `read` 确认 shell 提示符就绪后，使用同一次返回的 `id` 继续操作：

```bash
tide send 5fefa 'echo world' --with-enter --wait-idle --with-read
# 长任务仍在执行时继续等，不重复发送
tide wait-idle 5fefa --timeout 300 --with-read
# 确定不再需要整个会话时
tide close 5fefa
```

例子中的 `5fefa` 替换成 `launch` 或 `tide list` 返回的实际 ID 前缀。所有接收 Session ID 的命令都支持无歧义前缀，完整 ID 精确匹配优先；有多个候选就列出并拒绝执行。复用已有会话时，先 `tide list`，再 `tide read <id>` 确认当前提示符。已拿到最新的组合操作 `read` 时可直接据此判断下一步，无需再抓一次屏。

需要在当前终端托管 shell 时使用 `tide run`，再从另一个终端控制它；启动文件需要交互或必须先检查启动画面时，使用不带命令的 `tide launch`，随后 `tide wait-idle <id> --with-read`。

常用路径（先确认当前画面再输入）：

| 场景 | 操作 |
| --- | --- |
| 新开会话并启动已知命令 | `tide launch --with-command "echo hello" --wait-idle --with-read`，自动发送 Enter |
| 提交内容并查看响应 | `tide send <id> '内容' --with-enter --wait-idle --with-read` |
| 只填入内容，留给用户检查 | `tide send <id> '内容' --with-read` |
| 确认菜单或权限提示 | `tide send <id> --key Enter --wait-idle --with-read`，按当前提示选择正确按键 |
| 长任务仍在运行，继续观察 | `tide wait-idle <id> --timeout 60 --with-read`，不重发原任务；若预期执行较长，可调大 `--timeout`（如 300 秒，上限 3600 秒），减少反复等待调用 |
| 偶尔补看屏幕附近的输出 | `tide wait-idle <id> --with-read --lines 100` |
| 打断前台任务并查看结果 | `tide send <id> --key Ctrl+C --wait-idle --with-read` |
| 只查看当前画面 | `tide read <id>`；需要纯文本时加 `--plain-text` |
| 结束整个托管会话 | `tide close <id>` |

`read` 和组合 `--with-read` 默认省略最后内容或光标行以下的尾部空白行（包括只有空格的行），`--full`、`--plain-text` 同样适用。中间空行、非空行原有空格及光标行保留；`--lines N` 从裁剪后的有效范围取末尾 N 行，默认画面读取不会从屏幕上方历史补足行数。`cursor.row` 相对返回文本，`cols` / `rows` 仍是终端尺寸。命令区域和已读历史省略规则、内部插件 `capture()` 及 idle 检测不变。

`--with-command` 接收一个加引号的单行命令，先等待启动画面连续 3 秒不变（最多 30 秒），再发送文本并在 150 ms 后发送 Enter。搭配的 `--wait-idle`、`--idle-time`、`--timeout`、`--with-read`、`--lines` 复用 `send` 的语义，作用于提交命令之后；所有选项放在 `-- shell-args...` 之前。画面安静不保证提示符就绪，启动文件需要交互时仍应分步检查。启动等待超时不发送命令，返回会话信息和 `error`，退出码 1；后续失败也保留会话 ID。成功返回原会话字段及 `written`、`enterWritten` 和所请求的 `wait` / `read`。

不带 `--with-command` 的 `launch` 返回的是会话已注册，随后用 `wait-idle <id> --with-read` 检查启动画面。超时的退出码 3 不会停止目标，仍应读取返回的画面，再决定继续等、处理提示或结束任务。结束整个 shell 才使用 `close`。

**频繁抓取长输出或滚屏查历史，通常意味着该换一种工具使用方式。** Tide 主要用于与可见的交互式终端协作、检查当前画面和处理输入提示。对于构建日志、测试结果、批量命令输出等，优先使用 Bash / Shell 执行工具或其他适合的工具，将输出重定向到文件，再用 Read 按需读取，或用 grep / rg 搜索。例如在 Bash 中执行 `your-command > output.log 2>&1`，再执行 `rg -n 'error|failed' output.log`。需要同时在终端查看时可用 `tee`。`--lines` 和 `scroll` 用于偶尔补看上下文或操作 TUI；支持这些能力，不代表推荐把反复抓屏、滚屏当作日志分析流程。

`list` 和 `info` 还返回实时活动信息：`idleForMs` 是当前画面持续未变化的毫秒数；`lastOutputAt` 是最后收到 PTY 输出的 UTC ISO 时间，尚无输出时为 `null`。文本、尺寸或活动缓冲区变化会重置 idle，重复重绘、颜色、标题和光标变化不会，但任何非空输出都会更新 `lastOutputAt`。无输出时 idle 从屏幕初始化开始计时，查询和抓屏不重置计时。可先用 `list` 筛选长时间安静的会话，再抓屏判断；这些字段不表示任务完成、故障或需要介入。旧宿主可能不包含这两个字段，新开会话后生效。

Git Bash 应使用 `bin/tide` 入口，它在 Node 启动前对文本/插件参数关闭 MSYS 路径转换，避免 `/help` 被改成 `D:/.../Git/help`。引号本身不能阻止这种转换。PowerShell 可直接 `node dist/tide.mjs ...`；在 Git Bash 直接调用 Node 时，文本命令需要 `MSYS2_ARG_CONV_EXCL='*' node dist/tide.mjs send ...`。

包的 `bin` 也指向该 shell 入口；使用 npm 安装的 Windows 命令需要 Git Bash 在 PATH 中。尚未全局安装时直接 `bash bin/tide ...` 即可。

## 命令

命令自带完整帮助，Agent 无需先读 README：`tide --help` 查看能力和操作流程，`tide help send` 或 `tide send --help` 查看参数、输出、示例和失败处理。`--help` 必须紧跟命令单独使用；`tide send <id> '--help'` 仍会发送原文。插件通过 `tide plugin list` 发现，某个插件自己的命令用 `tide <插件 ID> --help` 查看；命令描述应说明参数、行为和返回值。

| 命令 | 行为 |
| --- | --- |
| `run [--shell executable] [--cwd directory] [-- shell-args...]` | 在现有终端托管 shell |
| `launch [--shell executable] [--cwd directory] [--with-command text \| --profile label] [--wait-idle] [--with-read] [-- shell-args... \| -- <bin-args...>]` | 新开可见终端（Windows 为当前窗口的新标签页），bash 提示符带 `T<短 ID>`；可自动发送命令、Enter，并等待和返回画面 |
| `profiles` | 列出 `.tide/launch-profiles.json` 里的 label、描述、env key 数量 |
| `list` | 列出本机当前托管的 shell 会话，不扫描 CLI 历史 |
| `info <id>` | 返回 Tide ID、PID、shell、目录等进程信息 |
| `send <id> <text>` | 写入文本；加 `--with-enter` 在文本后发送回车 |
| `send <id> --stdin` | 从管道读取 UTF-8 原文，适合长文本与多行 |
| `send <id> --key <key> [keys...]` | 顺序发送具名按键或组合键 |
| `scroll <id> up\|down [--steps N]` | 向支持鼠标的 TUI 发送滚轮事件 |
| `resize <id> --cols N --rows N` | 请求外层窗口调整尺寸，返回实际尺寸 |
| `read <id> [--lines N] [--full] [--plain-text]` | 获取解析后的终端画面 |
| `wait-idle <id> [--idle-time seconds] [--timeout seconds] [--with-read]` | 等待画面连续不变，或到达超时，可同时返回画面 |
| `close <id>` | 结束该托管 shell 和会话；不是 CLI 回合打断 |
| `plugin list` | 列出 Tide 知道的插件及启用状态，不访问会话 |
| `plugin enable <名称\|路径>` / `plugin disable <名称\|路径>` | 改写 `.tide/plugins.json` 的插件列表，只对之后启动的会话生效 |
| `plugin status <id>` | 查看该会话的插件匹配结果、命令和插件错误 |
| `<plugin-id> <command> <id> [args...]` | 调用插件自己的命令，例如 `ccr status <id>`；`all` 命令可用 `--all` 顶替 id，返回每个匹配会话一条结果 |

默认输出 JSON。`read --plain-text` 只打印快照里的文本，保留空格、换行及省略提示，无 JSON 和颜色转义；输出区域比原窗口窄时，外层终端仍可能自动折行。

`send` 统一发送文本和按键：默认原样文本、不回车；`--key` 明确选择按键模式。空格分隔顺序，`+` 表示组合键，不根据内容猜测模式。

```bash
tide send 5fefa Enter       # 输入单词 Enter
tide send 5fefa --key Enter # 按回车
tide send 5fefa q --wait-idle --with-read # 当前分页器用 q 退出时
```

按键示例：

```bash
tide send 5fefa --key Ctrl+U
tide send 5fefa --key Ctrl+C
tide send 5fefa --key Up Enter # 先 Up，再 Enter，中间不等待
tide send 5fefa --key Ctrl+Left
tide send 5fefa --key Ctrl+Shift+Left
tide send 5fefa --key Shift+Tab
tide send 5fefa --key Alt+b
```

支持 Enter/Escape/Tab/Backspace/Space、方向键/Home/End、Insert/Delete/PageUp/PageDown、F1–F12，以及可明确编码的 Ctrl/Alt/Shift 组合。Ctrl+字母映射控制字符，Alt+字母按字面大小写编码；导航键使用 xterm 修饰键序列。Shift+Enter、Ctrl+Enter、Win 等依赖额外协议或桌面行为的按键明确报错，不猜测或静默降级。每次支持 1..64 个键，先全部校验再投递；需要观察中间画面时分次调用。`--key` 不与文本、`--stdin` 或 `--with-enter` 混用；需要回车时将 Enter 写进键序列。普通字符（如 q）直接用文本模式发送。混用模式、非法按键或选项会在写入前整次拒绝，不执行前半段。

`written: true` 只表示输入写进 PTY，不确认 CLI 已提交、执行或完成。请求断连/超时可能已经投递，不自动重发。用户手动输入和 Agent 输入可能交错，调用方应先观察画面再操作；核心不判断当前是否处于输入框或权限弹窗。

`send` 的文本和按键模式均支持在文本/按键之后追加 `--wait-idle` 和 `--with-read`，可单独使用或组合：

```bash
tide send 5fefa '/help' --with-enter --wait-idle --with-read
tide send 5fefa --key Enter --wait-idle --idle-time 3 --timeout 60 --with-read
```

执行顺序为发送、可选等待、可选抓屏；JSON 保留 `id`、`written`，按选项增加 `wait`（等待结果）和 `read`（终端读取结果）。`--idle-time`、`--timeout` 必须与 `--wait-idle` 一起使用，默认值和独立等待命令相同。等待超时仍执行请求的抓屏，退出码为 3。只加 `--with-read` 会立即抓屏，可能尚未看到程序响应；`send` 默认不提交，加 `--with-enter` 后先发送文本，短暂停顿后发送一次 Enter，再等待和抓屏。成功响应增加 `enterWritten: true`，仅表示回车已写入；回车失败保留 `written: true` 和 `error.stage: "enter"`，需先检查画面再决定是否重试。文本是 ID 后的第一个参数，只有 `--stdin` 和 `--key` 用于选择模式，其他内容（如 `--help`、`--wait-idle`）按原文发送。要输入字面量 `--stdin` 或 `--key`，使用管道传入 `--stdin`。`--stdin` 后同样可追加选项。

发送确认后若等待或抓屏失败，仍返回 `written: true`，并附带 `error: {stage, message}`、stderr 错误和退出码 1，避免把观察失败误认为输入未送达。这些步骤不独占终端；其他人或 Agent 仍能同时输入。

`wait-idle` 默认从调用时开始观察，画面连续 3 秒不变返回 `idle: true`（退出码 0），最多等待 30 秒；超时返回 `idle: false`（退出码 3）。两个参数单位为秒，支持小数，上限 3600 秒；`--idle-time` 必须大于 0，`--timeout 0` 表示立即超时。它比较解析后的屏幕文本、尺寸和缓冲区类型，忽略重复绘制相同内容、颜色码和标题变化，不读取历史空闲时间。

独立等待也可组合抓屏：`tide wait-idle <id> --idle-time 3 --timeout 30 --with-read`。空闲或超时后均抓取画面，在原有 `id`、`idle`、`elapsedMs`、`idleForMs` 字段旁增加 `read` 读取结果；超时仍返回退出码 3。抓屏失败时保留等待结果，增加 `error: {stage: "read", message}`，退出码为 1。

所有组合抓屏（`send`、`scroll`、`resize`、`wait-idle`）都可加 `--lines N`，与独立 `read --lines N` 相同，范围 1..2000，须与 `--with-read` 一起使用。它只控制返回的抓屏范围，等待仍比较整个当前画面。默认保留完整当前命令区域，省略已读的前序命令；加 `--full` 关闭历史省略。全屏 TUI 保持完整当前画面。组合操作保留 JSON 中的执行结果和错误，纯文本输出使用独立 `read --plain-text`。

画面安静不等于任务完成或输入框已就绪；需要检查返回的 `read` 或另行抓屏，加载中的程序也可能暂时无输出。等待不重发输入、不停止目标，调用连接断开后停止这次观察。

## 终端和环境

仍使用用户终端显示、手动输入和调整尺寸；内部由 `node-pty` 托管 shell，`@xterm/headless` 维护屏幕副本。后者解析颜色、清屏、光标移动、覆盖和 alternate screen，不通过正则删颜色码来伪造快照。

Windows 宿主在 raw 模式之后启用 VT 输入，让 TUI 的鼠标滚轮、方向键和括号粘贴序列能够透传（包括 Node 20）。启动时通过系统 PowerShell 设置当前控制台输入模式，不常驻额外进程；滚动行为仍由前台 CLI 和终端决定。

默认 shell 按 `--shell`、`TIDE_SHELL`、`SHELL` 选择；Windows 未指定时查找 Git Bash，再使用系统 shell。Bash/zsh/sh/fish 默认交互式 login 参数，PowerShell 加载其常规 profile，也可通过 `--` 显式指定 shell 参数。继承导出的环境变量，启动文件仍由 shell 自己读取；父 shell 中未导出的变量、临时 alias/function 不会自动复制。

子进程继承 `TIDE_SESSION_ID`、`TIDE_STATE_DIR` 和 `TIDE_ENTRY`，可调用 Tide 访问其他会话。macOS Terminal.app 的环境通过一次性本地文件传递，宿主读取后删除。

### 终端读取与历史省略

公开入口由 `capture` / `--with-capture` 改为 `read` / `--with-read`，组合返回字段也改为 `read`，不保留旧入口。升级后需重开旧会话。

Bash 4.4+ 通过 PS1 / PS0 的不可见 OSC 133 标记定位提示符与执行边界，不改命令、不清屏。默认返回完整当前命令区域（包括未变化的进度行），不按窗口高度截断；已读的前序命令区域可以整体省略，并明确标注。命令结束出现新提示符后仍保留刚完成的结果，直到下一条命令开始；两次读取间未读过的其他命令结果也保留。没有读取记录时不省略历史。

- `read <id> --lines 20`：先选区域，再取末尾最多 20 行；区域不足 20 行不从已省略历史补足。
- `read <id> --full`：关闭历史省略，返回缓冲区保留的内容。
- `read <id> --full --lines 20`：从包含历史的范围取末尾最多 20 行。
- 组合 `--with-read` 同样支持 `--full` 和 `--lines`；省略提示不计入内容行数。

最多读取现有缓冲区中的 2000 个显示行，不另外限制字符数。JSON 的 `cols` / `rows` 仍表示终端尺寸，不等于返回文本尺寸；区域读取附带 `omittedHistoryLines` / `limitedLines`，`cursor.row` 相对返回文本（含提示行）。

一个 Session 对应一个 Agent；读取记录保存在该 Session 内存中，独立与组合读取共用，内部 idle 检测和插件 `capture()` 不参与。响应丢失时记录可能已更新，可用 `--full` 补读。不持久化、不支持多个独立读取者。

缺少标记的 shell、Bash 旧版本及 alternate-screen TUI 默认返回当前画面；`--full` 可读取保留的缓冲区。清屏或尺寸变化会重置命令区域记录，收到新的边界后恢复。启动文件若覆盖 PROMPT_COMMAND，可能导致标记失效，届时保持完整画面读取。这不是无损日志，也不表示命令已完成。

CLI 退出后仍回到同一个 shell 和 Tide ID；shell 退出或 `close` 后注销会话并返回原终端，不在后台恢复。注销是立即的（`tide list` 随即不再列出），但 Windows 上宿主进程还要约 6 秒才退出、原终端窗口才恢复：这是 node-pty 的清理时间，不是卡住；宿主不用强制退出换取速度，以免丢掉退出码或依赖 node-pty 内部实现。进程树和窗口强制关闭行为仍受系统及 shell 子进程行为影响。

## 滚动与窗口尺寸

滚动和尺寸调整示例：

```bash
tide scroll 5fefa up --steps 5 --wait-idle --with-read
tide scroll 5fefa down --x 30 --y 10 --with-read
tide resize 5fefa --cols 120 --rows 35 --wait-idle --with-read
```

`scroll` 的步数默认 3（1..100），不等于文本行数；位置是从 1 开始的屏幕列、行，默认屏幕中央。仅支持前台应用启用的 SGR 单元格鼠标协议，不支持时明确报错，不自动换成方向键。滚动改变用户和 Agent 共享的应用视图；普通 shell 历史偶尔可用 `read --full --lines` 补看，频繁查阅应改用文件输出和 Read / grep / rg。

`resize` 要求列数 20..500、行数 5..200，最多等 3 秒确认外层实际尺寸；PTY 和屏幕副本跟随外层，不强制制造内部尺寸差异。返回 `requested`、`actual`、`applied`，未达到目标时退出码为 3，仍可等待和抓屏。终端不支持、最大化、分屏或屏幕边界可能影响结果；请求超时不代表终端不会稍后处理。用户后续手动拉窗口会继续正常同步。已验证本机 Windows Terminal，其他终端不保证支持。

未经确认的观察：ConPTY 下曾见到 MSYS bash 在尺寸变化后丢掉紧随其后写入的第一个字节，但这是在 tide 之外看到的、无法按需复现，手工 resize 后继续输入也未重现，触发条件不明；遇到时重新输入即可。

## 启动 profile

`tide launch --profile <label>` 一步完成"起 session + 切 env + 跑命令"，免去先开 bash 查 cwd、再 `ccs`、再 `claude` 的几次往返。配置文件落在 tide 自己的 `.tide/launch-profiles.json`，跟 home-scripts / `ccs` 解耦。

```json
{
  "profiles": [
    {
      "label": "minimax",
      "description": "MiniMAX via official API",
      "commands": [
        "claude --dangerously-skip-permissions"
      ],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-cp-...",
        "ANTHROPIC_MODEL": "MiniMax-M3[1m]"
      }
    },
    {
      "label": "deepseek-flash",
      "description": "Deepseek flash",
      "commands": [
        "claude --dangerously-skip-permissions"
      ],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-...",
        "ANTHROPIC_MODEL": "deepseek-flash"
      }
    },
    {
      "label": "codex-ark",
      "description": "Codex via 火山方舟",
      "commands": [
        "codex --yolo"
      ],
      "env": {
        "OPENAI_BASE_URL": "https://ark.cn-beijing.volces.com/api/coding",
        "OPENAI_API_KEY": "..."
      }
    },
    {
      "label": "setup-then-run",
      "description": "先 git pull 再启动 claude,适合早上开工场景",
      "commands": [
        "git pull",
        "claude --dangerously-skip-permissions"
      ],
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-..."
      }
    }
  ]
}
```

常用命令：

```bash
# 列出可用 profile(label + 描述 + command + commands + env key 数量)
tide profiles

# 一步: 起新 session + 切到 minimax + cd 进 /d/foo + 启动 claude
tide launch --profile minimax --cwd /d/foo

# 透传额外参数给最后一条命令
tide launch --profile minimax --cwd /d/foo -- --model claude-sonnet-4-20250514

# 连续跑 git pull + claude
tide launch --profile setup-then-run --cwd /d/foo

# 不带 --profile 时,行为和原来一样 —— 裸起 bash,什么也不发
tide launch --cwd /d/foo
```

label 规则: 匹配 `[a-zA-Z0-9_-]+`，大小写不敏感，必须唯一。`commands` 是非空字符串数组,每条是一行 shell 命令,会用 shell-quote 规则拆词(单/双引号保留空格,空格切分);按顺序用 `;` 连接,前一条失败不阻塞后一条。`--` 后面的实参会接到最后一条命令上(覆盖式追加)。`--profile` 与 `--with-command` 互斥。launch 完成后 JSON 多了几个 profile 字段:
- `profile`: 选中的 label
- `index`: profile 在配置数组里的位置
- `command`: 第一条 command 的 argv[0](二进制名,如 `claude`)
- `commands`: 完整命令列表,每条已 join 成字符串(便于直接看跑了什么)

缺失或非法配置时报错带最小模板，便于新用户上手。配置路径默认 `${TIDE_STATE_DIR}/launch-profiles.json`，可用 `TIDE_LAUNCH_PROFILES=<path>` 覆盖。secret 以明文存放在 JSON 中（与 `.claudecode-config` 一致），按需 `chmod 600`。

## Plugin

通过 `.tide/plugins.json` 显式加载插件。每个插件声明 `id`（寻址命名空间，全局唯一）、`name`（展示名）和 `commands`（它自己的命令），另提供 `detect`、可选 `start` 和输出变化订阅。插件命令按 `tide <插件 ID> <命令> <会话 ID> [参数...]` 调用，不占用核心命令名；CLI 只解析命名空间并路由到该会话的宿主，插件代码在宿主里运行。声明 `all: true` 的命令可用 `--all` 顶替会话 ID，CLI 对每个匹配会话各跑一次并返回 `[{id, result}]`；汇总发生在 CLI，状态仍只存在于各会话的宿主里。插件 ID 不能与核心命令同名：CLI 先派发核心命令，同名插件永远调不到，所以读取配置时（启动会话、`tide plugin list`、`tide plugin enable`）直接报错，不会加载。恢复插件复用同一套 `send`、`sendKey`，不使用独立投递路径。

[插件契约和示例](docs/plugins.md)。内置可选的 `cxr`(Codex)、`ccr`(Claude Code)，用 `tide plugin enable ccr` 启用（直接改 `.tide/plugins.json` 等价），重开会话生效：

```json
{"plugins":["cxr","ccr"]}
```

```bash
tide plugin list          # 全部插件及启用状态
tide plugin status 5fefa  # 该会话里哪些插件生效
tide ccr --help           # ccr 自己的命令
tide ccr status --all     # 所有匹配会话的状态
tide ccr status 5fefa
tide ccr watch 5fefa      # 开始监听该会话
tide ccr unwatch 5fefa
```

恢复插件支持限额和 API 连接中断；只处理最新响应明确中断且输入框为空的窗口。最终错误画面默认需连续稳定 3 分钟，CLI 仍在重试、出现新回复或用户输入时不会接管。Codex 额度通过 App Server 查询，网络中断用 `codex exec --ephemeral` 独立探测；Claude 用 `claude -p` JSON ping/pong 探测。确认成功后才向原窗口发送继续，未恢复时每 5 分钟重查。插件默认不监听会话，配置只表示加载插件进程，`watch` 才开始观察和计时。`status` 只读，不触发探测或发送。配置、限制和验证范围见 [中断恢复插件](docs/resume-plugins.md)。

## 验证与迁移

源码按职责组织：

```text
src/
  cli/                      命令解析与帮助
  session/                  会话宿主、启动、登记与 IPC
  terminal/                 屏幕渲染、按键、shell 与 idle 检测
  profile-config/           启动 profile 加载、校验、shell 命令生成
  plugins/
    runtime.ts              插件契约、加载与生命周期
    codex-resume/           Codex 探测与恢复入口
    claude-code-resume/     Claude Code 探测与恢复入口
    recovery/               共用恢复流程、画面识别与探测进程
tests/
  unit/                     单元测试
  integration/              真实 PTY 与会话集成测试
  fixtures/                 测试用终端和 CLI
```

后续问题记录在 [待验证问题](docs/open-questions.md)：快照 token 消耗和调用轮次，以及多个 read 的相互影响。

```bash
npm run typecheck
npm test
```

测试覆盖终端控制序列、组合键、短 ID 歧义、Git Bash 斜杠参数、真实 PTY/shell、纯文本输出、Plugin 检测与生命周期、本地通信和关闭注销。Windows 本机验证；macOS 新窗口和人工交互仍需实机验收，CI 保留 Windows/macOS 矩阵。

2026-09-23 Windows 手动验收还覆盖了：通过 Tide 给 Claude 创建模块的小任务、观察并确认单次文件写入、独立执行产物验收；Node REPL 表达式、历史键和 Ctrl+U；一个会话内调用 Tide 读取/发送到另一个会话；持续刷屏超时与停止后 idle、11 秒长等待、CLI 退出回到同一 shell。入口脚本是 `scripts/acceptance.mjs`，本机结果在 `.tide/acceptance-latest.json`。该执行环境的 shell rc/CLI 历史目录存在权限提示，因此未验证 CLI 自己的历史持久化；终端操作和产物验收不依赖它。

旧的 `watch/unwatch/resume/quota/status/snapshot/tail/wait`、CLI 历史扫描和自动恢复实现已移除。`tide send` 现在表示终端文本输入，旧的 `--cli/--message/--mode` 用法不再适用。旧配置/历史状态不会导入新会话，新核心不读取它们；升级前已运行的旧版本进程需结束，新版本不会接管它们。

本地运行数据位于 `TIDE_STATE_DIR`（默认安装目录旁 `.tide`）：`sessions/` 保存当前宿主的私有登记，`terminal-launches/` 保存一次性启动交接；除 `tide plugin enable/disable` 改写 `.tide/plugins.json` 外，不写 CLI 的历史或配置。异常终止留下的失效登记会在确认端点不存在后清理，无法确认的端点会报错，避免错误消除短 ID 歧义。
