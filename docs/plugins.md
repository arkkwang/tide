# Tide plugins

插件用于在通用终端能力之上增加识别、结构化查询或自动恢复。核心不内置 Claude/Codex 状态机，也不读取 CLI 历史文件。

在 `TIDE_STATE_DIR/plugins.json`（默认项目安装目录旁的 `.tide/plugins.json`）中显式列出本地 ES module：

```json
{"plugins": ["../examples/screen-plugin.mjs"]}
```

相对路径以这个配置文件所在目录为基准。每个会话启动时加载一次，修改后重开会话。没有自动扫描工作目录、下载或热更新。插件以用户权限运行，应仅配置可信代码。

也可填写随 Tide 打包的名称 `codex-resume`、`claude-code-resume`，见[中断恢复插件](resume-plugins.md)。`codex-resume` / `claude-code-resume` 配置即启用对应会话内的自动恢复；未配置不会启动探测。

```bash
tide plugins <id>
tide plugin <id> screen contains 'Claude Code'
```

这两个命令和所有核心命令一样接受无歧义短 ID。插件命令始终位于 `plugin <id> <plugin-id> <command>` 下，不覆盖核心命令。

`description` 会通过 `tide plugins <id>` 展示给 Agent，应包含调用格式、参数含义、是否产生副作用和返回值说明，避免必须阅读插件源码才能调用。

## 模块契约

完整 TypeScript 契约见 `src/plugins/runtime.ts`，可运行示例见 `examples/screen-plugin.mjs`。

```js
export default {
  id: 'my-cli',
  async detect({ session, capture }) {
    const screen = await capture();
    return /* 根据实际证据判断是否匹配 */ false;
  },
  commands: {
    status: {
      description: 'Query this CLI using its own supported mechanism',
      async run(context, args) {
        return { /* 插件自己的结构化结果 */ };
      },
    },
  },
  async start(context) {
    const off = context.onOutput(async () => {
      const screen = await context.capture();
      // 在插件里判断状态、等待重置时间；满足恢复条件后可调用：
      // await context.send('继续');
      // await context.sendKey('Enter');
    });
    return () => { off(); /* 清除插件自己的定时器、连接等 */ };
  },
};
```

`commands` 和 `start` 均可省略。`detect` 必须返回布尔值或相应 Promise，只获得读取上下文。

`start` 在每个已配置的会话中执行一次，即便此时 shell 里还没有启动目标 CLI；这样插件能订阅后续输出，识别用户后来启动的程序。它必须及时返回，长期工作通过订阅或自行管理的定时器进行，并返回清理函数。

调用扩展命令前重新检测；插件通过 `send` / `sendKey` 写入前也会重新检测，未匹配或会话结束时拒绝写入。检测和真正写入间仍有时序窗口，不保证原子锁定目标程序。插件需处理“不确定”，不能把按键投递当作任务完成。

## Context

| 成员                   | 行为                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `session`            | 当前调用时的只读会话信息：Tide UUID、PID、shell PID、shell、工作目录、创建时间、退出事实 |
| `capture(lines?)`    | 获取解析后的屏幕快照，默认当前屏幕，最多 2000 行                                         |
| `send(text)`         | 复用核心文本投递，不自动回车                                                             |
| `sendKey(...keys)`   | 复用核心具名按键/组合键投递                                                              |
| `onOutput(listener)` | 屏幕解析更新后通知；返回取消订阅函数                                                     |

同一个异步输出监听器不会并发执行，执行期间的变化可能合并/跳过，因此这不是完整的逐事件日志。需要完整状态时应重新 capture；等待特定时间恢复由插件自行安排定时器，不能仅依赖以后还有输出。

插件检测/命令的错误会返回给调用者；启动和订阅错误可通过 `tide plugins <id>` 的 `error` 查看。其他插件和基础命令仍可用。同步阻塞或永不返回的插件没有隔离进程保护。

关闭会话时取消订阅、调用清理函数并拒绝后续写入。核心没有独立后台 watcher；插件生命周期随托管进程结束。

随包提供屏幕查询示例、两个可选中断恢复插件。CLI 特有的屏幕判定、探测策略和缓冲恢复逻辑位于插件层，不加入终端核心。

> 启动新会话时直接切 env + 启动二进制（不需要先开 bash）的能力已迁到 `tide launch --profile`，详见 README 的"启动 profile"一节。本节只讲插件。
