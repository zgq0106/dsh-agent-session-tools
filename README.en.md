# dsh-agent-session-tools

**Session tools for DeepSeek Harness agents: create a session, deliver messages into any session, wait for its reply, read its output, watch it finish, and hand a task over to a successor session.**

[简体中文](README.md) | English

## The gap it fills

Inside Harness an agent can only message other sessions through two narrow paths:

- `agentTeams.sendMessage` — only to its own teammates;
- `subagents.sendMessage` — only to a direct parent or a directly continuable child.

There is **no general entry point** for an arbitrary session. So an agent cannot hand work to a standalone session, push a result back into another conversation, stop a stuck one, or be woken when another session finishes.

This plugin adds that entry point. It does not reimplement anything: it calls the already-composed Host service `ctx.sessionController` — the very admission path the Web composer uses. An injected message therefore lands in the target session as a durable user message, not as a side-channel write. Reads go through `ctx.agents` (live in-memory events) and `sessionController.events()` (paged cold reads; `inspect()` on 0.2.1 builds — both are supported).

## Why it stays light

- **Zero dependencies, zero build.** The runtime is `index.js` plus four modules under `src/`, using only built-in Node capabilities; nothing third-party is bundled and there is no build step. Edit the code, **restart DSH, and the change is live** — no reinstall, no compile, no bundling wait. (The restart is required: the Loader caches imported Host modules per package name, so disabling/enabling does not re-read the files.)
- **Uninstalling leaves nothing behind.** Removal drops the plugin's loader row and its package directory — no config writes, no background tasks, no takeover of existing sessions. One caveat is usage rather than installation: **messages already injected stay in the target session logs; uninstalling does not recall them.** Watch state lives under `<DSH_HOME>/session-control/` and can be deleted at any time; that only loses statistics.
- **Narrow and explicit.** One responsibility per tool, strict parameters, errors that name what is missing, and a unique `requestId` per injection (the service is idempotent on it).

## Tools

| Tool | What it does | Underlying call |
|---|---|---|
| `session_create` | Create a session, return its `sessionId` | `sessionController.create()` |
| `session_inject` | Deliver a message into a session (queued / steering / slash command) | `sessionController.prompt()` / `commands.execute()` |
| `session_list` | List visible sessions, to find an id | `sessionController.list()` |
| `session_cancel` | Cancel a session's running turn | `sessionController.cancel()` |
| `session_wait` | Block until the target's next new output (reply or segment) | polls the session log (in-memory events for live sessions) |
| `session_segments` | Read completed output segments incrementally, optionally with reasoning | `ctx.agents` events / `events()` (legacy `inspect()`) |
| `session_status` | Live progress snapshot: running, stalled, latest reply | `list()` + event folding |
| `session_migrate` | Hand a task over to a successor session (create first, stop second) | `create()` + `prompt()` + `cancel()` |
| `session_watch` | Register a cross-session watch: notify me when the target hits a condition | `session/event` + `ctx.timer` |
| `session_watches` | List / cancel watches, read hit statistics | local `watches.json` + `telemetry.json` |

> `session_cancel` sends a cancel request and **keeps** queued messages. When a session is stuck on an unsettled tool call this is the only way back: the turn ends, then the queue moves.

### session_create

| Parameter | Required | Notes |
|---|---|---|
| `cwd` | no | **Absolute** working directory for the new session; omit for the Harness default. A relative path is rejected rather than resolved against the Host process's cwd, which the caller cannot see |
| `agentPreset` | no | Agent preset id; omit for the configured default |
| `title` | no | Set the title right after creation |

Returns `{ sessionId, sinceSeq: -1, agentPreset?, title?, warning? }`. The anchor of a new session is always `-1` (existing events count), so it can be passed straight to `session_wait`. A failed title is non-fatal: the reason ends up in `warning`.

