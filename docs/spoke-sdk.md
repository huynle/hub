# Writing a spoke

A spoke connects one harness to the hub: it opens one outbound WebSocket to `/spoke/ws` with the machine token,
says hello (which harness, how it observes it, which operations it serves), reports the harness's sessions, forwards
their events, and answers the hub's requests. The protocol is `packages/protocol/src` (version 1, JSON text frames);
[harnesses.md](harnesses.md) describes the spokes the hub ships.

The packages for writing one live in this repository:

| Package | |
|---|---|
| `packages/spoke-sdk` | `HarnessSpoke` and the parts every spoke needs: the hub connection, enrollment, session ID mapping, tokens, idempotent deliver, prompt envelopes and references |
| `packages/testkit` | test doubles: a fake hub, a fake spoke client, a stub model server, a deny-all proxy, the harness driver protocol |
| `packages/conformance` | the spoke conformance suite (`hub-conformance`) |

They are workspace packages, not published on their own: import them from a checkout of the hub (the scaffold below
writes the relative imports for you). `spoke-sdk` is shipped inside `@huynle/hub`; `testkit` and `conformance` are
development only.

## Start from the scaffold

```sh
bun packages/spoke-sdk/scaffold.ts my-agent ../my-agent-spoke     # [--namespace xy]
npx hub-conformance spoke --driver "bun ../my-agent-spoke/driver.ts"
```

It writes three files into a directory that must not exist yet or be empty (nothing is ever overwritten):

- `spoke.ts`: `MyAgentSpoke`, a `HarnessSpoke` for harness `my-agent` (evidence `hooks`, ops `interrupt` and `stop`,
  `deliver`) over a placeholder harness that echoes prompts, with `sessionStarted`, `promptSubmitted`,
  `interrupt` and `sessionEnded` for the real harness's hooks or events to call;
- `driver.ts`: its conformance driver;
- `README.md`: what to change next.

As written it passes every conformance check except *Permission replies*, which is skipped because it does not
announce `permission`. The name must be a valid harness id (lowercase letters, digits, `.`, `_`, `-`; at most 64)
and not a built-in one (`opencode`, `claude-code`, `codex`). The session namespace defaults to the name's first two
letters; the ones the hub's spokes use (`cc`, `cx`, `pr`, `cf`) are refused, pass `--namespace` then.

## HarnessSpoke

```ts
import { HarnessSpoke, hubSessionID } from "<hub>/packages/spoke-sdk/src/index.ts"

const spoke = new HarnessSpoke({
  server: "https://hub.example.com",   // from the spoke config (enrolled machine)
  token: machineToken,                  // sent only as the WebSocket's bearer; never logged
  harness: "my-agent",
  harnessVersion: "1.2.3",
  evidence: "hooks",                    // native | hooks | rpc | screen
  pluginVersion: "0.1.0",
  directory: process.cwd(),
  handlers: {
    interrupt: async (req) => (await harness.interrupt(req.sessionID), {}),
    stop: async (req) => ({ stopped: (await harness.stop(req.sessionID)) ? [req.sessionID] : [] }),
    permission: async (req) => harness.answer(req.requestID, req.decision),   // {} or {gone: true}
  },
  deliver: async (req) => ({ result: { delivered: "queued", inboxID }, resumed: false }),
  features: ["permissionMessage"],      // modifiers of ops it serves
})
spoke.start()
```

What it does for you:

- **Hello.** Harness, version, evidence and exactly the ops it has handlers for. A non-OpenCode hello implies no
  op: each core op you serve (`turn`, `steer`, `interrupt`, `stop`, `permission`, `form`) is announced because it has
  a handler, and optional ops (`rename`, `create`, `timeline`, …) announce their feature the same way. Always
  announced: `sessionTokens` and `actTokens` (the spoke keeps them for you). `deliver` is announced when you pass
  `deliver`. Modifier features need the op they modify: `permissionMessage` (deny reasons) needs `permission`,
  `launch` (launch creates) needs `create`, `hubPrompt` (agent prompts) needs `deliver`; `turnEvents` says every
  turn end you send is the harness's own (only then does the hub trust `rpc` evidence for idle). The constructor
  throws on an inconsistent set.
- **Dispatch.** An op or option you did not announce, or an op for a session you do not report, is refused with an
  error before your handler runs.
- **Sessions.** `upsertSession(info)` reports a session (new or changed) and sends the sessions frame, also after
  every reconnect; `endSession(id)` stops reporting it and drops its tokens; with `livenessMs`, `prune()` drops
  sessions that showed no sign of life (`touch`, an upsert or an emitted event) for that long. Call `prune()`
  yourself, e.g. on a timer.
