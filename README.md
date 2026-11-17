# dsh-agent-session-tools

**给 DeepSeek Harness 的 Agent 用的会话工具：新建会话、向任意会话投递消息、等它回复、读它的输出、守候它结束、把任务交给继任会话。**

[English](README.en.md) | 简体中文

## 它解决什么问题

Harness 内核里，Agent 想操作「别的会话」原本只有两条窄路：

- `agentTeams.sendMessage`：只能发给自己的 teammate；
- `subagents.sendMessage`：只能发给直接父会话或直接可续子会话。

**没有对任意会话的通用入口。** 于是常见需求全都做不了：从主会话派活给一个独立会话、把结论同步回另一条对话、叫停一个卡住的会话、让一个会话在另一个会话干完后被叫醒。

本插件补上这个入口。它不自己造轮子，而是直接调用已组合的宿主服务 `ctx.sessionController`——也就是 Web 界面输入框「发送消息」走的同一条投递路径。因此注入的消息在目标会话里就是一条真实的用户消息，不是某种旁门注入。读取侧走 `ctx.agents`（活会话内存事件）与 `sessionController.events()`（冷会话分页读；0.2.1 时代是 `inspect()`，两者都兼容）。

## 特点

- **零依赖、零构建**：运行时代码是 `index.js` 加 `src/` 下四个模块，只用 Node 内置能力，不打包任何第三方依赖，也没有构建步骤。改完代码**重启 DSH 即生效**——不用重装、不用编译、不用等打包。（不重启不生效：Loader 按包名缓存已导入的模块，禁用/启用也不会重读。）
- **卸载无副作用**：卸载只移除这个插件的加载行和包目录。它不写配置、不注册后台任务、不接管现有会话。仅有一处痕迹要说明：**已经注入的消息留在目标会话日志里，卸载不会撤销它们**。守候数据落在 `<DSH_HOME>/session-control/` 下，该目录可随时删除，只会丢统计。
- **窄而明确**：每个工具一个职责，参数严格，错误信息写清缺什么，注入带唯一 `requestId`（服务端幂等）。

## 提供的工具

| 工具 | 作用 | 底层调用 |
|---|---|---|
| `session_create` | 新建一个会话，返回 `sessionId` | `sessionController.create()` |
| `session_inject` | 向指定会话投递一条消息（排队 / 引导 / 斜杠命令） | `sessionController.prompt()` / `commands.execute()` |
| `session_list` | 列出可见会话，用来找 `sessionId` | `sessionController.list()` |
| `session_cancel` | 取消某会话当前正在跑的轮次 | `sessionController.cancel()` |
| `session_wait` | 阻塞等待对方的下一条新输出（回复或段落） | 轮询会话日志（活会话读内存事件） |
| `session_segments` | 增量读取已完成输出段落，可选择性带思维链 | `ctx.agents` 内存事件 / `events()`（旧版 `inspect()`） |
| `session_status` | 实时进度快照：是否在跑、是否卡住、最新回复 | `list()` + 事件折叠 |
| `session_migrate` | 把任务迁到新的继任会话（先建后停，丢不了） | `create()` + `prompt()` + `cancel()` |
| `session_watch` | 登记一条跨会话守候：目标发生指定事件时通知自己 | `session/event` + `ctx.timer` |
| `session_watches` | 列出 / 取消守候、看命中统计 | 本地 `watches.json` + `telemetry.json` |

> `session_cancel` 只发取消请求，**不丢弃**已排队的消息。会话卡在未结算的工具调用上时，它是唯一能救回来的手段——取消后那一轮结束，队列才继续动。

### session_create

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 否 | 新会话工作目录的**绝对路径**；省略用 Harness 默认目录。传相对路径会被拒绝（宿主进程的当前目录调用方看不到，不替调用方猜） |
| `agentPreset` | 否 | 预设 id；省略用默认预设 |
| `title` | 否 | 创建后立即设置的标题 |

返回 `{ sessionId, sinceSeq: -1, agentPreset?, title?, warning? }`。新建会话的锚点固定是 `-1`（既有事件也算入），直接交给 `session_wait` 即可。

### session_inject

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |
| `message` | 是 | 注入的文本，不能为空 |
| `mode` | 否 | `queue`（默认，排队到下一轮）或 `steer`（立即引导当前轮） |
| `asCommand` | 否 | `true` 时按斜杠命令**真执行**（默认 false＝纯文本投递） |

返回 `{ kind, accepted, sessionId, mode, requestId?, sinceSeq?, commandId?, commandText?, commandError? }`。