### session_inject

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |
| `message` | yes | Non-empty text |
| `mode` | no | `queue` (default: handled at the next turn) or `steer` (applied at the next step boundary) |
| `asCommand` | no | `true` executes the text as a slash command (default `false`: plain delivery) |

Returns `{ kind, accepted, sessionId, mode, requestId?, sinceSeq?, commandId?, commandText?, commandError? }`.

**`sinceSeq` is the wait anchor**: it is the target's max event seq taken *before* delivery. Pass it to `session_wait({ sinceSeq })` to wait precisely for the reply *after* this message. Without an anchor, `wait` baselines on its own call time — if the peer already replied, the result comes back `stale + timedOut` (you still get the text, but the flag misleads). The field is omitted when the anchor cannot be read; delivery itself is unaffected.

- `queue` — enters the session inbox and is handled when the next turn starts; it also wakes an idle session.
- `steer` — takes effect at the session's next step boundary, to change direction mid-turn.

`asCommand: true` goes through the Host's `commands.execute()` — the same path as typing into the composer, so `/compact` and `/new` really run. Live sessions only; an unknown command returns `accepted:false` instead of throwing.

### session_wait

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |
| `sinceSeq` | no | Only output after this seq counts as new. **Prefer the anchor returned by `session_inject` / `session_create`**; when omitted it falls back to the call-time max seq, and `-1` counts existing events |
| `timeoutMs` | no | Budget, default 180000, max 3600000 |
| `requireTurnEnd` | no | Also wait for the turn's `turn/end` (default false) |
| `waitFor` | no | `reply` (default: new text reply) or `segment` (any new completed segment) |
| `includeReasoning` | no | In segment mode, attach the segment's reasoning (default false) |

Returns `{ sessionId, sinceSeq, live, running?, replySeq?, replyText?, replyToolCalls?, turnEnded, timedOut, stale, aborted, waitedMs }`.

Three semantics worth knowing:

- **It does not gate on `turn/end`.** Agent-driven turns are not guaranteed to emit `turn/end`; gating on it produces "the reply was there all along, yet we timed out". Readable text is enough.
- **A reply that already landed is not lost.** With no new output inside the budget it returns the most recent reply from before the wait and sets `stale: true`.
- **Timeouts do not throw.** You get `timedOut: true` plus whatever was collected.

### session_list

| Parameter | Required | Notes |
|---|---|---|
| `limit` | no | Rows to return, default 20, range 1–100 |

Read-only, never wakes a cold session. Each row carries `running` / `blank` / `origin` / `cwd`.

### session_cancel

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |

Sends a cancel request and keeps queued messages.

### session_segments

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session (live or offline) |
| `sinceSeq` | no | Page cursor, return segments after this seq (default 0) |
| `limit` | no | Max segments (default 10, max 50) |
| `includeReasoning` | no | Attach each segment's reasoning (default false, saves tokens) |

Returns `{ sessionId, live, nextCursorSeq, returned, segments[] }`; each segment is `{ seq, turn, step, openTurn, text?, toolCalls?, reasoning? }`. Feed `nextCursorSeq` back as `sinceSeq` to continue.

### session_status

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |
| `stalledMsThreshold` | no | Mark a running session stalled after this long without events (default 60000). Idle sessions are never marked |
| `recent` | no | Recent messages to include (default 8, max 20) |
| `reasoning` | no | `tail` (default) / `last` / `live` / `none`; `none` drops reasoning entirely |

Returns `{ sessionId, live, agentAvailable, running, title?, cwd?, openTurn, lastTurn, lastActivityAt?, stalledMs?, stalled, pendingWork?, nextTurnCount?, nextStepCount?, lastAssistantText?, lastReasoning?, liveReasoning?, reasoningTail?, messageCount, recent[] }`.

`stalled` can only be true for a `running` session — a quiet idle session is not stuck.

### Cross-session watches

After handing work to a **standalone session** (not a subagent), register a watch with `session_watch` and end your turn. When the condition hits, the plugin delivers a notification to you instead of making you hold `session_wait`.

