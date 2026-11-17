# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.0 — 2026-11-17

把作者私有版 `@local/dsh-session-control` 0.4.x 的能力公开：工具从 4 个扩到 10 个，补齐「等回复、读输出、看进度、守候、交接」一整条派活链路。

### 新增

- `session_wait`：阻塞等待目标的下一条新输出，返回 `replyText` / `replyToolCalls` / `stale` / `timedOut` 等；超时不抛异常。
- `session_segments`：增量读取已完成输出段落，用 `nextCursorSeq` 顺读；默认不带思维链。
- `session_status`：实时进度快照（是否在跑、是否卡住、最新回复与思维链），离线会话也可用。
- `session_migrate`：把任务迁到继任会话，先建后停——建会话与投递都成功才取消原会话。
- `session_watch`：跨会话守候。条件 `settled` / `completed` / `failed` / `truncated` / `idle` / `question` / `stalled`，动作 `wake` / `notify` / `record`。
- `session_watches`：列出、取消守候，读取命中统计。

### 行为

- `session_inject` 支持 `asCommand`（按斜杠命令真执行）并返回 `sinceSeq` 等待锚点；`session_create` 同样返回锚点。
- 守候闸门写在代码里：静默段 23:00–07:30 降级为 `record`；`wake` 每天最多 10 次；自守候拒绝；最多 20 条 pending；目标消失落 `failed`。
- `completed` 命中后等 60 秒静默窗口，窗口内再来一轮则以最后一轮为准，避免一次派活叫醒多次。
- 投递前同步占位防重：并发事件（如取消引发的 `turn/end` + `tool/result`）只触发一次通知。
- 守候状态落盘 `<DSH_HOME>/session-control/watches.json`，重启恢复；损坏自动备份重建。命中账本 `telemetry.json` 上限 500 条。

### 工程

- 运行时代码拆为 `index.js` + `src/` 四个模块（守候判定、闸门、存储、账本），仍为零依赖、零构建。
- 冷会话读取同时兼容 `sessionController.events()` 与旧版 `inspect()`——DSH 0.2.2 起 `inspect()` 已移除。
- 测试扩到 5 个文件、222 项断言，全部离线运行。
- `dsh.compatibility.dshReleases` 增加实测版本 `0.2.2-rc.2`。

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