**`sinceSeq` 是等待锚点**：它在投递**之前**取该会话的最大事件序号，原样传给 `session_wait({ sinceSeq })` 就能精确等待「这条消息之后」的回复。不传锚点的话，`wait` 只能拿调用时刻的最大序号当基线，若对方在你调用前就已经回完，会被判成 `stale + timedOut`（回复拿得到，但标记误导）。读不到锚点时该字段省略，投递本身不受影响。

两种投递语义：

- `queue`：消息进入该会话收件箱，在它下一轮开始时被处理。目标空闲时也会被唤醒起一轮。
- `steer`：消息在该会话最近一个步骤边界生效，用于中途改变方向。

`asCommand: true` 走的是宿主 `commands.execute()`，与在输入框里敲命令同一条路径：`/compact`、`/new` 这类**会真的生效**。仅支持活会话；命令不存在时返回 `accepted:false` 而不是抛错。

### session_wait

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |
| `sinceSeq` | 否 | 只把该序号之后的输出算新输出。**优先传 `session_inject` / `session_create` 返回的锚点**；省略时退回「调用时刻最大序号」，`-1` 表示既有事件也计入 |
| `timeoutMs` | 否 | 等待预算，默认 180000，最大 3600000 |
| `requireTurnEnd` | 否 | true 时额外等到该轮 `turn/end` 收尾（默认 false） |
| `waitFor` | 否 | `reply`（默认，等到新的文本回复）或 `segment`（等到任一新的已完成段落） |
| `includeReasoning` | 否 | segment 模式下是否附带该段思维链（默认 false） |

返回 `{ sessionId, sinceSeq, live, running?, replySeq?, replyText?, replyToolCalls?, turnEnded, timedOut, stale, aborted, waitedMs }`。

三个语义要点：

- **不等 turn/end**：实测 agent 驱动的 turn 不保证产出 `turn/end`，用它做门控会导致「回复早就在、却等到超时」。默认回复文本可读即返回。
- **已落地的回复不会丢**：预算内没有新输出时，返回等待开始前最近一条回复并置 `stale: true`。
- **超时不抛异常**：返回 `timedOut: true` + 已收集内容，调用方自行判断。

### session_list

| 参数 | 必填 | 说明 |
|---|---|---|
| `limit` | 否 | 最多返回多少条，默认 20，范围 1–100 |

只读存储，不会唤醒冷会话。每行带 `running` / `blank` / `origin` / `cwd`，便于挑目标。

### session_cancel

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |

只发取消请求，不丢弃已排队的消息。

### session_segments

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话（活会话或离线会话都可） |
| `sinceSeq` | 否 | 翻页游标，只返回该序号之后的段落（默认 0） |
| `limit` | 否 | 最多返回几段（默认 10，最大 50） |
| `includeReasoning` | 否 | 是否附带每段思维链（默认 false，省 token） |

返回 `{ sessionId, live, nextCursorSeq, returned, segments[] }`，每段为 `{ seq, turn, step, openTurn, text?, toolCalls?, reasoning? }`。用返回的 `nextCursorSeq` 作为下次的 `sinceSeq` 顺读。

### session_status

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |
| `stalledMsThreshold` | 否 | 超过多少毫秒无事件就把 running 会话标为卡住（默认 60000）。idle 会话永不标记 |
| `recent` | 否 | 返回最近多少条消息（默认 8，最大 20） |
| `reasoning` | 否 | `tail`（默认）/`last`/`live`/`none`，选 `none` 完全不返回思维链 |

返回 `{ sessionId, live, agentAvailable, running, title?, cwd?, openTurn, lastTurn, lastActivityAt?, stalledMs?, stalled, pendingWork?, nextTurnCount?, nextStepCount?, lastAssistantText?, lastReasoning?, liveReasoning?, reasoningTail?, messageCount, recent[] }`。

`stalled` 只对 `running` 会话可能为 true——安静的 idle 会话不是卡住。

### 跨会话守候（watch）

派活给一个**独立会话**（不是 subagent）后，用 `session_watch` 登记一条守候，然后本会话就可以结束这一轮。条件满足时插件会往你这里投一条通知，不用 `session_wait` 干等。

```
session_watch({ targetSessionId: 'session-xxx', condition: 'settled', action: 'wake' })
→ { watchId: 'watch-1a2b3c4d', target: 'session-xxx', condition: 'settled', action: 'wake', expiresAt: '2026-11-19T20:00:00+08:00' }
```

