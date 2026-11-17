# 第三方代码声明

本插件的「事件折叠 / 等待回复 / 进度快照 / 任务交接」逻辑移植自下列项目，按其许可证保留声明：

## dsh-session-bridge

- 上游：https://github.com/heartmove/dsh-session-bridge
- 版本：v0.7.0
- 许可证：MIT License，Copyright (c) heartmove
- 移植范围：源文件 `src/core.ts` 的 `foldMessages` / `segmentsSince` / `latestSegmentSince` /
  `lastSegmentUpTo` / `lastTextRowUpTo` / `liveReasoningSnapshot` / `reasoningTailOf` / `titleOf` /
  `maxSeq` / `isStalled` / `waitForReply` / `statusSnapshot` / `collectDescendants` 等纯逻辑，
  `src/handoff.ts` 的 `extractTaskContext` / `buildHandoffPrompt` / `renderEvidence` /
  `renderDescendants` / `DEFAULT_HANDOFF_TEMPLATE` 与各截断上限，以及 `src/tools.ts` 中
  `session_bridge_wait` / `session_bridge_segments` / `session_bridge_status` 的参数与返回形状。
- 移植改动：
  1. 事件源由 Session 同步 `events`（DSH 0.1.6 起已弃用）改为「活 agent 内存事件，否则
     冷读 `sessionController.events()`（旧版 `inspect()`）」；
  2. 等待由同步轮询改为异步轮询，间隔仍为 100ms；
  3. `segments` 真正应用 `limit`（上游解析后未使用），并默认不返回思维链；
  4. `status` 对离线会话也可用，并回报 `agentAvailable`；
  5. 交接提示里的下游读取工具改为本插件的 `session_segments` / `session_status`；
     上游的循环检测与后台看门狗（`monitor.ts` / `loop-guard.ts`）未移植；
     本插件把「迁移」暴露为显式工具 `session_migrate`，由调用方决定何时迁移。同样保留
     「先建继任会话、再投递交接、两步都成功才取消原会话」的顺序保证。

MIT License 全文见上游仓库：https://github.com/heartmove/dsh-session-bridge/blob/main/LICENSE
