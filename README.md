[English](README.en.md) | 简体中文

# Tide

**让 Agent 操作终端，让人随时接手同一个会话。**

Tide 是一个面向人和 Agent 协作的交互式终端工具。它在后台托管 Bash 会话，让 Agent 通过命令行发送文本、按键和读取画面；需要人工介入时，再打开终端窗口，接着操作原来的程序。

## 为什么做 Tide

执行一条命令、拿到输出，普通 Shell 工具就足够了。但许多工作不是一次调用就能结束：命令行助手会持续对话，REPL 会保留变量，安装程序会停下来等待选择。Agent 需要继续操作，人也可能想看看它在做什么，或亲自完成其中一步。

这时需要的不只是“再执行一条命令”，而是**让这段交互持续存在，并让人和 Agent 都能访问它**。

Tide 把会话和窗口分开：程序在后台运行，Agent 不必打开窗口就能操作；人通过 `attach` 打开同一会话，关闭窗口后程序仍继续运行。再次接入不需要重启程序，也不需要重新构造它的交互状态。

## 它的优势

- **接续同一段工作。** Shell 的目录、环境和正在运行的前台程序保留在同一会话中。可以接着给 Node REPL 输入表达式，也可以继续与命令行助手对话。
- **人和 Agent 面对同一个终端。** Agent 用 `send` / `read` 操作，人用真实终端查看和输入；不是各自启动一份程序再同步结果。
- **读取画面，而不只是拼接输出。** Tide 解析光标移动、清屏和覆盖绘制，提供终端的文本画面。菜单、进度显示和终端界面程序（TUI）可以通过画面和按键交互，不必为这些操作控制桌面焦点。
- **给 Agent 一个明确的接口。** 稳定的会话 ID、JSON 输出，以及“发送 → 等待画面安静 → 读取”的组合操作，让调用方可以观察结果再决定下一步。默认读取当前/最近命令的预览，不要求搬运整段终端历史。
- **不绑定某个 AI 产品。** Claude Code、Codex、REPL 和其他交互式 CLI 都是 Bash 里的普通程序。核心只提供终端能力；应用专用识别和操作可以放在插件中。

## 什么时候用

| 你要做的事 | 更合适的方式 |
| --- | --- |
| Agent 持续操作一个交互式 CLI，人偶尔查看或接手 | Tide |
| 在同一个 REPL、菜单或终端应用中多次输入，依据画面决定下一步 | Tide |
| 执行脚本、跑测试、获取一次性命令结果 | 普通 Shell / 命令执行工具 |
| 保存完整日志、搜索大量输出 | 输出到文件，再用文件读取和搜索工具 |

Tide 管理的是**由它启动的会话**，不能接管任意已有的终端窗口。它也不判断业务任务是否完成，不提供机器重启或宿主崩溃后的会话恢复。

## 安装

需要 **Node.js 20+、Bash ≥ 4.4**。仅支持新版 Bash，低版本或其他 shell 会在创建会话前被拒绝。

```bash
npm install -g @arkkwang/tide
```

- **Windows**：安装新版 Git Bash，并将它加入 PATH；打开显示窗口需要 Windows Terminal。建议从 Git Bash 使用 `tide`。
- **macOS**：系统自带 Bash 3.2 不符合要求。安装新版并指定给 Tide，不必更改默认登录 shell：

  ```bash
  brew install bash
  export TIDE_SHELL=/opt/homebrew/bin/bash
  # Intel Mac 通常使用 /usr/local/bin/bash
  ```

也可以在每次 `launch` 时用 `--shell` 指定 Bash。macOS 的 `node-pty` helper 若缺执行权限，Tide 会在启动前自动补上；无法修复时给出路径和错误，不使用 `sudo`。

## 试一次人机接续

以 Node REPL 为例，不需要额外安装应用：