```
session_watch({ targetSessionId: 'session-xxx', condition: 'settled', action: 'wake' })
→ { watchId: 'watch-1a2b3c4d', target: 'session-xxx', condition: 'settled', action: 'wake', expiresAt: '2026-11-19T20:00:00+08:00' }
```

| Parameter | Notes |
|---|---|
| `targetSessionId` | Session to watch |
| `condition` | `settled` (**the default for delegation**: fires on any turn end, success or failure) / `completed` (normal end only) / `failed` (error, abort, token limit) / `truncated` (turn ended with no output, `reason=no-output`) / `idle` (quiet past a threshold) / `question` (stuck on a question for 20 min) / `stalled` (running with no events for 15 min) |
| `action` | `wake` (default: start a new turn here) / `notify` (deliver a message) / `record` (write only) |
| `idleMs` | Quiet threshold for `idle`, default 300000 |
| `expiresInHours` | Validity in hours, default 168 |

**Why delegation should use `settled` rather than `completed`**: a delegated session can die before wrapping up, ending its turn with `reason=error`. The plugin classifies that as `failed`, but a `completed`-only watch never fires — nobody learns it broke. `settled` covers both `completed` and `failed`, and `truncated` is a subclass of `completed`, so one `settled` watch covers every terminal state.

**Gates live in code, not in prompts**: the quiet window 23:00–07:30 degrades every hit to `record`; `wake` is capped at 10 per day, then degrades to `notify`; a self-watch (watcher === target) is rejected; at most 20 pending watches; a vanished target is failed.

**Quiet window**: a `completed` hit is not delivered immediately — the plugin waits 60 seconds and, if another turn starts inside it, replaces the evidence with the last turn. One task usually spans several consecutive turns; without this, a single delegation would wake you three or four times.

**Hit messages are self-contained**: target id, hit time, a 240-character tail, and a "read the full output before judging" next step, ending with "this is an automatic notification, no reply needed" — without that line two sessions start replying to each other and become each other's trigger.

**Vanished targets**: `session/disposed` fails the target's pending watches at once, and a fallback marks them failed after two consecutive sweeps where the session is missing from the list. Both are needed: `sessionController.list()` keeps listing cold sessions, so the list alone can never see a dispose.

**Hit quality**: `session_watches({ action: 'stats' })` reports four counters — `acknowledged` (the watcher had any event within 10 minutes of delivery), `confirmed` (same, and the outcome was not later revised), `unanswered` (no activity within 10 minutes), `premature` (the target produced another `turn/end` within 5 minutes of a `completed`/`idle` hit).

- Do not watch subagents: DSH already notifies the parent when a child settles.
- State is stored in `<DSH_HOME>/session-control/watches.json` and restored on restart; a corrupt file is backed up as `watches.corrupt-<timestamp>.json` and a fresh store starts.
- Hit telemetry lives next to it in `telemetry.json` (last 500 records, atomically rewritten). Deleting it only loses statistics.

### session_migrate

| Parameter | Required | Notes |
|---|---|---|
| `fromSessionId` | yes | Session being taken over |
| `task` | no | Explicit task instruction, overriding the auto-extracted one |
| `reason` | no | Interruption reason written into the handoff prompt |
| `cwd` | no | Working directory for the successor; defaults to the source session's |
| `agentPreset` | no | Preset for the successor |
| `stopSource` | no | Cancel the source turn after a successful handoff (default true) |
| `includeReasoning` | no | Include the source's last reasoning in the handoff (default true) |

Returns `{ fromSessionId, toSessionId, stopped, descendantCount, promptChars, stopWarning? }`.

**Ordering is a hard rule**: create the successor → deliver the handoff prompt → only then cancel the source, and only if both steps succeeded. If creation or delivery fails, the source is untouched and the error names the successor id, so "stopped the old one, never started the new one" cannot happen.

