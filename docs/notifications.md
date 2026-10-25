# Notifications

What the hub can push to a device, what triggers each kind, and what is deliberately not notified. Each
device turns each kind on or off (Settings → Notifications, `PUT /api/push/prefs`); quiet hours and per-session
mute apply to every kind except hand-offs.

## Why "finished" was replaced (false notifications)

Up to 0.7 the hub pushed **finished** on every `session.execution.succeeded` of a root session. In OpenCode v2 a
root session runs many short turns: each background subagent that completes injects a synthetic message
(`session_message.type = 'synthetic'`, `metadata.source = 'subagent'`) into its parent, which starts a new turn,
and steering or Voice turns do the same. So "finished" fired while other subagents and scripts still ran, and it
also fired while a device was showing the session (outside conversation mode).

Evidence (session `ses_eb41ab6b7ffeeYfFAGTjMEhyiB`, "LLM-Controlled KVM Firmware Rewrite", read-only from the
OpenCode DB on 2026-10-22, the session still running):

| | count |
|---|---|
| user messages (incl. 10 sent from the hub) | 86 |
| subagent sessions | 85 |
| synthetic "subagent completed" messages in the root | 81 |
| root turns that ended `succeeded` (each was a "finished" push) | 114 |
| … of which started by a synthetic subagent message | 43 |
| … of which ended while at least one subagent was still running | 82 |
| … of which ended with the whole tree idle (no subagent running, next turn > 15 s later) | 32 |
| root turns that ended `failed` (provider errors: content filter, HTTP 499/503/413) | 12 |

So at least 82 of 114 "finished" notifications were false (work was still in progress). The new **All done**
fires at most once per settled run: about 32 times for this session.

## Kinds