```bash
# 1. 后台启动 Node REPL，返回会话 ID 和画面
#    查看返回内容，确认已经出现 Node 的 > 提示符
#    想指定工作目录，可加 --cwd /path/to/project
tide launch --with-command "node" --wait-idle --with-read
```

把下面的 `5fefa` 替换成刚返回的实际会话 ID 或无歧义前缀：

```bash
# 2. Agent 在这个 REPL 中输入表达式，查看结果
tide send 5fefa '1 + 1' --with-enter --wait-idle --with-read

# 3. 人打开同一个 REPL，可以亲自输入表达式
tide attach 5fefa

# 4. 关闭显示窗口后，REPL 仍在后台；Agent 可以继续查看
tide read 5fefa

# 5. 确定不再需要时，结束整个会话
tide close 5fefa
```

`attach` 会打开 Windows Terminal 标签页或 macOS Terminal 窗口，不接入当前终端。每个会话最多一个显示窗口。

换成命令行助手时，将 `node` 替换为已经安装的 `claude` 或 `codex` 即可。启动过程需要交互或不确定何时就绪时，先 `tide launch`，再 `tide wait-idle <id> --with-read` 检查画面，之后发送命令。

## 给 Agent 使用

Tide 提供 CLI；能执行本机命令的 Agent 可以调用它，无需在 Tide 中配置模型或 API Key。

```bash
tide --help              # 发现核心命令
tide help send           # 查看具体参数和返回含义
tide list                # 找到已有会话
tide read 5fefa           # 确认当前画面后，再决定输入什么
```

调用时记住三点：

1. **输入默认不提交。** `send` 默认只填入文本；使用 `--with-enter` 提交，或 `--key Enter` 单独按回车。
2. **画面安静不等于任务完成。** `wait-idle` 只观察画面是否持续不变；超时不会停止程序，也不应因此重发任务。需要根据返回画面判断。
3. **这是共享的实时会话。** 人和 Agent 的输入可能交错，前台程序也可能退出。重要操作应确认当前程序和环境；多步调用不是独占事务。

`read` 默认返回当前/最近命令的前 10 行和后 30 行；需要更多内容时用 `--full` 或 `--lines N`。TUI 读取当前画面。文本、按键、滚动、尺寸和插件参数见[使用参考](docs/cli-reference.md)。

## 状态、支持与边界

- **状态目录统一为 `~/.tide`**，可用 `TIDE_STATE_DIR` 覆盖，与安装目录和系统临时目录分离。Unix socket 使用其中的短路径；Windows 使用命名管道。
- **后台会话不依赖显示窗口**，但依赖宿主进程存活。关闭窗口只是断开显示；`close` 会终止整个会话及其中的工作。
- **Windows 与 macOS** 的后台 PTY 流程已有测试覆盖；Windows Terminal 已有桌面验收，macOS 的窗口交互仍需实机验收。Linux 及其他平台未验证。
- **终端模拟有边界。** 保留画面不是完整运行日志；图像协议、厂商私有扩展和未覆盖的应用不保证恢复。

旧版本升级涉及状态目录、已移除的 `run`、启动 profile 和恢复插件，请先看[迁移说明](docs/cli-reference.md#验证与迁移)。升级不会自动搬动旧目录或停止旧会话。

## 开发与扩展

```bash
git clone https://github.com/arkkwang/tide.git
cd tide
npm install
npm run link:local       # 构建并注册本地 tide 命令
npm run typecheck
npm test
```

普通源码改动用 `npm run build` 重新构建；更改 npm 的命令入口后需要重新 link。`npm test` 包含真实 PTY 测试，并会重新构建 `dist`。

- [使用参考](docs/cli-reference.md)：命令、返回值、安装排障和迁移。
- [后台会话与显示端](docs/background-sessions.md)：会话如何存活、显示如何重新接入。
- [插件契约与示例](docs/plugins.md)：增加应用专用能力；仅加载你信任的本地代码。
- [终端读取的边界](docs/open-questions.md)：当前保证和待验证项。

## 许可证

[MIT](LICENSE)