| 参数 | 说明 |
|---|---|
| `targetSessionId` | 被守候的会话 |
| `condition` | `settled`（**派活默认用这个**：一轮结束不论成败都通知）/ `completed`（只订正常结束）/ `failed`（出错、中断、超 token）/ `truncated`（结束了但没有产出，`reason=no-output`）/ `idle`（安静超过阈值）/ `question`（卡在提问 20 分钟）/ `stalled`（running 但 15 分钟无事件） |
| `action` | `wake`（默认，拉起新一轮）/ `notify`（投一条消息）/ `record`（只落盘） |
| `idleMs` | `idle` 条件的静默阈值，默认 300000 |
| `expiresInHours` | 有效期小时数，默认 168 |

**为什么派活要用 `settled` 而不是 `completed`**：派出去的会话可能在收尾前断掉，该轮以 `reason=error` 结束——插件判出了 `failed`，但只订 `completed` 的守候不会响，「它断了」这件事没人收到。`settled` 对 `completed` 与 `failed` 都触发，`truncated` 是 `completed` 的子类（轮次结束、最后一条 assistant 消息却没文本），订 `settled` 一次覆盖全部终态。

**闸门（在代码里，不靠提示词）**：静默段 23:00–07:30 一律降级为 `record`；`wake` 每天上限 10 次，超了降 `notify`；自守候（watcher === target）直接拒绝；同时最多 20 条 pending；目标会话消失则落 `failed`。

**静默窗口**：`completed` 命中不会立刻投递——先等 60 秒，窗口内又来一轮就把证据换成最后一轮。一个会话做完一件事往往连续几轮，不这么做一次派活会叫醒你三四次。

**命中的消息是自足的**：含目标会话 id、命中时刻、尾部文本（240 字）与一句「取全文再判断」的下一步，末尾固定一句「这是自动通知，无需回复本条消息」——没有这句，两个会话会互相回话、互为触发源。

**目标没了怎么判**：宿主 `session/disposed` 一到，该目标的 pending 守候立刻落 `failed`；兜底还有「连续 2 次巡检不在会话列表」。两条都要，因为 `sessionController.list()` 会继续列出冷会话——只看列表永远发现不了 dispose。

**命中效果怎么看**：`session_watches({ action: 'stats' })` 出账，四个计数：

| 计数 | 判据 |
|---|---|
| 叫起（`acknowledged`） | 投递后 10 分钟内**守候方**有任意事件 |
| 确认（`confirmed`） | 同上，且结局未被后来的「判早了」推翻 |
| 空炮（`unanswered`） | 10 分钟内守候方毫无动静 |
| 误报（`premature`） | `completed`/`idle` 命中后 5 分钟内**目标**又出一个 `turn/end` |

「叫起」与「确认」分开记：目标后来继续干活会推翻「完成」这个判断，但「这次唤醒确实把人叫起来了」是既成事实。

- 不要用它等 subagent：DSH 原生已有结算通知（父会话 idle 时自动唤醒），重复做只会双份打扰。
- 守候落盘在 `<DSH_HOME>/session-control/watches.json`，重启后自动恢复；损坏时备份为 `watches.corrupt-<时间戳>.json` 并从空开始。
- 观测账本在同目录 `telemetry.json`（上限 500 条，原子重写）。删掉只会丢统计，不影响守候。

### session_migrate

| 参数 | 必填 | 说明 |
|---|---|---|
| `fromSessionId` | 是 | 被接管的原会话 |
| `task` | 否 | 显式指定任务指令，覆盖自动提取的那条 |
| `reason` | 否 | 写进交接提示的中断原因 |
| `cwd` | 否 | 继任会话工作目录；省略沿用原会话记录的 cwd |
| `agentPreset` | 否 | 继任会话使用的预设 |
| `stopSource` | 否 | 交接成功后是否取消原会话当前轮（默认 true） |
| `includeReasoning` | 否 | 交接提示是否带原会话最后一段思维链（默认 true） |

返回 `{ fromSessionId, toSessionId, stopped, descendantCount, promptChars, stopWarning? }`。

**顺序是硬规则**：先建继任会话 → 投递交接提示 → **两步都成功才**取消原会话。创建或投递失败时原会话原封不动，并在错误里写明继任会话 id，不会出现「停了旧的、新的没建起来」把任务丢掉的情况。

交接提示里给三项东西：原会话 id（继任者自己去读）、任务指令与中断前近况（最近用户指令 / 最后回复 / 最后思维链，均截断）、原会话派生的子代理清单（仍在跑的标「不要重做」）。它只吃事件日志，不碰宿主。

## 上下文占用（常驻）

- **10 个工具常驻**，工具描述合计约 2.5K 字符。
- 无 `systemPrompt.section()`，不占系统提示；守候状态落盘，不进提示。
- 结果均有上限：单条文本默认截断（200–300 字符），列表默认 20 条、最多 100 条；`session_wait` 是唯一会长时间挂住的工具（最长 60 分钟），`session_watch` 登记即返回、不阻塞。

