# 已移除的恢复插件 / Removed recovery plugins

Tide 保留本地模块插件机制，但不再内置或维护 Claude Code（`ccr`）与 Codex（`cxr`）自动恢复插件。恢复执行并不能保证长任务持续符合用户目标；当前使用价值不足以支撑应用画面识别和探测策略的维护成本。

Tide still supports local module plugins, but no longer bundles or maintains `ccr` / `cxr`. Automatically continuing execution does not ensure a long-running task remains aligned with the user's goal.

## 升级现有配置 / Migrate existing configuration

从 `TIDE_STATE_DIR/plugins.json` 的 `plugins` 数组中删除 `"ccr"`、`"cxr"`，保留其他本地模块路径。没有其他插件时使用：

```json
{"plugins":[]}
```

Remove the `"ccr"` and `"cxr"` selectors from `plugins.json`, preserving any other local module paths. Empty configuration is shown above.

旧配置不会被自动改写，`resume-patterns.json` 不再读取或自动删除。残留的插件名称会明确报错，而非静默忽略。已运行的会话仍使用启动时加载的旧代码；配置变更只影响新会话。

Existing files are not rewritten automatically. `resume-patterns.json` is no longer read or deleted. Stale selectors produce an explicit error. Running sessions retain their loaded code; configuration changes apply only to new sessions.

## 获取历史实现 / Historical sources

源码保留在公开仓库提交 [`339d973232bb813b1ca955de0f83d00942d26859`](https://github.com/arkkwang/tide/tree/339d973232bb813b1ca955de0f83d00942d26859)：

- [Claude Code 插件 / plugin](https://github.com/arkkwang/tide/tree/339d973232bb813b1ca955de0f83d00942d26859/src/plugins/claude-code-resume)
- [Codex 插件 / plugin](https://github.com/arkkwang/tide/tree/339d973232bb813b1ca955de0f83d00942d26859/src/plugins/codex-resume)
- [共用恢复实现 / Shared recovery code](https://github.com/arkkwang/tide/tree/339d973232bb813b1ca955de0f83d00942d26859/src/plugins/recovery)
- [原使用说明 / Original documentation](https://github.com/arkkwang/tide/blob/339d973232bb813b1ca955de0f83d00942d26859/docs/resume-plugins.md)

在独立目录获取完整历史源码，不回退当前工作目录：

```bash
git clone https://github.com/arkkwang/tide.git tide-recovery-source
git -C tide-recovery-source checkout --detach 339d973232bb813b1ca955de0f83d00942d26859
```

这只是历史源码，不是独立发布、持续维护或可以直接安装的插件包。若要接入当前 Tide，需要自行提取共用代码、构建为 ES module，并用 `default` 导出插件对象（历史入口导出的是工厂函数），再按[插件契约](plugins.md)配置本地路径。需自行验证目标 CLI 版本与恢复行为；本次未验证这种外部移植。

These are historical sources, not standalone installable or maintained plugin packages. To use them with current Tide, extract their shared code, build ES modules and default-export plugin objects (the historical entry points export factory functions), then configure local paths using the [plugin contract](plugins.md). Compatibility with current CLIs and such an external port has not been verified.