| Kind (pref key) | Label in the title | Trigger | Default |
|---|---|---|---|
| `question` | Question | `form.created` anywhere in the tree (once per form); also agent messaging: an ask an idle session left unanswered after every re-wake ("Unanswered ask"), or sessions messaging each other past the hop cap ("Message loop") | on |
| `permission` | Needs permission | `permission.asked` anywhere in the tree (once per request; Allow/Reject from the notification) | on |
| `done` | All done | the root's last turn succeeded and the whole tree stayed settled for 15 s (see below); once per run | on |
| `failed` | Failed | `session.execution.failed` of the root; body: the error message | on |
| `turn` | Turn finished | every `session.execution.succeeded` of the root (0.7's "finished"), except turns the hub runs for the page | off |
| `stopped` | Stopped | `session.execution.interrupted` of the root with reason `shutdown` or `inactivity` | off |
| `retry` | Retrying | the root's `session.status` turns `retry` (once per retry streak); body: attempt and reason | off |
| `subagentDone` | Subagent *title* finished | a subagent session's run succeeded; body: its parent session | off |
| `subagentFailed` | Subagent *title* failed | a subagent session's run failed; body: the error | off |
| `jobDone` | Script exited 0 | a shell job or terminal (`shell.exited`, `session.shell.ended`, `pty.exited`) exited 0; body: the command | off |
| `jobFailed` | Script exited *n* / was killed / timed out | the same, non-zero exit, killed or timed out | off |
| `longTool` | Long tool finished (*n*s) | a tool call of 30 s or more ended (subagent calls excluded: they are subagents) | off |
| `say` | (session name only) | Voice mode: a spoken reply while no device shows the session | on |
| `handoff` | Hand-off | the terminal sent the session to the phone (ignores quiet hours and mute) | on |
| `activity` | Activity | the digest: one self-replacing notification per session (subagents, long tools, scripts, idle), at most one per interval | off |

**All done** means: the root session is not running (no run, busy or retrying status), no subagent is running or
queued, no shell job runs (an open terminal does not count), no question or permission is pending, and no hub turn
holds the session; and the root's last turn succeeded (a failed or stopped run is reported by those kinds). A
run is armed when anything in the tree starts; anything starting within the 15 s cancels it, so continuation
turns between subagents never send it. It is the replacement for 0.7's "finished".

Titles read "*session* · *label*" (e.g. "KVM Rewrite · All done", "KVM Rewrite · Subagent S3 macros finished",
"KVM Rewrite · Script exited 1"); the service worker tags notifications per session and kind, so a newer one
replaces the older one. Progress kinds (`turn`, `retry`, `subagentDone`, `jobDone`, `longTool`, `activity`) replace
quietly; the others alert again.

Delivery: `question`, `permission`, `failed` are high urgency with a one-hour TTL; `done`, `stopped`,
`subagentFailed`, `jobFailed` normal urgency, one hour; the progress kinds normal urgency, 5 minutes; `say` and
`handoff` high urgency, 5 minutes. At most one notification per session and kind every 30 s (`say`: 10 s);
subagent, script and long-tool notifications count per subagent / job / tool call.

Nothing but questions, permissions, hand-offs and spoken replies is sent while a device shows the session's
tree (presence, 45 s), and a subagent finishing never counts as the root finishing.

### Migration

Stored prefs are rewritten on start: 0.7's `finished` becomes `done` (all done, not every turn); `failed`,
`activity` and the rest are kept; the new kinds start off. 0.5.0's `blocked` still becomes `question` +
`permission`. The API keeps accepting `finished` (→ `done`) and `blocked` from older clients.

## Inventory: OpenCode events and hub sources

Events the spoke forwards (`FORWARDED_EVENTS` in `src/protocol.ts`) and what they notify:

| Event | Notification |
|---|---|
| `session.execution.started` | none; arms/cancels All done |
| `session.execution.succeeded` | root: `turn`, All done candidate; subagent: `subagentDone` |
| `session.execution.failed` | root: `failed`; subagent: `subagentFailed` |
| `session.execution.interrupted` | root, reason `shutdown`/`inactivity`: `stopped`; `user`/`superseded`: none (you stopped it, or a newer turn replaced it); subagent: none |
| `permission.asked` / `permission.replied` | `permission` / none (re-checks All done) |
| `form.created` / `form.replied` / `form.cancelled` | `question` / none (re-checks All done) |
| `session.status` (busy/retry/idle) | root retry: `retry`; otherwise none |
| `shell.created`, `session.shell.started`, `pty.created`, `pty.updated` | none (job state) |
| `shell.exited`, `session.shell.ended`, `pty.exited` | `jobDone` / `jobFailed` |
| `shell.deleted`, `pty.deleted` | none |
| `session.tool.input.started`, `session.tool.called` | none (activity feed) |
| `session.tool.success`, `session.tool.failed` | ≥ 30 s and not a subagent call: `longTool`; digest step |
| `session.text.delta`, `session.text.ended` | Voice mode, nobody watching: `say` |
| `session.reasoning.*` | none (streamed to the page only) |
| `session.created`, `session.renamed`, `session.deleted`, `session.viewed`, `session.agent.selected`, `session.inbox.delivered`, `session.seed` | none (bookkeeping) |

OpenCode v2 events the spoke does not forward (from `@opencode/client` types) and why they are not notified:
`session.idle` (not durable; the hub derives settledness from runs, blockers and jobs), `session.synthetic` (the
synthetic continuation message: the cause of the false "finished", not itself news), `session.retry.scheduled`
(covered by `session.status` retry), `session.compaction.*` (housekeeping), `session.step.*` (per model step: far
too frequent), `session.inbox.*` (queued input), `session.usage.*`, `session.instructions.updated`,
`session.skill.activated`, `session.revert.*`, `session.forked`, `session.moved`, `session.model.selected`,
`session.message.content.updated`, `session.tool.input.delta/ended`, `session.tool.progress` (forwarded compact as
`session.tool.called` with `childSessionID`), and global events (`config.*`, `mcp.*`, `installation.*`,
`vcs.*`, `tui.*`, `server.*`, `worktree.*`, `filesystem.changed`, …).

Hub-side sources:

| Source | Notification |
|---|---|
| Spoke `handoff` request (terminal → phone) | `handoff` |
| Voice mode: root text spoken while nobody watches; hub worker announcements | `say` |
| Activity digest (registry steps: subagent started/ended, long tool, job ended, root idle) | `activity` |
| All done detector (`src/central/done.ts`) | `done` |
| `POST /api/push/test {kind?}` | a test shaped like `kind` (title "Test session · *label*", `test: true`) |