The handoff prompt carries three things: the source id (the successor reads it itself), the task plus the state at interruption (last user instruction / last reply / last reasoning, all truncated), and the source's subagent list (still-running ones marked "do not redo"). It only reads the event log.

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile desktop add github:zgq0106/dsh-agent-session-tools
```

Replace `--profile` with your own profile name. The package has no build step. Pin a version with `#v0.2.0` if you prefer.

### From a local checkout

Clone the repo, then either point the Harness plugin manager at the directory's absolute path, or link it into `<profile>/node_modules/dsh-agent-session-tools` and append to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: session-control
      name: dsh-agent-session-tools
```

### Restart is required

The Loader caches an imported Host module per package name: disabling/enabling or reinstalling the bundle does **not** re-read the code. Restart DSH after installing.

### Relation to the private `@local/dsh-session-control`

This package is the generalized release of the author's private version, with the same tools and behaviour. If you have that private version installed, remove it first — both register the same tool names (`session_create` etc.), and running them together is untested.

## Safety

- **Injection is a real write.** The message joins the target session's log as if spoken there, and cannot be recalled. Try a disposable session first.
- **No content review.** The plugin forwards faithfully; the calling agent owns the content.
- **Empty text is rejected** before it reaches the service.
- **`asCommand: true` really executes slash commands**, including state-changing ones. Off by default.
- **`session_migrate` cancels the source turn after a successful handoff**; disable with `stopSource: false`.
- **`session_wait` can hold for up to 60 minutes.** Do not call it on an offline session.
- **Attribution:** the plugin runs in the Host process without a Remote principal, so injected messages are attributed to the **owner**, at the same level as messages you type.
- **Idempotency:** every call mints a unique `requestId`; a repeated id returns the original acceptance instead of inserting twice.

## Similar plugins

- [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge) — creates top-level sessions via prompts, sends messages, waits for replies, reads messages, looks sessions up by name across workspaces, plus monitoring and subagent handling. Much broader; this package's wait, segment, status and handoff logic is ported from it (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
- [`dsh-session-hub`](https://github.com/Asaiuta/dsh-session-hub) — aggregates and controls sessions across multiple remote dsh web servers from one pane.

This package stays deliberately narrow: a **Host-only tool layer** that calls `sessionController` directly — no prompt indirection, no UI, no dependency on the open page, no remote aggregation.

## Compatibility

| Item | Value |
|---|---|
| Verified on | DSH `0.2.1-rc.5` and `0.2.2-rc.2`, Windows, Node 24.21.0 |
| Node | `^22.19.0 \|\| >=24.0.0` (same range as DSH ecosystem plugins) |
| Dependencies | Only `ctx.sessionController`, `ctx.agents` and built-in capabilities; nothing bundled |
| Build | None — `index.js` plus `src/` is the shipped artifact |

`dsh.compatibility.dshReleases` lists only versions that were actually tested. Other releases will most likely work (the surface used is stable), but treat that as unverified.

If the profile does not compose `@deepseek-ai/dsh-api-session-controller`, the plugin still loads and its tools stay registered; calls then fail with an error naming the missing service instead of failing silently.

## Development

```sh
node --check index.js
npm test
```

All five test files run offline: a fake Cordis context and a stub `sessionController` drive the real `apply()`, covering registration shape, every `execute()` path, argument rejection, watch evaluation, the quiet window, the gates and the telemetry ledger. No DSH process, port or interaction needed.

| File | Covers |
|---|---|
| `test/smoke.mjs` | registration shape, all ten `execute()` paths, argument rejection, idempotency |
| `test/watches.test.mjs` | watch conditions, quiet window, gates, de-duplication |
| `test/wiring.test.mjs` | event subscription wiring, replay boundaries |
| `test/telemetry.test.mjs` | hit counters (acknowledged / confirmed / unanswered / premature) |
| `test/tick.test.mjs` | the 5-minute sweep: `idle` / `stalled` / `question` and the dispose fallback |

## License

MIT