- **Events.** `emit(event)` sends only events of the harness subset with valid data, and throws on anything else.
- **Tokens.** `sessionToken(id)` (for the session's shells: `HUB_SESSION_TOKEN` and `HUB_URL`, so `hub` there acts
  as the session) and `actToken(id)` (act verbs only, never in any environment). They are in memory only, kept
  apart, and never logged, serialised or shown by `inspect`.
- **Deliver.** Each hub message is admitted once per `messageID` (`DeliveryLedger`): the hub's retries get the first
  answer without a second admission.
- `start()`, `stop()`, `retryNow()`, `state`, `hubSupports(feature)` (what the hub's welcome listed).

Other exports: `buildHarnessHello` (the hello alone), `SpokeConnection` (the bare connection with backoff and
`bye`), `startEnrollment`/`pollEnrollment`, `deliverText` and `renderPromptEnvelope` (the text a delivered message
or agent prompt should reach the model as), `findReferences`/`resolveReferences`/`renderReferences` (session
references in prompts), `PROMPT_SOURCE`/`isHubPrompt`, `compactActivity`.

## Session IDs

Hub session IDs are `ses_` + 1–200 letters and digits. Map the harness's native IDs with a two-letter namespace of
your own:

```ts
hubSessionID("ma", "0b9a3c1e-7f0d-4a52-9d1b-3f4f2e8a6c11")  // "ses_ma0b9a3c1e7f0d4a529d1b3f4f2e8a6c11"
hubSessionID("ma", "thread-42")                              // "ses_ma0" + hex of the UTF-8 bytes
nativeSessionID("ma", hubID)                                 // back to the native ID, or undefined
```

The mapping is a pure function, so it survives restarts and needs no table. A UUID becomes 32 hex digits (lower
case); any other ID of at most 98 bytes becomes `0` + its bytes in hex. Taken namespaces: `cc` Claude Code, `cx`
Codex, `pr` presets, `cf` the conformance reference spoke.

## The harness event subset

A non-OpenCode spoke sends only these event types (`HARNESS_EVENTS` in `packages/protocol/src/harness-events.ts`,
checked by `harnessEventProblem`); every one is a type hubs already accept. Extra data fields are allowed; texts are
bounded and tool data is summarised, never raw input or output.

| Event | Data |
|---|---|
| `session.created` | `sessionID`, `parentID?`, `title?` (≤ 200) |
| `session.renamed` | `sessionID`, `title` (1–200) |
| `session.deleted` | `sessionID` |
| `session.execution.started` / `succeeded` | `sessionID`, `turnID?` |
| `session.execution.failed` | `sessionID`, `turnID?`, `error?: {message, type?, status?}` (message ≤ 1000, type ≤ 64, status 100–599; the OpenCode spoke sends OpenCode's error type, e.g. `provider.quota`) |
| `session.execution.interrupted` | `sessionID`, `turnID?`, `inferred?: true` (the harness reported none; the spoke found it later) |
| `session.status` | `sessionID`, `status`: `{type: "idle" \| "busy"}` or `{type: "retry", attempt?, message?, next?, errorType?, errorStatus?}` (`next`: epoch ms of the next try; the OpenCode spoke builds it from `session.retry.scheduled`) |
| `session.text.ended` | `sessionID`, `assistantMessageID`, `ordinal` (≥ 0), `text` (≤ 16,000): the turn's reply |
| `session.inbox.delivered` | `sessionID`, `inboxID`, `origin?: "user" \| "hub"`: a prompt entered the session |
| `session.tool.called` | `sessionID`, `id`, `assistantMessageID?`, `summary?` (≤ 160), `background?` |
| `session.tool.success` | `sessionID`, `id` |
| `session.tool.failed` | `sessionID`, `id`, `error?` (≤ 160) |
| `permission.asked` | `sessionID`, `id`, `action` (hub vocabulary: `shell`, `edit`, `read`, `<server>_<tool>`), `resources` (≤ 100), `save?`, `source?: {type: "tool", messageID, id}` |
| `permission.replied` | `sessionID`, `requestID`, `reply?: "once" \| "always" \| "reject"` (none: answered elsewhere, gone) |
| `form.created` | `form: {id, sessionID, title?, fields (≤ 50), metadata?}` |
| `form.replied` / `form.cancelled` | `sessionID`, `id` |

`session.inbox.delivered` with origin `hub` is how a spoke on `hooks`, `screen` or unknown evidence confirms a
message entered the session; without it, a deliver must answer `queued`, never `steer` or `turn`. Origin `user`
(typed in the harness) resets the hub's hop chains for messages.

## Conformance

The suite starts your spoke through its **driver**, against a recording hub, a stub model server and a deny-all
proxy, and checks:

| Check | |
|---|---|
| Hello shape | a valid hello, the machine token only as the bearer, matching what the driver describes |
| Feature honesty | every announced op is served (an answer or an error), every unannounced op and option is refused with an error |
| Events | only the harness subset, valid data, only for reported sessions, no raw tool data |
| Deliver idempotency | a repeated `messageID` (also concurrent) is admitted once and answered the same |
| Deliver result modes | `wake: false` never starts a turn; `steer`/`turn` only with confirmation on hooks/screen evidence |
| Permission replies | `once` runs the tool, `reject` does not, each with `permission.replied` |
| No tokens in output | no machine, session or act token in stderr, stdout, driver results or frames |
| Reconnect after bye | after `bye {retryAfterMs}` the spoke says hello again in time and resends its sessions |
| Frame size limit | no frame over the limit is sent, and an oversize hub frame is dropped, not answered |

Checks that need something the spoke does not announce are skipped with the reason (`permission not announced`).

```sh
npx hub-conformance spoke --driver "bun path/to/driver.ts" [--json] [--out report.json] [--retry-after-ms 1000]
npx hub-conformance spoke -- bun path/to/driver.ts --some-flag
```

Exit 0 when nothing failed, 1 when a check failed, 2 on a usage error. The driver command is split into words and
run without a shell. In tests, `runConformance({driver: [...]})` from `packages/conformance/src/index.ts` returns the
report. Every shipped spoke runs it in CI (`test/e2e-phase7-conformance.test.ts`), and the reference spoke
(`packages/conformance/fixtures/`) has one broken variant per check.

### Driver protocol v1

A driver is an executable speaking newline-delimited JSON on stdio (`packages/testkit/src/driver.ts`; `serveDriver`
does the framing):

```
suite → driver  {"id":1,"method":"describe","params":{…}}
driver → suite  {"id":1,"result":{…}}   or   {"id":1,"error":{"code":"unsupported","message":"…"}}
driver → suite  {"event":"…","data":{…}}     (unsolicited: logs, milestones)
```

| Method | |
|---|---|
| `describe` | `{protocol: 1, harness, harnessVersion, evidence, features, models}`; `models` lists the stub formats the harness can use (`chat`, `anthropic`, `responses`) |
| `start` | `{hubURL, token, directory, env, model: {format, baseURL}}`: start the harness and its spoke against them; `env` carries the deny-all proxy and a throwaway `HOME` |
| `createSession` | `{directory?, prompt?}` → `{sessionID}` (a hub session ID), as the local user would |
| `prompt` | `{sessionID, text}`: type a prompt as the local user |
| `local` | `{sessionID, action}`: `interrupt`, `approve`, `deny` or `exit` in the harness's own UI |
| `stop` / `shutdown` | stop the harness and spoke / then exit |
| `permissionToolCall` | optional: `{name, input}`, the stub model's tool call that makes the harness ask permission |

A method without a handler answers code `unsupported`, and the suite skips what needs it. Lines that are not JSON
objects are ignored (a harness banner is fine).

## Testkit

`packages/testkit/src/index.ts`:

- `fakeHub()`: a fake hub with enrollment and `/spoke/ws` (welcome, recorded frames, `request()` → the spoke's
  answer), for unit tests of a spoke.
- `connectSpoke` / `fakeSpoke` / `helloFrame` / `sessionInfo`: the spoke side, against a real or fake hub.
- `stubModel()`: one loopback server speaking OpenAI chat completions, Anthropic Messages and OpenAI Responses
  (streaming or JSON, text and tool calls), recording requests, scripted with `queue()` / `respond`.
- `denyProxy()`: a deny-all HTTP/HTTPS proxy recording the hosts the harness tried; `env()` sets `HTTP(S)_PROXY`,
  `ALL_PROXY` and `NO_PROXY` for loopback. Real harness CLIs reach out to the internet even with a local model base
  URL, so live tests need both.
- `serveDriver` / `connectDriver` / `spawnDriver`: the driver protocol.

Run a real harness only against the stub model, with a throwaway `HOME` and the harness's config directory set to a
temp dir, never the user's own configuration or a real model API.
