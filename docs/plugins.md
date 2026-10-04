# Tide plugins

插件用于在通用终端能力之上增加识别、结构化查询或自动恢复。核心不内置 Claude/Codex 状态机，也不读取 CLI 历史文件。

在 `TIDE_STATE_DIR/plugins.json`（默认项目安装目录旁的 `.tide/plugins.json`）中显式列出本地 ES module：

```json
{"plugins": ["../examples/screen-plugin.mjs"]}
```

相对路径以这个配置文件所在目录为基准。每个会话启动时加载一次，修改后重开会话。也可以用 `tide plugin enable <名称|路径>` / `tide plugin disable <名称|路径>` 改写这个文件：参数就是文件里存的那个字符串（打包名或模块路径），两者同样只对之后启动的会话生效，并打印改动后的启用状态。`enable` 会先加载并校验模块，加载不了或 ID 冲突的插件不会被写进文件。没有自动扫描工作目录、下载或热更新。插件以用户权限运行，应仅配置可信代码。

也可填写随 Tide 打包的名称 `cxr`(Codex)、`ccr`(Claude Code)，见[中断恢复插件](resume-plugins.md)。配置 `cxr` / `ccr` 只是加载插件进程；两者默认**不监听**会话，需要显式 `tide <插件 ID> watch <id>` 才开始观察和计时，未配置则完全不启动。

```bash
tide plugin list          # 所有插件及启用状态
tide plugin enable ccr    # 写 plugins.json；只对新会话生效
tide plugin disable ccr
tide plugin status <id>   # 某个会话里哪些插件生效
tide screen contains <id> 'Claude Code'
tide screen contains --all 'Claude Code'   # 每个匹配会话各问一次
```

`plugin status` 和所有核心命令一样接受无歧义短 ID。插件命令始终位于 `tide <插件 ID> <命令> <会话 ID> [参数...]` 下，插件 ID 是独立命名空间，不会和其他插件冲突，但**不能与核心命令同名**：CLI 先派发核心命令，同名插件永远调不到，所以读取配置时（启动会话、`tide plugin list`、`tide plugin enable`）直接报错，不会加载。CLI 只做命名空间解析和路由，不执行插件代码：第一个参数是会话 ID，请求转发给该会话的宿主，插件代码在那里运行，收到的 `args` 是会话 ID 之后的剩余部分。参数顺序由 CLI 固定，插件不需要自己解析。

命令声明 `all: true` 表示它对每个会话都成立，此时可以用 `--all` 顶替会话 ID：CLI 逐个询问活动会话的匹配结果，只在匹配的宿主里执行，返回每个会话一条 `{id, result}` 或 `{id, error}`。这是"每个会话各跑一次"的汇总，不是插件持有的跨会话状态——状态仍只存在于各会话的宿主里。带副作用、只对某一个会话有意义的命令不应声明 `all`，此时 `--all` 报错。`--all` 必须出现在会话 ID 的位置，否则会被当成参数。

`description` 会通过 `tide plugin status <id>` 和 `tide <插件 ID> --help` 展示给 Agent，应包含参数含义、是否产生副作用和返回值说明，避免必须阅读插件源码才能调用。

## 模块契约

完整 TypeScript 契约见 `src/plugins/runtime.ts`，可运行示例见 `examples/screen-plugin.mjs`。

```js
export default {
  id: 'my-cli',        // 寻址命名空间，全局唯一，且不能与核心命令同名：tide my-cli <command>
  name: 'My CLI',      // 展示名，tide plugin list 和 tide my-cli --help 用
  async detect({ session, capture }) {
    const screen = await capture();
    return /* 根据实际证据判断是否匹配 */ false;
  },
  commands: {
    status: {
      description: 'Query this CLI using its own supported mechanism',
      all: true,       // 用 --all 顶替会话 ID 时，在每个匹配会话里各跑一次
      async run(args, context) {
        // 只在宿主里执行；context 绑定被路由到的会话。
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

`commands` 和 `start` 均可省略。`detect` 必须返回布尔值或相应 Promise，只获得读取上下文。`commands` 的键是命令名，`run(args, context)` 只在宿主里执行：`args` 是 CLI 转发来的命令参数（不含会话 ID），context 绑定被路由到的会话，提供 `session` 和 `capture` / `send` / `sendKey`——和 `start` 拿到的是同一组原语，只少一个 `onOutput`。宿主在执行 `run` 前会重新跑一次 `detect()`。命令可声明 `all: true`（见上），`run` 本身仍只看到一个会话，扇出由 CLI 完成。

`start` 在每个已配置的会话中执行一次，即便此时 shell 里还没有启动目标 CLI；这样插件能订阅后续输出，识别用户后来启动的程序。它必须及时返回，长期工作通过订阅或自行管理的定时器进行，并返回清理函数。

调用扩展命令前重新检测；插件通过 `send` / `sendKey` 写入前也会重新检测，未匹配或会话结束时拒绝写入。检测和真正写入间仍有时序窗口，不保证原子锁定目标程序。插件需处理“不确定”，不能把按键投递当作任务完成。

## Context

| 成员                   | 行为                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `session`            | 当前调用时的只读会话信息：Tide UUID、PID、shell PID、shell、工作目录、创建时间、退出事实 |
| `capture(lines?)`    | 获取解析后的完整屏幕快照，默认当前屏幕，最多 2000 行；不受 CLI `read` 的命令范围和输出预览影响 |
| `send(text)`         | 复用核心文本投递，不自动回车                                                             |
| `sendKey(...keys)`   | 复用核心具名按键/组合键投递                                                              |
| `onOutput(listener)` | 屏幕解析更新后通知；返回取消订阅函数                                                     |

同一个异步输出监听器不会并发执行，执行期间的变化可能合并/跳过，因此这不是完整的逐事件日志。需要完整状态时应重新 capture；等待特定时间恢复由插件自行安排定时器，不能仅依赖以后还有输出。

插件检测/命令的错误会返回给调用者；启动和订阅错误可通过 `tide plugin status <id>` 的 `error` 查看。其他插件和基础命令仍可用。同步阻塞或永不返回的插件没有隔离进程保护。

关闭会话时取消订阅、调用清理函数并拒绝后续写入。核心没有独立后台 watcher；插件生命周期随托管进程结束。

随包提供屏幕查询示例、两个可选中断恢复插件。CLI 特有的屏幕判定、探测策略和缓冲恢复逻辑位于插件层，不加入终端核心。

> 启动新会话时直接切 env + 启动二进制（不需要先开 bash）的能力已迁到 `tide launch --profile`，详见 README 的"启动 profile"一节。本节只讲插件。
