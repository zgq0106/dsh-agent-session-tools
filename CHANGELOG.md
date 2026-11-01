# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-11-01

首个公开版本，由作者自用的私有版 `@local/dsh-session-control` 泛化而来。

### 新增

- `session_create`：新建会话，可指定工作目录、agent 预设、标题。
- `session_inject`：向任意会话注入消息，支持 `queue`（排队）与 `steer`（引导）两种语义。
- `session_list`：列出可见会话，带运行状态与工作目录。
- `session_cancel`：取消某个会话当前轮次，不丢弃已排队消息。

### 相对私有版的改动

- 包名去掉 `@local` 私有标识，改为可公开安装的 `dsh-agent-session-tools`；补齐 `repository` / `homepage` / `bugs` / `license` / `keywords` / `engines` / `dsh.compatibility` 等发布元数据。
- `session_create` 的 `cwd` 增加绝对路径校验：相对路径直接拒绝，不再交给宿主进程按它自己的当前目录解析。
- 错误信息与 `requestId` 前缀带上插件名，多插件排查时能一眼看出谁报的。
- 新增 `locale/zh.json`、`locale/en.json`、原创图标 `icon.svg`。
- 新增离线冒烟测试 `test/smoke.mjs`（59 项断言），不依赖 DSH 进程即可运行。
- 新增双语 README（`README.md` / `README.en.md`）与 `PUBLISHING.md`。
- README 增加「特点」一节，写明两条工程属性：单文件／零依赖／零构建、改完重启即生效；卸载零副作用（并注明已注入的消息不会被卸载撤销）。
