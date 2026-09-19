# tide

在 Codex 额度恢复后，把”继续”发回原会话。

## 三大能力

tide 只做三件事，三件都需要凭结构化字段，而不是错误文案或文件名：

1. **识别中断的会话**。扫描本机该 CLI 的会话记录，找出因额度上限而被停止的那一条。
   - Codex 认 `task_complete.error.codex_error_info`（`usage_limit_exceeded` / `rate_limit_exceeded`）。
   - Claude Code 认转录里的 `error` 枚举。两条线互不猜对方。

2. **判断额度是否恢复**。
   - Codex：直接读结构化额度接口（`account/rateLimits/read`），不靠试错。
   - Claude Code：没有稳定的额度字段，只能用真实请求去探——发一次，看它是否再次被限禁。

3. **向那条会话投递一条”继续”消息，让它接着做原本的任务**。命中 (1) ∩ (2) 才发。
   - 我们只把”投递**收到确认**”视为完成；不重定义它失败，也不等模型整轮。
   - CLI / 桌面进程不在 tide 的管辖范围：用户必须保持目标打开。如果 CLI 此刻是关闭的，这条消息会留到下次启动再被消费——那是 CLI 自己的事。

当前收尾范围：**Windows Git Bash 中的 Codex CLI，以及 Codex 桌面端**。用户保持目标 CLI 或桌面任务打开。tide 负责检查和投递，不持有会话进程，不等待任务完成，也不因整轮超时杀掉 Codex。

```bash
npm install
npm run build
node dist/tide.mjs doctor
node dist/tide.mjs status --cli codex
node dist/tide.mjs resume <session-id> --cli codex --dry-run
node dist/tide.mjs resume <session-id> --cli codex --json
node dist/tide.mjs watch --cli codex
```

## 投递：Codex 自己的队列

Codex CLI 的 `queue` 命令按 thread id 投递，**不区分**会话来自桌面端还是 CLI 本身——`session_meta.source` 不影响 `codex queue` 的行为。

```bash
codex queue --thread <session-id> --message <text>
```

- **投递成功**：进程退出码 0。tide 不接管 TUI、不等模型整轮。
- **持久化**：进程退出后，队列消息留在 Codex 自己手里；之后只读 `app-server` 的 `thread/queue/list` 仍能读到原文。
- **结果未知**：命令超时或非零退出，停止该次中断的自动重发，在 `status` 的 `needsAttention` 里提示核查。

`resume --json` 的 `ok: true` 是 Codex CLI 接受了这则入队，**不是任务做完**。

## 验证投递这件事

`ok: true` 仅代表 Codex CLI 接受了这则入队——不是任务做完。命令退出 ≠ TUI 已消费；要确认 TUI 真消费了，仍需一条真任务。

状态与日志在项目旁的 `.tide/`，不注册系统服务、不设置自启动。程序不直接修改 `~/.codex` 或 `~/.claude`；Codex 接受指令后自行维护历史和队列。

## 项目笔记

工作记录、交付报告、证据档都在 Obsidian 笔记库的 `D:/workspace/utils/obsidian-note/20_projects/cli-auto-resume-2026-09-19/` 下，不在仓库里。仓库只装代码、规则文档和构建产物；要回看背景、找历史证据、改动前的判据，去那里。

## 注释

只写代码本身不能表达的事实——外来依赖的怪癖、平台陷阱、跨文件不变量。不写"为什么这样做"或"为什么没那样做"——那是工作记录的事。

Claude 旧实现暂时保留、默认关闭，尚未按新的投递语义收尾。macOS 不在本轮支持范围。

```bash
npm run typecheck
```

[规则](docs/rules.md)