## 安装

### 方式一：从 GitHub 装（推荐）

```sh
dsh plugin --profile desktop add github:zgq0106/dsh-agent-session-tools
```

`--profile` 换成你自己的 profile 名。包里没有构建步骤，装完直接可用。要锁版本就写 `#v0.2.0`。

### 方式二：本地目录

把仓库 `git clone` 到本机，然后二选一：

- 用 Harness 的插件管理器，安装目标填该目录的**绝对路径**（宿主会读它的 `package.json`，并写进 profile 的 `dsh.profile.bundles`）；
- 或手工链接：把目录链接到 `<profile>/node_modules/dsh-agent-session-tools`，再在该 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: session-control
      name: dsh-agent-session-tools
```

### 装完要重启

Host 半侧（本包全部代码）按包名缓存已导入的模块：**禁用/启用、重装 bundle 都不会重新读取代码，只有重启 DSH 才保证新代码生效。**

### 与旧版 `@local/dsh-session-control` 的关系

本包由作者此前自用的私有版泛化而来，工具与行为一致。若你之前装过那个私有版，请先移除再装本包——两个插件会注册同名工具（`session_create` 等），同时启用属于未测组合。

## 安全边界

- **注入是真实写入**：消息会进目标会话日志，等于有人在那儿说了那句话，不可撤销。建议先拿一个不重要的会话试一次。
- **工具不做内容审查**：调用方（Agent）为注入内容负责；插件只是忠实转发。
- **空文本会被拒绝**：`prompt` 要求非空白文本或附件，插件侧先拦一次，错误信息直接说明原因。
- **`asCommand: true` 会真执行斜杠命令**——包括有状态变更的那些，默认关闭。
- **`session_migrate` 会在交接成功后取消原会话当前轮**（可用 `stopSource: false` 关掉）。
- **`session_wait` 最长占用 60 分钟预算**，不要对离线会话调用。
- **消息归属**：插件在宿主进程内调用、不带 Remote 主体，因此注入的消息按 **owner** 归属，与你手打的消息同级。
- **幂等**：每次调用生成唯一 `requestId`；服务端对重复 `requestId` 返回原接受结果，不会重复插入。

## 与同类插件的区别

社区里已有相近的插件，动手前值得知道：

- [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge)：通过提示词创建顶层会话、发消息、等待回复、读消息、按会话名跨工作区查找，还带监控与子代理处置——本包的等待、分段读取、状态快照与任务交接逻辑正是移植自它（见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）。
- [`dsh-session-hub`](https://github.com/Asaiuta/dsh-session-hub)：从同一面板聚合控制多台远程 dsh web 服务器上的会话。

本包刻意做得更窄：**纯宿主内工具层**，直接调 `sessionController`，不经提示词、不加界面、不依赖前台页面、不带远程聚合。窄的好处是行为和边界都容易预期。

## 兼容性

| 项目 | 值 |
|---|---|
| 实测 DSH | `0.2.1-rc.5`、`0.2.2-rc.2`（Windows，Node 24.21.0） |
| Node | `^22.19.0 \|\| >=24.0.0`（与 DSH 生态插件同口径） |
| 依赖 | 只用 `ctx.sessionController`、`ctx.agents` 与内置能力，不打包任何第三方依赖 |
| 构建 | 无。`index.js` + `src/` 就是发布产物 |

`package.json` 的 `dsh.compatibility.dshReleases` 只写**实测过**的版本，不声明没验证过的范围。别的版本大概率也能跑（只用了稳定的宿主服务接口），但请以你的实测为准。

宿主没有组合 `@deepseek-ai/dsh-api-session-controller` 时，插件仍会加载、工具仍在，但调用会返回一条说明缺什么服务的错误，而不是静默失败。

## 开发与测试

```sh
node --check index.js
npm test
```

五个测试文件全部离线运行：用假的 Cordis 上下文与桩 `sessionController` 驱动真实的 `apply()`，覆盖注册形状、每个工具的 `execute()` 路径、参数拒绝、守候判定、静默窗口、闸门与账本。不需要 DSH 进程、端口或交互。

| 文件 | 覆盖 |
|---|---|
| `test/smoke.mjs` | 注册形状、10 个工具的执行路径、参数拒绝、幂等 |
| `test/watches.test.mjs` | 守候条件判定、静默窗口、闸门、去重 |
| `test/wiring.test.mjs` | 事件订阅接线、防重放边界 |
| `test/telemetry.test.mjs` | 命中效果计数（叫起/确认/空炮/误报） |
| `test/tick.test.mjs` | 5 分钟巡检：`idle`/`stalled`/`question` 与 dispose 兜底 |

## 许可

MIT
