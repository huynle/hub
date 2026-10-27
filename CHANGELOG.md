# Changelog

## Unreleased

- **Archive through MCP**: `archive` and `unarchive` (and the narrow agent API
  `PUT /api/agent/sessions/:addr/archive`) change the Hub's archived state without deleting a harness session.
  App tokens use the new explicit `sessions:manage` scope, selectable in Settings → Agents. Existing tokens do
  not gain the scope; operations are idempotent and preserve unrelated view preferences.

- Add App token management to Settings → Agents: create scoped tokens, copy the one-time bearer secret and grant-holder ID, list existing tokens and revoke them.

- **MCP over HTTP**: the hub serves `hub mcp`'s tools at `POST /mcp` (MCP Streamable HTTP, stateless JSON
  responses) for MCP clients and gateways. Auth is `Authorization: Bearer <token>` (an app token with the tools'
  scopes; device, session and act tokens too); a missing or bad token answers `401` with `WWW-Authenticate: Bearer`.
  The tools run as that token through the agent API in process, so scopes, grants, tenancy and the audit apply.
  Packages now ship `packages/cli/src` (the image copies it too).

## 0.7.1

- **Release**: the npm package is published again. 0.7.0's publish step had no Bun for the CLI bundle, so 0.7.0 is
  on GitHub and ghcr.io but not on npm; 0.7.1 is the same code.

## 0.7.0

The agent control plane: sessions get addresses and talk to each other, ask you for Decisions, act for you only
within grants you give, and can be launched on your machines, in sandboxes, or across a cluster of hubs. Hub also
speaks to Claude Code, Codex and terminal tools, not only OpenCode. Upgrading keeps every paired device and enrolled
machine; the new data lives in `agent/` next to `state.json`, which 0.6.x ignores if you roll back.

- **Agent identity**: `@name`, `@@role` and `@me` addresses, the `hub` CLI for agents, app tokens, session tokens.
- **Agent messaging**: `msg`, `ask`, `reply`, `decline`, inboxes and Decisions (`ask @me`), the OpenCode `hub` tool,
  `/who` and `/msg` in the TUI, `hub mcp`.
- **Agent actions**: grants, approve/deny/answer/prompt/stop for agents within them, escalation to Decisions, kill
  switches, the agent audit (Settings → Agents).
- **Launches**: `hub launch` and `hub node`, worktree/checkout/clone workspaces, placement, signed webhooks.
- **Sandboxed launches** in OpenShell sandboxes.
- **More harnesses**: `hub claude` (Claude Code), `hub codex` (Codex), presets for other terminal tools, the spoke SDK
  and conformance suite.
- **Cluster mode**: several hubs on Postgres and Valkey, `hub-server migrate` and `import`, draining, `/readyz`,
  `deploy/k8s`.

The details of each part follow.


### Agent identity

Agents, scripts and apps get their own identity on the hub: every session's shells carry a session token, `hub`
(the CLI) reads and names sessions through the new `/api/agent` API, and apps link with a code. The parts, from
the protocol up:

- **Harness-neutral spoke protocol** (still version 1, compatible both ways). The hello may carry `harness`,
  `harnessVersion` and `evidence` (`native` | `hooks` | `rpc` | `screen`; anything else counts as `unknown`); the
  OpenCode spoke sends `harness: "opencode"`, `evidence: "native"` and keeps `opencodeVersion` for older hubs. A
  hello without `harness` is an OpenCode spoke with the implied v1 features (`IMPLIED_OPENCODE_FEATURES`); new
  spokes announce all their features (`SPOKE_FEATURES`). The welcome lists the hub's features (`HUB_FEATURES`,
  now `["harness"]`) and spokes remember them (`hubSupports`). `/api/machines` processes gain `harness`,
  `harnessVersion` and `evidence`.
- **Device tokens, agent API framework, discovery**: every `/api` request now resolves its caller through one
  credential resolver. Besides the `voice_device` cookie, the same device secret works as
  `Authorization: Bearer <device token>` (for native apps and CLIs) with the same powers and without the
  same-origin check; the cookie together with a hub bearer token is refused (400 `invalid`), while a bearer the hub does not know (e.g. from an auth proxy) next to the cookie is ignored. New `/api/agent/*` routes answer
  errors as `{error: {code, message, hint?}}` (`unauthorized`, `token_expired`, `forbidden`, `not_found`, …)
  and start with `GET /api/agent/whoami` (`{actor, user}`). `GET /.well-known/hub` (public) answers
  `{publicURL, version, minClientVersion, auth: {modes, oidc?}, features}`. Existing routes keep their error
  format.
- **Link native apps**: Settings → Devices → **Add app** shows a QR code and a `hubapp://link?hub=…&code=…`
  link with a 5-minute countdown; the list updates once the app has linked. `POST /api/devices/link` issues
  the single-use 256-bit link code (not valid at `/login` or `/api/pair`); `POST /api/devices/redeem {code,
  deviceName?, publicKey?}` (public, works without `Origin` when the request carries no credential at all)
  answers `{device, token}`: a device token for `Authorization: Bearer`, no cookie. An optional device public
  key is stored for later strong approvals. The console's QR encoder is built in (no new dependency).
- **Session tokens**: the hub mints a token for every session (subagents included) a spoke reports for its own
  user, and sends it with the `sessionTokens` op to spokes that announce the feature: on each sessions frame
  (new sessions, tokens with less than a third of their 24 h left, or after a key or epoch change), again in
  full after a reconnect, and from a 10-minute refresh sweep. Format `hst1.<payload>.<HMAC-SHA256>` (claims
  `typ, uid, mid, sid, exp, kid, ue, me, aud`), signed with the keys in `<HUB_STATE_DIR>/token-keys.json` or
  `HUB_TOKEN_KEYS`. As `Authorization: Bearer`, a session token is a session actor on `/api/agent/*` routes
  that admit sessions (`whoami`), `403` on console routes, `401 token_expired` once expired and `401` once the
  session is no longer reported by that machine, the machine is revoked or the user disabled (both bump the
  token epoch, so re-enabling does not revive old tokens). Tokens are never logged or audited. A session's
  token is visible to its shell and child processes; it is limited by its expiry, the session's liveness and
  the verbs sessions may use.
- **Session tokens reach the spoke** (protocol still version 1): new server op `sessionTokens{tokens: [{sessionID,
  token, exp}], hubURL?}` (at most 500 tokens per frame; `batchSessionTokens` splits a list under `MAX_FRAME`),
  answered with `{applied, skipped: [{sessionID, reason: "unknown" | "expired"}]}`. It is the spoke feature
  `sessionTokens`, announced by new spokes only (not implied for older OpenCode spokes), so hubs send it only to
  spokes that list it. The OpenCode spoke keeps each reported session's latest token in memory (never logged,
  dropped when expired or when the connection changes) and adopts no session for it.
- **Session identity in shells**: every shell an agent runs through OpenCode's shell tool gets its session's
  `HUB_SESSION_TOKEN` and `HUB_URL` (the spoke's server), set by plugin hooks (tool `execute.before` paired with
  shell `create.before` by command; the same command pending from two sessions gets no token). Inherited
  `HUB_URL`/`HUB_SESSION_TOKEN` are removed from the OpenCode process at plugin start and from every shell, and the
  hub bin dir (`$HUB_STATE_DIR/bin`, default `~/.local/state/hub/bin`) goes first on PATH. A deleted session's token
  is dropped. User `!` commands get no token. Opt-in integration test: `HUB_IT_OPENCODE=1 bun test
  test/spoke-env-inject.it.test.ts`.
- **App tokens**: a signed-in user (device cookie or device token) creates app/agent tokens with
  `POST /api/agent/app-tokens {label?, scopes?}` → `201 {id, token, label?, scopes, created}` (the token,
  `hat_<id>_<secret>`, is shown only here), lists them with `GET /api/agent/app-tokens` → `{tokens}` (no secrets)
  and revokes one with `DELETE /api/agent/app-tokens/:id` → `204`. Labels ≤ 100 characters; scopes from
  `sessions:read` (the default); at most 50 per user (`429 rate_limited`). Only sha256 hashes are stored. An app
  token is an app actor on `/api/agent/*` routes its scopes allow (`whoami` always); it is refused on console
  routes and on token management (`403 forbidden`), and once revoked or its user disabled (`401`). Creation and
  revocation are audited (`app-token.create`, `app-token.revoke`).
- **Session names and roles** (`@name`, `@@role`): the hub keeps a per-user record of every session its spokes
  report (machine, parent, project, lastSeen; at most 2000). Root sessions get a name once, from their first
  real title (OpenCode's "New session" placeholders are skipped): its first few words (at most 4 and 24
  characters, cut at a word boundary, ID-like tokens such as `ses_…` dropped), with `-2`, `-3` on a clash.
  `POST /api/agent/name {name, session?}` sets one (409 `name_taken` when taken); the old name stays an alias for
  24 h; a name is released 7 days after its session is archived (the console's Archive) or deleted.
  `POST /api/agent/roles/claim {role, exclusive?, project?, session?}` / `roles/release` manage roles
  (`role.project` scopes; every new holder gets a new `generation`; an exclusive claim fails while another live
  holder exists; a holder offline for 30 min loses the role, except in the 2 min after the hub starts;
  some role names, such as `orchestrator…`, are reserved to the user).
  `GET /api/agent/who?project=&role=` lists named, role-holding and online sessions. Session tokens may read,
  and name or claim for their own session only.
  Addresses (`ses_…` or a unique ID prefix, `@name[.project]`, `@@role[.project]`) resolve within the caller's
  sessions only: another user's are `not_found`, and `ambiguous` candidates never list them.
- **Agent reading** (`/api/agent/*`, for users, session tokens and app tokens with `sessions:read`):
  `GET /api/agent/status` answers the caller's snapshot `{at, you, machines: [{id, name, online, harnesses,
  projects: [{root, name, sessions}]}], attention}`; each session is `{id, name?, roles, title, state, harness,
  parentID?, busySince?, now?, blockers: [{kind, id, summary}], children, labels}` and `attention` lists every
  blocker and error, oldest first. `GET /api/agent/sessions?project=&state=&machine=&label=k=v` is the same
  sessions as a flat list (with `machineID`, `project`). Both read only the hub's catalog and never call a spoke.
  `GET /api/agent/sessions/:addr` adds full blockers (form fields), `directory`, `online` and the spoke's
  `summary` (`unsupported: [{feature, harness}]` instead when the spoke lacks it; `state: "offline"` for a known
  session nobody reports). `GET /api/agent/sessions/:addr/log?n=20` (1–200) answers `{sessionID, rows, older?}`,
  newest first, from the spoke's `timeline` (422 `unsupported {feature, harness}` without it, 503 `offline`).
  `GET /api/agent/watch?blocked=1&session=<addr>` is an SSE stream of compact JSON events for the caller's own
  sessions (`ready`, `state`, `blocker.opened`, `blocker.closed`, `session.added`, `session.removed`; no text),
  with a `ping` event every 20 s. Another user's sessions, names and roles answer `404 not_found` on every route.
- **hub CLI** (`hub`, alias `hubctl`; private workspace `packages/cli`): `status`, `sessions [--project --state
  --machine --label]`, `show <addr>`, `log <addr> [-n]`, `watch [--blocked] [--session]` (JSON lines), `whoami`,
  `who [--project] [--role]`, `name <@name>`, `role claim|release <role> [--exclusive] [--session]`, `login`/`logout`.
  Short text by default, `--json` for the raw answer; exit codes 0 ok, 1 other, 2 usage, 3 not found/ambiguous/
  taken, 4 needs user, 5 forbidden/paused, 6 rate limited, 7 unsupported/offline, 8 gone, 9 unauthorized/expired.
  Credentials: `HUB_URL` + `HUB_SESSION_TOKEN` first, else `~/.config/hub/cli.json` (0600) written by `hub login`
  with an app token. Shipped as one JS bundle (`packages/cli/dist/hub-cli.js`, `npm run build:cli`, built by
  prepack); the plugin writes `hub` and `hubctl` launchers into the hub bin dir at start that run it with the
  OpenCode binary as bun (`BUN_BE_BUN=1`; `node` without Bun; the TypeScript source in a checkout without a build).
- **Tests**: `test/e2e-phase1.test.ts` (in `npm test`) runs all of it end to end in process: a hub, the OpenCode
  spoke and a second spoke of another harness (`fake`, evidence `hooks`, no features: no tokens, `hub log`
  unsupported), and the CLI as a session token, an app token (`hub login`), a linked device and a second user (who
  sees nothing: exit 3), until revoking the machine ends the session token (exit 9). The opt-in
  `HUB_IT_OPENCODE=1 bun test test/spoke-env-inject.it.test.ts` also runs `hub whoami` in a real OpenCode shell
  against an in-process hub and checks it prints the session.

### Agent messaging

Sessions, scripts, apps and you message each other through the hub: `msg`, `ask`, `reply`, `decline`, `inbox` and
`mute` in the `hub` CLI, the OpenCode `hub` tool, the TUI's `/msg` and `/who`, and `hub mcp`; asks to `@me` become
Decisions answered in the console. Messages reach OpenCode sessions as hub messages in their conversation, in an
envelope that marks them as not coming from the user. See the README's *Agent messaging* section and
[docs/multi-user.md](docs/multi-user.md#messaging-tenancy).

- **Delivery engine**: messages go only through spokes that announce `deliver` (an older spoke or another harness
  without it: `unsupported {feature: "deliver"}`, nothing stored; no fallback through steer). A role address picks
  one holder (the idle one, else the most recently active); `all` sends to each. Offline recipients get the message
  when they come back (pending for 24 h); an open ask to an idle recipient is re-woken after 5, 15 and 45 minutes,
  then the user is notified. Messages, asks, pending deliveries, Decisions and mutes live under
  `<HUB_STATE_DIR>/agent/` (one file per user and collection, 0600), not in `state.json`.
- **Envelope**: `[hub] <kind> from <sender> <to> · <time> · <id>`, the body between two boundary lines carrying the
  message id, and a reply hint. Body lines that look like a header, boundary or hint are escaped; control, ANSI,
  bidi and zero-width characters are stripped from the text and from names.
- **Identity primer**: once per session (when it is first named explicitly or gets its first message), a short
  note without a turn: who the session is, how to message others, and that `[hub]` messages are not the user's.
- **Loop protection**: per 10 minutes, 20 messages per sender→recipient pair and 300 per user (`429
  rate_limited` with `retryAfter`), 30 turns started per recipient (then delivered without waking); 8 hops of
  agent-to-agent replies without a human turn (then delivered without waking, the user notified once). Mutes
  refuse a sender (`403 forbidden`); the per-user messaging switch refuses all sends (`423 paused`).
- **The name `me` is reserved**: `@me` always means the user, so no session can be named `me` (`400 invalid`) and
  a title like "Me" derives `me-2`.
- **CLI messaging verbs**: `hub msg`, `hub ask [--wait] [--expires]`, `hub reply`, `hub decline --why`, `hub
  inbox`, `hub mute` / `unmute`, with `--all`, `--no-wake`, `--urgent` and `-` for text on stdin. Exit codes: 5
  `forbidden`/`paused`, 6 `rate_limited`, 7 `unsupported`, 8 `gone` (or an expired ask); a waiting ask exits 1
  when declined or not answered in time.
- **`hub mcp`**: a Model Context Protocol server on stdio (newline-delimited JSON-RPC; `initialize`, `ping`,
  `tools/list`, `tools/call`) whose tools are the CLI's verbs, acting as the CLI's credential (in practice the
  app token from `hub login`). Only protocol frames go to stdout.
- **Console message rows**: hub messages show in a session's conversation, "from @y" for received ones (from the
  spoke's timeline) and "to @@r (→ @x)" for sent ones (from the hub, `GET /api/sessions/:session/messages` and SSE
  `message` events), merged by time; the primer folds into one line.
- **OpenCode `hub` tool**: the plugin adds one tool `hub {verb, …}` (verbs `msg`, `ask`, `reply`, `decline`,
  `inbox`, `who`, `status`, `whoami`; JSON Schema input, not in code mode) that calls `/api/agent` through the SDK
  as the calling session, with that session's own token (never in the tool's output or metadata; redacted should
  a hub echo it). Answers and inbox items show in the hub's sanitised envelope; the description and results say
  messages from other sessions are not from the user. `ask` waits at most 10 minutes (`wait` seconds) and stops
  when the tool call is aborted, naming the still-open ask. Readable errors when the session has no token yet
  or the hub lacks `messaging` (messaging verbs only). Opt-in check: `HUB_IT_OPENCODE=1 bun test
  test/spoke-hub-tool.it.test.ts`.
- **TUI `/who` and `/msg`**: `/who [project | @@role]` lists the hub's named and role-holding sessions (name,
  project, state, online, roles) in a dialog; `/msg @name text` (also `@@role`, `@name.project`, `ses_…`, `@me`)
  sends the text word for word as the session on screen, with that session's own hub token, and toasts where it
  went (`Sent to @bob (queued)`). `/msg` alone (or from the palette) asks for `@name text`. On the home screen
  both say to open a session first. New RPC methods `hubWho {sessionID, project?, role?}` and `hubMsg
  {sessionID, to, text}` (error `unsupported` when the hub lacks `messaging`); Hub commands may now take slash
  arguments (`HubCommand.arguments`, `run(input?)`).
- **Prompt references**: `@name`, `@name.project`, `@@role` and `@@role.project` typed into an OpenCode prompt
  still go to that session unchanged; the plugin's prompt hook adds one attached text file
  (`hub-references.txt`, a `data:` URI the model sees inside the same message) listing each address that names
  one of your sessions (name, session ID, harness, machine, project, state, your open asks to it) and saying to
  contact it with the `hub` tool. OpenCode's own `@` meanings win (an attached file or agent mention for the same
  `@x` is left alone), `@me` and unknown or other users' names add nothing, and hub-delivered prompts are skipped.
  The lookup (`who`, `status`, `inbox` as the session) runs only when an address appears, gives up after 1.5 s,
  fails open and is cached for 10 s per session. Opt-in check: `HUB_IT_OPENCODE=1 bun test
  test/spoke-prompt-refs.it.test.ts`.
- **Decisions and `@me`**: `@me` addresses the user. `msg @me` is stored in the user's inbox; `ask @me` opens a
  Decision (`dec_…`: question, `options [{id, label, safe?}]`, `recommendation {option, why?}`, `urgency`,
  `tier` confirm|tap, `deadline` seconds, `onTimeout`, `about` addresses), answered only by the user on the console:
  `GET /api/decisions?state=`, `GET /api/decisions/:id`, `POST /api/decisions/:id/answer {option, text?}`
  (`tap`: the console cookie only). The first answer wins (later: `409 gone`) and goes back to the asker as the
  user's reply; at the deadline only a `safe` `onTimeout` answers it (`answeredBy: "timeout"`), otherwise it stays
  open and is pushed once more. Agents read their own with `GET /api/agent/decisions[/:id]`; a Decision's ask
  cannot be replied to through `/api/agent/reply`. SDK `ask` takes the Decision fields, plus `decisions`,
  `decision`, `answerDecision`; CLI `hub ask @me --option id=label[:safe] --recommend id --why … --urgency …
  --deadline 2h --on-timeout id --tier … --about @x` and `hub decisions list [--state S]`.
- **Decision cards in the console**: open Decisions show on Home and in the session view of the asking session
  and the sessions they are about: question, options (the recommended one marked, with why; safe ones marked),
  urgency, a live deadline countdown with the timeout's option, and "Answer here (tap)" for `tap` Decisions.
  Answer with an option (and an optional note) or text; an answer that lost the race says "Already answered or
  expired". SSE `{type: "decision", decision}` goes to the user's streams whenever a Decision opens, is
  answered (also by timeout), escalates or expires; a `decision` push carries `decisionID` and its tap opens
  `/s/<session>?decision=<id>` (or `/?decision=…`), which marks the card.
- **Push kinds `decision` and `message`** (both on by default, high urgency, sent even while a device shows the
  session, generic bodies): a Decision opened or escalated; a `msg` to `@me`, an unanswered ask after every
  re-wake, or a message loop (these two were `question` before).
- **Message routes on `/api/agent`**: `POST msg {to, text, wake?, urgent?, all?}`, `POST ask {…, expiresIn?,
  wait?}` (seconds; `wait` ≤ 60 long-polls for the answer), `POST reply {replyTo, text, wake?}`, `POST decline
  {replyTo, why}`, `GET inbox` (`{asks, waiting, messages, muted}`), `GET messages/:id?wait=`, `POST mute` /
  `unmute {session}`, and the per-user switch `GET`/`PUT messaging {enabled}` (users only; off: sends answer
  `423 paused`). The sender is always the credential (body fields are ignored); a session cannot message
  itself (`400 invalid`, also left out of a role it holds); only a message's recipient may answer it, anyone
  else and foreign ids get `404 not_found`. The user and apps have a stored-only inbox. New app token scopes
  `messages:send` and `messages:read`. `GET /api/agent/watch` adds `message` events (no text; users see all,
  sessions and apps only their own). Console: `GET /api/sessions/:session/messages?limit=` lists a session's
  sent and received messages, newest first.
- **SDK messaging verbs**: `msg`, `ask` (with `wait` looping over polls of at most 60 s), `message`, `reply`,
  `decline`, `inbox`, `mute`, `unmute`.
- **OpenCode spoke delivers hub messages** (`deliver` announced when OpenCode has `session.synthetic`). The
  envelope goes in as a synthetic message with metadata `{source: "hub", messageID, kind, from, to, replyTo?}`
  (the model sees only the text) and OpenCode's client id (the hub's `msg_…` id, else a stable `msg_hub…` id
  derived from it), so a retry is applied once. An idle session gets a turn (`turn`); a busy one gets a plain
  message after the running turn (`queued`) and an ask into it (`steer`) unless `meta.delivery` says otherwise;
  with a form open OpenCode holds it (`retained`). `wake: false` and subagent sessions are admitted without
  starting a turn (`queued`, steer without resume: it arrives with the next turn, or joins one already running).
  A repeated `messageID` returns the first result without another admission (only a retry that now asks to wake
  a message admitted without waking is sent again). No voice model, agent or conversation changes. For hubs
  with `messaging`, `session.inbox.delivered` carries `origin: "user"` (typed or phone prompts) or `"hub"` (a
  delivered message) when the spoke saw the item enqueued. Opt-in check against a real `opencode serve`:
  `HUB_IT_OPENCODE=1 bun test test/spoke-deliver.it.test.ts`.
- **Protocol: `deliver` op and messaging features** (still version 1). The hub admits a message into a session
  with `deliver {sessionID, messageID, text, wake, meta: {kind, from, to, replyTo?, delivery?}}`, answered with
  `{delivered: "steer" | "turn" | "queued" | "retained", inboxID?}`. `kind` is `msg`, `ask`, `reply`,
  `decline`, `primer` or `decision` (`reply` and `decline` need `replyTo`); `delivery` is `queue` or `steer`;
  `text` is at most 16000 characters, ids and addresses at most 300, and addresses may not contain control,
  bidi or zero-width characters (`deliverProblem`, `isDeliverResult`). Spokes announce `deliver` in
  `SPOKE_FEATURES` (old OpenCode spokes do not imply it, so the hub must check before sending); the welcome's
  `HUB_FEATURES` gains `messaging`. `session.inbox.delivered` may carry `origin: "user" | "hub"` (same event
  type, so older hubs keep accepting it), and timeline rows gain the `message` kind (`TimelineMessageItem`).
- **Tests**: `test/e2e-phase2.test.ts` runs messaging end to end in process (a spoke with and one without
  `deliver`, the CLI as sessions, an app and two users, the `hub` tool's code path, `hub mcp` over pipes, a Decision
  answered on the console route, mutes, the pair limit and the messaging switch). Opt-in against a real `opencode
  serve`: `HUB_IT_OPENCODE=1 bun test test/e2e-phase2-live.it.test.ts` (one session's model messages another).
- **Internal**: the pure envelope renderer, sanitiser and address parser moved into `packages/sdk` (shared by the
  hub, the plugin and `hub mcp`); the Docker image now copies `packages/sdk/src`.

### Agent actions

Agents can now act on your sessions — approve or deny permission requests, answer forms, prompt and stop sessions
— within grants you create, with everything outside a grant coming back to you as a Decision, two kill switches and
a per-user audit. See the README's *Agent actions and grants* and
[docs/multi-user.md](docs/multi-user.md#grants-tenancy).

- **Grant policy**: patterns `action[:glob]` with OpenCode's wildcard semantics (`bash` is `shell`); a request is
  allowed only when every resource matches an allow pattern, never beats allow (also on the rules an `always`
  reply would save, which must lie inside the allow patterns), and in shell allow patterns `$(`, backticks and
  `<`/`>` must be written literally. Never patterns also match the command without leading assignments and
  wrappers (`sudo`, `env`, `command`, `exec`, `nohup`, `time`). Escalation tiers are the hub's: `tap` for shell,
  `external_directory`, MCP and unknown tools and anything near a never rule, else `confirm`. Project scopes are
  canonical absolute paths matched on path boundaries.
- **Grants** (`/api/agent/grants`: `POST`, `GET`, `GET`/`PUT`/`DELETE …/:id`; users only): holder `ses_…` or
  `@name` (pinned to the session at creation), a reserved `@@orchestrator…` role (follows its holder) or
  `app:<token id>`; `scope.projects` (1–20), `allow` verbs (`approve`, `deny`, `answer`, `prompt`, `stop`, `roles`),
  `permissions {allow, never}`, `expires` (1 minute–30 days, default 8 h), `maxActionsPerHour` (1–1000, default
  60; past it `429 rate_limited`), `allowAlways`. At most 50 active per user; revoked and expired ones stay listed
  (`state`). Owner, holder and token are re-checked on every use.
- **hub.json `agents.never`**: patterns no agent may approve for any user, checked before every grant.
- **Act verbs** (`POST /api/agent/sessions/:addr/approve {requestID, always?, why?}`, `…/deny {requestID, why?}`,
  `…/answer {formID, answer | cancel}`, `…/prompt {text, delivery?}`, `…/stop`): users on their own sessions;
  sessions only with their act token; app tokens with the new scope `sessions:act`, under a grant. Check order:
  tenancy → kill switches → grant → own session tree (a session never answers in its own tree) → hub never → grant
  never → allow (else `403 needs_user` with the evaluation `{verdict, reason, tier, grants}`) → hourly cap → kill
  switches again → spoke. Errors: `needs_user`/`forbidden` 403, `not_found` 404, `gone` 410 (answered elsewhere
  first), `unsupported` 422, `paused` 423, `rate_limited` 429, `offline` 503.
- **Act tokens**: the hub mints a second token per session (`typ: "act"`, same format) and pushes it with the new
  `actTokens` op only to spokes announcing that feature. The OpenCode spoke keeps them apart from shell tokens
  (`actIdentity`), never in any environment or tool output. Shell tokens (`HUB_SESSION_TOKEN`) can never act
  (`403 forbidden`).
- **Escalations**: an approval outside the grant opens one Decision per agent and request (Approve once / Approve
  always / Deny, the agent's `why` as its recommendation, the hub's tier); asking again updates its reason. The
  user's answer replies to the permission as the user (no grant or kill switch applies), audited as the user's. A
  request answered elsewhere or ended closes the Decision (new Decision state `closed`; the console drops it from
  its open list) and the agent's retry is `not_found`. The request's blocker shows the recommendation, and so does
  the escalation push (fetched by the service worker); permissions escalated to `tap` Decisions get no
  Allow/Reject in the notification. Limits: 20 new escalations per agent an hour, 20 open per user; pushes within
  a minute coalesce. Decisions gain actions run on the answer (permission and grant kinds), quiet opens and
  revisions.
- **Grant requests**: `POST /api/agent/grants/requests {grant, why}` from a session (any token) or an app token with
  `messages:send` opens a tap Decision summarising the grant; approving creates it as the user's (holder pinned to
  the requester, or a reserved role it holds) and the requester gets the grant id in a reply. One open request per
  requester, 5 an hour.
- **Hub prompts with provenance**: an agent's prompt is a `deliver` of kind `prompt` naming the sender and the grant
  (spoke feature `hubPrompt`): the spoke wraps it in `[hub] prompt from <sender> · grant <id> · <msg id>` with
  boundary lines and admits it as the hub's (inbox origin `hub`), never as a human turn, so it does not reset the
  hop chain. Agents prompt root sessions only, never themselves, text only, always waking. The user's prompt stays a
  human turn.
- **Deny reasons**: a reject carries an optional `message` (spoke feature `permissionMessage`); the OpenCode spoke
  passes it to OpenCode as the rejection's feedback, prefixed with who denied it and under which grant. Older
  spokes take the reject without it (`reasonSent: false`).
- **Kill switches**: the user's `GET`/`PUT /api/agent/acting {enabled}` and the admin's hub-wide
  `GET`/`PUT /api/admin/agents/acting {enabled}`; either pauses every agent action (`423 paused`) while reading,
  messaging and the user's own actions keep working.
- **Agent audit**: every agent action and attempt (decision `allow`, `needs_user`, `forbidden`, `paused`,
  `rate_limited`; outcome `ok`, `gone`, `offline`, `unsupported`, `escalated`, `refused`, `failed`), switch changes,
  escalation answers and grant requests, in a per-user ring of 2000: `GET /api/agent/audit?limit=&before=` (users
  only) and SSE `{type: "agent", entry}` to the owner. Admins get summaries only (`agent.<verb>`, the actor kind).
- **Clients**: SDK act verbs (`approve`, `deny`, `answer`, `cancelForm`, `prompt`, `stop`), grants (`grants`,
  `grant`, `createGrant`, `updateGrant`, `revokeGrant`, `requestGrant`) and `needsUserOf`; CLI `hub approve | deny |
  answer | prompt | stop` (needs user: exit 4 with the evaluation and the Decision), `hub grant list | show | create |
  revoke | request`, `hub decisions list --state closed`; `hub mcp` tools `approve`, `deny`, `answer`, `prompt`,
  `stop`; the OpenCode `hub` tool's act verbs (with the session's act token; `needs_user` reads as "the user
  decides, do not retry").
- **Console**: Settings → Agents lists grants (state, holder, projects, verbs, never patterns, expiry countdown)
  with create, edit and revoke, the acting switch (and the hub-wide one for admins) and an Activity tab (the agent
  audit, paged). Session views show agents' recommendations on blockers, who answered a Decision, and escalation
  details on Decision cards.
- **Tests**: `test/e2e-phase3.test.ts` runs it end to end in process (a real spoke with `deliver`, `actTokens`,
  `hubPrompt` and `permissionMessage` and a raw spoke without; the holder acting through the `hub` tool's code path
  and an app token through the CLI; shell tokens, never rules, the own-tree ban, escalation and the user answering
  first, kill switches, the hourly cap, prompts, deny reasons, grant requests and the audit), and
  `test/central-tenancy.test.ts` covers every phase-3 route and CLI verb across users. Opt-in against a real
  `opencode serve`: `HUB_IT_OPENCODE=1 bun test test/e2e-phase3-live.it.test.ts` (one session's model approves
  another's shell permission through the `hub` tool) and `test/spoke-acting.it.test.ts` (hub prompts, deny reasons).

### Launches

You, a script or an app can now start a session on one of your machines and have it end by itself: a `hub node`
daemon prepares a git worktree (or a checkout or a clone), the machine's OpenCode service creates the session in it,
and the hub names it, gives it roles, labels and a first prompt, watches it to its end and tells apps through signed
webhooks. See [docs/launches.md](docs/launches.md) and [docs/multi-user.md](docs/multi-user.md#launch-tenancy).

- **Protocol** (still version 1): a node hello on `/spoke/ws` (role `node`: runtimes, labels, capacity and use,
  workspace roots, draining, the launches it holds), node ops `prepare`, `collect`, `cleanup` and `cancel` with
  `progress` and `capacity` frames, the launch spec and launch view types, and the spoke feature `launch` (a create
  op carrying `launchID`, `agent` and `model`). Hub features `nodes` and `launches` are announced only by hubs that
  serve them; the webhook signature format (`Hub-Signature: t=…,v1=…`, `Hub-Event`, `Hub-Delivery`) lives in the
  protocol package.
- **Launch spec and store**: `POST /api/agent/launches` bodies are validated strictly (unknown fields refused; git
  branches per `git check-ref-format` with no option-like parts; https/ssh remotes only, without credentials;
  absolute repo paths; bounded name, roles, prompt, labels and timeout) with defaults filled in (harness
  `opencode`, mode `worktree`, runtime `host`, end `idle`, cleanup `keep`). Launches are stored per user with a
  state machine `queued → placing → provisioning → running → ended{idle, needs_user, failed, timeout, stopped,
  lost}`, a bounded step history and idempotency keys (same key and body: the same launch; another body:
  `400 invalid`); ended launches are pruned after 7 days (at most 500 kept).
- **Verb `launch` and scope `sessions:launch`**: grants may allow `launch` for their projects; app tokens may carry
  `sessions:launch`.
- **Nodes and placement**: the hub keeps a registry of connected `hub node` daemons per machine owner and places
  each launch on one of the user's own nodes (runtime, harness, workspace root, a service spoke announcing
  `launch`, `placement.machine` and labels as `require` or `prefer`, free slots), oldest first, under a per-user
  lease so several hub processes never place the same launch. Per-user caps in `hub.json agents.launches`
  (`maxQueued` 50, `maxActive` 4, `perHour` 60 by default).
- **Spoke launch creates**: the OpenCode service spoke announces `launch` and creates a launch's session (with its
  agent and model) only in a directory under the node's workspace roots, which it reads from `node.json` beside its
  config.
- **`hub node`** (packages `@huynle/hub-node` and `@huynle/hub-runtime-sdk`): the per-machine daemon, configured by
  `node.json` (`workspaceRoots`, `labels`, `slots`, `memoryMB`) and connecting with the machine token it reads,
  read-only, from the spoke's `config.json`. Its host runtime makes worktrees at `<repo>/.worktrees/<branch>`
  (reused when the branch already has one), checkouts and clones, all resolved through symlinks under the roots;
  git runs without a shell, only over https and ssh, without prompts or inherited `GIT_*` settings, with time
  limits and cancellation. Cleanup never forces: it keeps reused workspaces, checkouts, roots, workspaces another
  launch made (a marker in the git directory), uncommitted changes and unpushed clones. It reconnects with backoff,
  waits 30 minutes between tries on a hub that does not serve nodes, and stops when its machine is revoked;
  launchd and systemd unit templates in `scripts/`. Runs on Bun and Node.
- **Launch engine**: each placed launch is prepared on the node, created through the machine's service spoke, given
  its roles, its name and the hub's primer, then prompted once, and runs. It ends `idle` only after its prompt was
  seen working and the session then stayed idle (no blockers, asks or open Decisions) for 30 seconds; `asked` also
  ends `needs_user`; `never` only by a stop or `end.timeout`; a session unreported for 10 minutes, or a node gone
  while provisioning, ends `lost`. At the end the hub stops the session when needed, collects artifacts (branch,
  head, commits, dirty) and asks the node to clean up (later, when the node is away). A restarted hub re-places
  queued launches, continues provisioning ones from their last step and watches running ones again.
- **Launch API**: `POST`/`GET /api/agent/launches` (`?state=`, `?label=k=v`), `GET`/`DELETE
  /api/agent/launches/:id` (`410 gone` once ended), for users, app tokens with `sessions:launch` and sessions through
  their act token, each under a grant with verb `launch` covering the repo (users need none); the kill switches
  pause apps and sessions (`423`); apps and sessions see and stop only their own launches; every launch and stop is
  audited. Launch labels show on read routes and filter lists; every change is an SSE `launch` event and a `launch`
  watch event; the welcome announces `launches`.
- **Webhooks**: `POST`/`GET /api/agent/webhooks`, `GET`/`DELETE /api/agent/webhooks/:id` for users (all of theirs)
  and app tokens with `sessions:launch` (only their own, and only events of launches they started). Each launch
  change (`launch.queued`, `launch.provisioning`, `launch.running`, `launch.ended`) is POSTed as a CloudEvents-style
  JSON body, signed with the registration's `whsec_…` secret (HMAC-SHA256 of `<t>.<body>`), from a durable outbox:
  at least once, deduplicated, retried with backoff for about 8.5 hours. Targets must be `https://` on public hosts,
  checked again (re-resolved) before every send, with no redirects, a 10 s timeout and a 64 KiB response cap;
  `hub.json agents.webhooks.allowPrivate` admits `http://` and private hosts for self-hosted receivers. Push
  targets share the same public-URL checks.
- **Clients**: the SDK gains `hub.launches.create/list/get/stop` and `verifyWebhook` / `signWebhook` (constant-time,
  5-minute tolerance, several secrets while rotating); the CLI `hub launch` (every spec field as a flag;
  `--prompt -` reads stdin), `hub launches list/show/stop` and `hub node run/install/uninstall/status` (install
  writes the unit and prints the commands that load it; it never runs them); `hub mcp` adds the tools `launch`,
  `launches`, `launch_show` and `launch_stop`.
- **Tests**: `test/e2e-phase4.test.ts` runs a hub, a fake OpenCode service spoke and a real `hub node` (host runtime)
  on temporary git repositories: `hub launch` through every state into a real worktree with name, role, labels,
  primer and prompt, the idle end with artifacts and the worktree removed, signed webhooks checked with
  `verifyWebhook`, idempotent keys, `maxActive`, app tokens with and without a launch grant, the kill switch, a
  session's shell token refused, tenancy and a node lost while preparing. Opt-in against a real
  `opencode serve --service`: `HUB_IT_OPENCODE=1 bun test test/e2e-phase4-live.it.test.ts` (the launched session
  runs in the node's worktree and the model receives the prompt).

### Sandboxed launches

- Launches can run in OpenShell sandboxes (`runtime: {kind: "openshell", profile}`, clone workspaces only): the node
  clones on the host, creates a labelled sandbox in the OpenShell workspace `hub` with a deny-by-default policy,
  moves code in and out as git bundles, starts the harness from the sandbox image and collects the work into the
  host clone ([docs/launches.md](docs/launches.md#sandboxed-launches-openshell-runtime)).
- Launch-bound tokens (`hlt1`) let a sandboxed plugin connect for one launch only; the hub keeps such connections
  out of service selection, closes them when the launch ends and gives their sessions no act tokens.
- The plugin's launch-bound mode reads `$HUB_LAUNCH_CONFIG` (or `/sandbox/.hub/config.json`) and never enrolls,
  starts a local hub or writes config.
- node.json `openshell` section (`enabled`, `gateway`, `image`, `profiles`); the node announces the `sandbox`
  feature, reports its sandboxes after a restart, and falls back to `host` when the CLI cannot be used.
- Profiles compile to OpenShell policies (hub, optional git remote, extra endpoints, only for the harness binary);
  profiles asking for mounts or CPU/memory limits are refused.
- The sandbox image (`packages/runtime-openshell/image/`) with start and entry scripts and an upload fallback.
- `hub node openshell check [--json]` reports whether a node can run sandboxed launches.

### More harnesses

Claude Code, Codex and terminal agents described by a preset connect to the hub next to OpenCode, each through a
spoke that announces exactly what it can do ([docs/harnesses.md](docs/harnesses.md)), and new harness spokes have
an SDK, a test kit, a conformance suite and a scaffold ([docs/spoke-sdk.md](docs/spoke-sdk.md)).

- **Protocol** (still version 1, compatible both ways). Core ops (`turn`, `steer`, `interrupt`, `stop`,
  `permission`, `form`) are announced features for non-OpenCode hellos; OpenCode hellos keep implying them.
  `opencodeVersion` is optional for other harnesses. The harness event subset (`HARNESS_EVENTS`,
  `harnessEventProblem`) fixes which forwarded events another harness's spoke may send and their shapes, including
  `session.execution.interrupted {inferred: true}` for interruptions the harness never reported and
  `session.inbox.delivered {origin}`. New feature `turnEvents` (every turn end is the harness's own). The harness
  preset schema (`HarnessPreset`, `presetProblem`): data only, an argv without shell syntax, delivery `paste`,
  evidence `screen`, built-in names reserved.
- **Hub.** One service spoke per machine and harness (`serviceFor(machine, harness)`): a Claude Code or Codex
  service never hides the OpenCode one. Launches and placement use the service spoke of `spec.harness`. Ops a spoke
  did not announce are refused before they reach it: agent API `422 unsupported {feature, harness}`, console `409`
  code `unsupported`, CLI exit 7, a launch fails with the reason; an escalated permission Decision for such a spoke
  closes as `unsupported`. Events from non-OpenCode spokes are validated against the subset (invalid ones dropped
  with a rate-limited warning). Idle by real evidence trusts `native` and `hooks`, and `rpc` only with
  `turnEvents`; after an inferred interruption it waits 5 s.
- **Console.** Controls follow each process's announced features (OpenCode unchanged); other harnesses' sessions
  show an evidence badge (Hooks, RPC, Screen, Unknown), and delivery labels never claim more than the spoke can
  confirm (hooks and screen: queued). A `409 unsupported` answer shows a toast naming what is missing.
- **Claude Code** (`packages/claude-code`). `hub claude [claude args…]` runs Claude Code with the hub plugin through
  `--plugin-dir` (never editing `~/.claude`) and starts the per-user daemon (`hub claude-code daemon`, evidence
  `hooks`) on a Unix socket in a private directory. The hook bridge (`hub claude-code hook`) fails open. Sessions
  are `ses_cc<uuid hex>`; tool names map to hub actions (Bash → `shell`, Edit/Write → `edit`, Read → `read`,
  `mcp__s__t` → `s_t`). Permissions wait for the hub in the PermissionRequest hook (`HUB_CLAUDE_PERMISSION_WAIT`,
  default 120 s; 0 reports only), racing Claude Code's own dialog; deny reasons reach the model. Messages arrive at
  the next tool boundary or prompt (`queued`), and an idle session is woken through an asyncRewake Stop hook
  (`turn`, framed as a system notification); `hub claude -p` turns that hook off. Stop ends the running turn at its
  next tool hook (denying the pending call). Esc interruptions are inferred from the next prompt or notification.
  Session tokens reach the Bash tool's shells through the SessionStart env file; act verbs go through the plugin's
  `hub` MCP server, with the act token kept in the daemon. Prompt references are attached as context. With the
  `claude` CLI found, the daemon also runs hub launches headless (`-p --input-format stream-json`) in node
  workspaces, taking turns and interrupts there.
- **Codex** (`packages/codex`). `hub codex [codex args…]` runs Codex with its shared app-server daemon on for that
  run (`--enable daemon_auto_start`; `~/.codex` is never written) and starts the per-user spoke (`hub codex-spoke
  serve`, evidence `rpc`, `turnEvents`). The spoke attaches to the daemon's threads (TUI sessions included) as one
  client among others, and runs its own `codex app-server` over stdio for threads the hub starts. Sessions are
  `ses_cx<thread uuid hex>`. Turns (`turn/start`), steer (`turn/steer`), interrupt and stop (`turn/interrupt`),
  approvals (first answer wins; `gone` when the TUI answered first), messages (`turn/steer`, `turn/start`, or
  `thread/inject_items` without waking; each message once, since Codex's queue does not deduplicate) and launches
  (`thread/start`). Settings `HUB_CODEX_BIN`, `HUB_CODEX_DAEMON_SOCKET`, `HUB_CODEX_CONFIG`.
- **Presets** (`packages/preset`). `hub preset list | check | run` with the official presets `aider` and `goose`:
  the harness runs in a new pane on a private tmux server (`-L hub-preset`; your own only with `--current`), prompts
  and messages are pasted (answered `timeout` and `queued`: never confirmed), stop and interrupt send Ctrl-C, and
  nothing but the native session ID and the pane's liveness is read off the screen. Never permission, form or
  steer; never idle. Sessions are `ses_pr<uuid hex>`.
- **Services.** `hub claude-code install | uninstall [--dry-run] | status` and `hub codex-spoke install | uninstall
  [--dry-run] | status` write a launchd agent or systemd user unit for the daemon and the spoke from the templates
  in `scripts/`, like `hub node install`: the load commands are printed, never run.
- **Nodes and launches.** The host runtime reports the harnesses it offers: `opencode` always, `claude-code` when
  the `claude` CLI is found (`HUB_CLAUDE_BIN`, else PATH), others through node.json `harnesses` (`{"codex": true}`,
  `{"claude-code": false}`). `hub launch --harness claude-code | codex` places launches on such nodes
  ([docs/launches.md](docs/launches.md#harnesses)).
- **Spoke SDK** (`packages/spoke-sdk`, shipped inside `@huynle/hub`): the connection, enrollment, session tokens,
  `DeliveryLedger`, prompt envelopes and references extracted from the OpenCode spoke (its files re-export them);
  reversible session ID mapping (`hubSessionID`, `nativeSessionID`); `buildHarnessHello`; and `HarnessSpoke`, which
  announces exactly the ops it has handlers for, refuses the rest and unknown sessions, sends validated events and
  the sessions frame, keeps tokens apart in memory and admits each message once.
- **Testkit** (`packages/testkit`, development only): a fake hub and spoke client, a stub model server (OpenAI chat
  completions, Anthropic Messages, OpenAI Responses; text and tool calls), a deny-all proxy for live harness tests,
  and the harness driver protocol v1 (`serveDriver`, `spawnDriver`).
- **Conformance** (`packages/conformance`, development only): `hub-conformance spoke --driver "<command>"` runs a
  spoke through its driver against a recording hub and checks the hello, feature honesty, events, deliver
  idempotency and modes, permission replies, token hygiene, reconnect and frame limits (table or `--json`).
  OpenCode, Claude Code, Codex and preset spokes all pass; a reference spoke has one broken variant per check.
- **Scaffold**: `bun packages/spoke-sdk/scaffold.ts <name> <dir> [--namespace xy]` writes a minimal `HarnessSpoke`
  spoke and its conformance driver for a new harness; the output passes the conformance suite as written.
- **Tests**: `test/e2e-phase7.test.ts` (every spoke on one machine, honest delivery, acting, unsupported answers,
  claude-code and codex launches, tenancy) and `test/e2e-phase7-conformance.test.ts`; opt-in live tests against the
  real CLIs with stub models, throwaway config dirs and a deny-all proxy (`HUB_IT_CLAUDE=1`, `HUB_IT_CODEX=1`).
- **Docs**: [docs/harnesses.md](docs/harnesses.md) (support matrix, evidence levels, setup, known limits, threat
  model) and [docs/spoke-sdk.md](docs/spoke-sdk.md) (writing a spoke, the event subset, conformance, testkit).

### Cluster mode

The hub can run as several pods behind one load balancer, sharing Postgres and Valkey (or Redis), with no sticky
sessions and rolling updates without downtime ([docs/cluster.md](docs/cluster.md)). The single-process hub is
unchanged (its files stay byte-identical) and remains the default.

- **Configuration**: `HUB_DATABASE_URL` (`postgres://`) and `HUB_VALKEY_URL` (`redis://`, `rediss://`, `valkey://`,
  `valkeys://`), or hub.json `cluster {database, valkey}`; both or neither. `HUB_POD_ID` names the pod (default the
  hostname). Cluster mode requires `HUB_TOKEN_KEYS` (shared by every pod) and `HUB_AUTH=oidc`, and refuses pairing
  mode. The URLs are never logged; a readable hub.json's URLs with a password are ignored.
- **Shared state**: users, machines, devices, settings, push subscriptions, the audit log and agent data live in
  Postgres (`hub_state`, `hub_claims`, `hub_schema`); pods cache them, tell each other what changed and reload every
  30 s; writes are version-checked. Codes (pairing, login, link, enrollment), OIDC sign-in state, rate limits, push
  cooldowns and answered-request markers live in Valkey, so a code issued on one pod works on another. No new
  dependencies (Bun's own Postgres and Redis clients).
- **Routing across pods**: each pod records its spoke and node connections in Valkey and serves requests for them
  on `pod.<id>.rpc`; a request for a session on another pod is forwarded there (tenant checked again by the owning
  pod). Every pod sees every connection through a shared cluster view, so status, `/api/agent/*`, placement and turn
  routing work wherever a request lands. Pods re-check their sockets every 30 s and close those of revoked machines
  and disabled users.
- **Live events across pods**: console SSE (`/api/events`), `/api/agent/watch`, message and launch feeds reach every
  pod; events (except streamed text) go to a per-user Valkey stream, so `Last-Event-ID` resumes on any pod.
- **Leader jobs**: decision deadlines, message re-wakes, the launch supervisor and the webhook sender run on one pod
  at a time under fenced 15 s leases, failing over when a pod drains or dies; a session's turn and message flush take
  cluster-wide leases.
- **Draining and readiness** (every mode): `GET /readyz` answers 503 while draining and, in cluster mode, when
  Postgres or Valkey does not answer within 2 s (`/healthz` stays the liveness check). SIGTERM drains: new
  WebSockets are refused (503, `Retry-After`), spokes and nodes get `bye {reason: "draining", retryAfterMs}` and
  close code 4006 once their requests are answered, leader leases are released, SSE streams end with `retry:`, and
  requests in flight get up to 50 s. A second signal stops at once (exit 1); SIGINT stops without draining.
  Protocol (still version 1): `bye.retryAfterMs` (0–300000, optional); the OpenCode spoke and `hub node` reconnect
  after a random 0–`retryAfterMs` instead of their usual backoff.
- **`hub-server migrate`** applies the Postgres schema (idempotent, under an advisory lock); pods never migrate and
  refuse an older schema. **`hub-server import --state <dir> [--dry-run] [--force] [--print-token-keys]`** copies a
  single-process hub's state (state.json and agent data) into Postgres: idempotent, conflicts reported (overwritten
  only with `--force`), machines and devices keep their tokens; `--print-token-keys` prints `token-keys.json` as the
  `HUB_TOKEN_KEYS` value, which is never stored.
- **Kubernetes manifests** in `deploy/k8s/`: Deployment (2 replicas, topology spread, `HUB_POD_ID` from the pod
  name, `/readyz` and `/healthz` probes, `preStop` sleep, 60 s grace period, non-root, read-only root filesystem),
  Service, Ingress example and Traefik notes for long WebSocket/SSE timeouts without buffering, Secret template,
  PodDisruptionBudget, migrate Job, NetworkPolicy, Kustomization and a Flux example with SOPS; validated offline
  (`kubeconform -strict`, `test/deploy-k8s.test.ts`).
- **Tests**: backend contract suites run against memory and file backends by default and against real Postgres 16
  and Valkey 8 containers with `HUB_IT_CLUSTER=1`; in-process multi-pod suites on shared memory backends run in
  the default CI.

### Other changes

- **Auto-name**: let OpenCode name a session with its Title agent, from the console. **Auto-name** in every
  session `⋯` menu (table, phone list, sidebar, session title) and a ✨ button next to the inline rename field;
  the title shows "Naming…" until OpenCode answers, then "Renamed to …" or "OpenCode kept the title".
  `POST /api/sessions/:id/rename {auto: true}` → spoke op `autoName`, which calls `session.update` with an empty
  title on the process's own server (the plugin API's update would set an empty title) and waits up to 20 s for
  `session.renamed` (202 `{pending}` after that). Spokes now list their optional features in the hello
  (`features: ["autoName"]`); a process with an older plugin gets "Update the Hub plugin to use Auto-name"
  instead of a request it would drop.

- **Question answers no longer lost**: a question card in the console kept its answers in components that were rebuilt
  whenever any live update arrived (every session change sends a fresh catalog), so choices and typed text were
  silently reset and Submit sent every question to OpenCode as "Unanswered". Cards are now keyed by request ID and
  fields by key, and a question form with nothing chosen is refused with a hint (Dismiss skips it).
- **Voice mode: progress cues play as loud as the spoken replies.** Short cue phrases ("On it.", "Hang on." …)
  came out of TTS up to ~4 dB louder or quieter than replies (measured: −15 to −22 LUFS against replies around
  −19.5). Each phrase is now normalised while it is prefetched: measured (BS.1770 gated loudness), trimmed of
  silence beyond 80 ms (cues start sooner), gained to the replies' loudness with peaks limited to −1 dBFS, and
  cached as WAV. The target is the running median of measured replies per TTS voice (completed sentences decoded
  when idle; −19.5 LUFS until then). The cue cache moved to `hub-cues-v2`, so old un-normalised cues are fetched
  again once. Both audio elements play at volume 1. Measured with the default voice: cue spread around the reply
  median went from −2.0…+4.8 dB to within 0.1 dB; normalising adds ~8 ms (max 60 ms) per phrase at prefetch and
  nothing at play time.
- **No more false "finished" notifications; pick exactly which notifications each device gets.** "Finished"
  fired on every turn of a root session, but in OpenCode v2 each background subagent that completes starts a
  short continuation turn in its parent (a synthetic message), as do steering and Voice turns: in a real session
  82 of 114 "finished" pushes came while subagents were still running. It also fired while you were looking at
  the session. Now (see [docs/notifications.md](docs/notifications.md)):
  - **All done** (new, on by default) replaces it: once per run, when the root's last turn succeeded and the
    whole tree stayed settled for 15 s (no subagent or shell job running, no question or permission pending,
    no hub turn). A continuation turn within the 15 s cancels it.
  - New per-device kinds, off by default: **Turn finished** (the old every-turn behaviour), **Stopped**
    (shutdown/inactivity), **Retrying**, **Subagent finished/failed**, **Script finished/failed** (background
    shell or terminal exit code), **Long tool finished** (≥ 30 s). Failed (with the reason) is on by default.
  - Titles say the kind: "KVM Rewrite · All done", "· Subagent S3 macros finished", "· Script exited 1";
    progress kinds replace each other quietly.
  - Run notifications are no longer sent while a device shows the session (questions and permissions are).
  - Settings → Notifications: kinds grouped (Needs you, Session, Subagents, Scripts and tools, Voice, Activity
    digest) with a one-line description each, a "You'll get: …" summary, and a test of a chosen kind
    (`POST /api/push/test {kind}`).
  - Prefs migrate on start: `finished: true` becomes All done (not every turn); failed, activity and the rest
    are kept; new kinds start off. The API still accepts `finished` (→ `done`) and `blocked`.

- **The console keeps a session's conversation in order**: subagents no longer bunch together at the bottom of
  the conversation, and thoughts no longer jump below the text or tools that came after them. Rows used to be
  sorted by their timestamps, which come from different clocks (OpenCode's message and part times, the hub's,
  the phone's), and a finished subagent got the time the page loaded. Now:
  - Every timeline row from the spoke carries `pos`, its position in the session (message order, then part
    order), and the console orders rows by it. Tool rows of `subagent`/`task` carry `childSessionID` (from the
    tool's metadata, else its output) and `title`; tool rows `callID`; text rows `ordinal`.
  - A subagent row stands in place of the tool call that spawned it, also after it finished and after a reload.
    When the spawn is in an older page that is not loaded yet, the subagent shows at the top of the loaded
    history and moves to its spawn when that page loads.
  - Live thoughts, text, tools, sent messages and spawned subagents appear in arrival order after the history,
    and when the stored rows arrive (reconnect) they replace the live ones in place.
  - The spoke forwards a subagent tool's child session (`session.tool.progress`, sent as a compact
    `session.tool.called {id, childSessionID}`, which older hubs accept); SSE `activity` items carry
    `childSessionID` and `delta` events the text part's `ordinal`. All new fields are optional: older spokes
    and hubs keep working (rows without `pos` keep the order of their pages).

- **Sessions open on their newest messages, and older ones load while you scroll up**: the console used to load
  a conversation oldest first, 200 rows at a time and at most 2000 rows, before showing anything, so a long
  session opened slowly and could miss its newest messages. It now asks for the newest 80 rows (one request),
  shows them at the bottom, and loads the page before them as you get near the top ("Loading earlier
  messages…", then "Beginning of conversation"; a failed page offers Retry). What is on screen stays in place
  while older rows are added above it, and live replies still arrive at the bottom. Measured on a mock session
  with ~1000 rows: 1 request and 13.7 KB instead of 6 requests and 178 KB, and only 80 rows rendered at first.
  - API: `GET /api/sessions/:id/timeline?limit=N&order=desc` returns the newest rows with an `older` cursor;
    `?before=<older>` returns the page before it. Cursors are row keys, so they stay valid while new messages
    arrive. The forward `?cursor=` mode is unchanged. Consoles talking to older spokes fall back to loading the
    whole history as before.
  - The spoke reads OpenCode's history once per first page and serves the following pages from a short-lived
    per-session cache (30 s, dropped on any event of the session), instead of reading the whole history again
    for every page.
  - After a reconnect that missed events, the console reloads the newest page. It keeps the older pages already
    loaded when the new page overlaps them; otherwise it starts over from the newest page.

- **Voice mode tells the truth with the screen off**: Android Chrome usually stops the microphone when the
  screen turns off, while the "Voice mode on · listening" notification stayed. Voice mode now notices (no
  audio frames for 1.5 s, the mic track muted or ended, the AudioContext suspended) and says so: the Voice
  bar shows "Paused — mic stopped by the phone (screen off). Unlock to resume.", the notification turns into
  "Voice mode paused · unlock to talk" (End and Open kept; updated at once), the lock-screen controls show
  paused and a short falling tone plays. On unlock it resumes the audio, asks for the microphone again if
  needed (or offers "Tap to start Voice mode"), retries with backoff and plays a rising tone; it says
  "listening" only once audio arrives. While hidden it keeps trying (audio resume, silent loop). The Settings
  text for "Keep listening when the screen is off" now says it is best effort.
- **Smoother live connection**:
  - **Resume instead of reload**: every SSE message carries an id; a console that reconnects (phone unlocked,
    app switched back, network blip) sends `Last-Event-ID` (or `?last=`) and the hub replays what it missed from
    a per-user buffer (last 2000 events or 5 minutes, one fresh catalog for any catalog changes). When the gap
    is not covered (hub restarted, too long away) it sends the catalog and a `resync` marker, and the open
    session refetches its conversation, status and details.
  - **No bandwidth while you are not looking**: a page hidden for 30 s closes its stream (Voice mode keeps it
    open); showing it again (or coming back from the back/forward cache) reopens it at once with the last id. A
    stream silent for 45 s (no message, no heartbeat) is reopened. Heartbeats are now `event: ping`.
  - **Lite streams**: the console asks for `?lite=1&session=<id>`: streamed text and reasoning only for the
    session on screen (everything for Voice mode). Measured on an idle hub: ~50 bytes/min after the first
    catalog; a busy session over a minute: 9.3 KB full vs 7.4 KB lite (the rest is catalogs, status and activity).
  - The top bar shows "Reconnecting…" and then "Updated" for a moment instead of a reload.
- **Activity updates** (opt-in push, per device; Settings → Notifications shows a hint until it is on): one
  quiet, self-replacing notification per session with what happened — subagents started/finished, tools of
  30 s or more, background shells and terminals that ended (with exit code), the session going idle — at most
  one per session per interval (1–60 minutes, default 5; "3 tools · explore finished · Finished"). Quiet
  hours and muted sessions apply; nothing while a device shows the session.
- **Running detection**:
  - Sessions running a script are working: the spoke forwards OpenCode's `session.status` (busy/retry/idle) and
    the shells and terminals sessions start (compact: id, session, command ≤ 200 chars, status, exit code). A
    session works while its run, a busy or retrying status, or a running shell/terminal lasts.
  - **Retrying** shows with its reason ("Retrying (attempt 2): Rate limited").
  - **Background jobs**: a count next to the status in the table and sidebar, "· 1 job" in the session header,
    and a **Jobs** card in the rail (command, running time, exit code for a minute after it ends).
  - **Seeding**: on connect, after a hub reconnect and after OpenCode's event stream comes back, the spoke asks
    its own server what runs (`session.active`, `shell.list`) so sessions already running show as working.
- **Nicer replies**: the console renders more of the Markdown agents write, still as elements (never raw HTML;
  HTML in a reply shows as text):
  - **GFM tables** (column alignment, formatting in cells, scrolling sideways on narrow screens), **nested lists**
    (by indentation, numbered and bulleted mixed), **task lists** (disabled checkboxes), list items with several
    paragraphs or a code block, headings, lists and code **inside quotes**, **setext headings**, `~~strike~~`,
    `==highlight==`, **autolinks** (bare http(s) URLs and `<url>`), line breaks (a single newline in a paragraph
    is a break, as agents write), backslash escapes, and images as a link named by their alt text (never loaded).
  - **Code blocks**: language label, **Copy** (with "Copied"), **Wrap** toggle (else long lines scroll), and
    syntax highlighting for TypeScript/JavaScript/TSX, JSON, bash/sh, Python, Go, Rust, YAML, diff (added and
    removed lines colored), SQL, CSS, HTML/XML and Markdown: a small built-in tokenizer loaded with the first
    code block (3.3 KB gzipped chunk; the main chunk grew 5.7 KB gzipped).
  - **While a reply streams**, the block being written closes what it opened (`**bold` shows bold, a table
    header alone is a table, a link whose address is still arriving shows its label), and blocks update in place
    instead of being rebuilt.
- **Text size and pinch-to-zoom**: all console text sizes follow one `--font-scale` (80–180%). Set it in
  **Settings → Appearance → Text size** (with Reset), or **pinch** the conversation or the session list: two
  fingers on a phone, a trackpad pinch on desktop (ctrl+wheel, Safari gesture events). The pinch only changes the
  text there; elsewhere (and ⌘+/⌘−) the browser zooms as before. Kept per device and applied before the first
  paint. On touch screens text fields are at least 16 px, so iOS no longer zooms in when one gets focus.

- **Voice mode hears you, not the room**:
  - **On-device speech detection**: Silero VAD v5 (MIT) runs in the browser through onnxruntime-web (MIT; wasm,
    single-threaded, in a Web Worker) on 16 kHz, 32 ms chunks: speech starts at probability ≥ 0.6 for 250 ms and
    ends after 350 ms below 0.35. Typing, fans, clatter, beeps and hum no longer start a turn. The energy
    detector stays as a pre-gate (quiet chunks skip the model) and as the fallback while the model loads or if
    it fails (logged once). The model and wasm load when Voice mode first starts, as hashed assets outside the
    main JS chunk; the hub now serves `/assets/*` with `cache-control: public, max-age=31536000, immutable`,
    `.wasm` and `.onnx` with their types, and compresses big hashed assets (Brotli or gzip) when accepted.
    Measured about 1 ms per 32 ms chunk; segments end within one chunk of the energy detector.
  - **Echo guard**: a mono mic track with the browser's echo cancellation, noise suppression and auto gain; while
    a reply or a progress cue plays (and 400 ms after) a barge-in needs probability ≥ 0.85 and 8 dB more energy.
  - **Settings → Voice → Mic sensitivity** (Low / Normal / High, per device, applies at once): model thresholds,
    speech needed to start, and the energy margins.
  - **Noise transcripts dropped**: "Thank you.", "you", "Thanks for watching!", "Subtitles by …", "[Music]",
    punctuation-only and repeated-word transcripts, and one or two words from under 400 ms of speech (unless a
    command or answer like "yes", "no", "stop", "go ahead", "cancel that") never reach the agent; the Voice bar
    shows them dim for a moment ("ignored: …").
  - **Whisper's no-speech rating**: with a Whisper model the hub asks for `verbose_json` and drops segments with
    `no_speech_prob` > 0.6 (falls back to plain requests for providers that refuse it).

- **Voice mode: varied progress cues**: instead of the same "Working on it.", "Started a subagent." and
  "Still working." every time, each cue has several short, natural variants ("On it.", "Give me a sec.",
  "I'll hand that off.", "Still on it.", "Almost there." …). A shuffle-bag picks them: every variant once
  before any repeats, never the same one twice in a row, preferring one whose audio is already cached (else
  the short tone, as before). All variants are prefetched when Voice mode starts, 2 at a time, one of each
  kind first, and cached per TTS voice as before; ending Voice mode cancels a prefetch still running (aborts
  its requests), so it never holds the browser's connections.

- **Voice mode: streaming speech and several tasks at once** (release 2 of 3):
  - **Replies play while their audio downloads**: `/api/speak` passes the TTS provider's MP3 through as it
    arrives (nothing is buffered on the hub; a cancelled request aborts the upstream one), and the phone plays
    each sentence through MediaSource while it is still downloading. Browsers without MP3 in MediaSource (some
    iOS Safari versions) play each sentence once complete, as before. Prefetching two ahead, barge-in, Voice
    speed and the cached cue phrases work as before. New turn step `hub-voice:first-byte` (the Voice bar tooltip
    shows "first byte" between "first reply" and "audio").
  - **Parallel workers**: the voice agent starts one background worker per independent request, all in the same
    turn ("check the deploy and update the changelog" → two workers), names each in a few words ("Deploy
    check"), and keeps sending follow-ups for a running task to the same worker.
  - **Task board**: every voice turn carries a live list of the agent's workers (title, sessionID, working /
    blocked on what / done with its result / failed with the reason / stopped, and for how long; at most 8, of at
    most 200 characters each), so "what's running?" or "how's the deploy going?" is answered without a tool call.
  - **Stop one task by voice**: new tool `hub_task_stop` ("cancel the deploy one" → that worker and what runs
    below it; "stop all the workers" → `all: true`). It only reaches workers of the session calling it, never the
    voice agent itself. The phone's stop words still interrupt the agent's turn at once.
  - **Announcements**: with several workers in play, a finished worker's result starts with its task's name
    ("Deploy check finished: …"); a result the voice agent already said is not read again; a failed worker is
    announced once with its reason, a permission request or question once ("Cleanup needs your permission.").
    Announcements queue after the sentence playing.
  - **Barge-in** between two sentences of a reply still being written now also drops the rest of that reply
    (before, only a reply that was playing went quiet). Barge-in never interrupts the agent or its workers.
  - **Fix**: Voice mode's progress-cue clock and the endpointer's hold timer called `setTimeout` as a method,
    which browsers reject ("Illegal invocation"): progress cues could stop working and an unfinished-sounding
    utterance was never sent after the hold.

- **Faster Voice mode** (release 1 of 3):
  - **Speak while it writes**: the hub cuts a root reply's streamed text into sentences and sends a `say` per
    completed sentence (new `seq`, counted per text part from 0) right after its delta; `session.text.ended`
    flushes the rest, so the first sentence plays while the agent is still writing instead of after the whole
    reply. Code blocks are one piece (spoken as "(code omitted)"); abbreviations, decimals and file names stay
    together. One mechanism: each sentence is sent once, also with several processes reporting the session; an
    interrupted run or Voice mode ending drops the unspoken rest. A subagent's final result is spoken as before
    (one `say` without `seq`). The phone plays says in order, once, and synthesizes up to two sentences ahead;
    barge-in also silences the rest of the reply it interrupted. The push for a reply nobody watches is sent
    once with the whole text. Clients that ignore `seq` still get each sentence's text.
  - **Instant acknowledgement**: the "heard" tone plays the moment you stop speaking (when the segment goes to
    transcription), not when the agent receives the utterance; it does not play twice. Typed text in Voice mode
    still gets it on delivery.
  - **"Working on it." after 2.5 s** (was 5 s), counted from the end of your speech, and progress cues are
    event-driven (one timer for the next deadline instead of a 1 s poll).
  - **Cue phrases ready at once**: "Working on it.", "Started a subagent." and "Still working." are synthesized
    in parallel when Voice mode starts and kept in the browser's Cache Storage per TTS voice (provider, model,
    voice, speed, server), so later sessions need no synthesis; a ready phrase starts playing immediately, and
    one not ready yet plays a short tone instead of arriving late.
  - **Tighter turn-taking**: a segment ends after 350 ms of silence (was 550 ms), speech must last 300 ms to
    count (was 250 ms), and an unfinished-looking transcript is held 0.8 s (was 1.5 s); all in `VOICE_TIMINGS`.
  - **OpenRouter speech-to-text** uploads the audio as an OpenAI-style multipart file (documented by
    OpenRouter) instead of base64 JSON: a third less to send, no encoding.
  - **No model lookup per utterance**: the spoke remembers each session's model (from OpenCode's
    `session.model.selected`, its own switches and lookups) instead of asking OpenCode on every utterance with a
    Voice model set; it asks again after its event stream reconnects.
  - **Turn timing**: `performance.mark`s for speech end, transcript, accepted, first say and first audio, and the
    Voice bar's state tooltip shows "last turn: 1.8 s to first audio" with the steps.

- **Resizable sidebar and Details rail** (desktop): drag the thin handle on the sidebar's right edge or the
  rail's left edge (it lights up on hover and while dragging). Sidebar 180–480 px (default 235), rail 220–640 px
  (default 260); both give way so the transcript column keeps at least 420 px, and are re-fitted when the window
  resizes. The handles are focusable separators: Arrow keys resize by 16 px (Shift: 64 px), Home/End jump to the
  minimum/maximum, a double-click resets the default. Dragging the sidebar well past its minimum collapses it (as
  ⌘B does) and expanding it restores the last width. Widths are remembered per device (`hub.panels` in local
  storage); phones keep the drawer and bottom sheet. Long session titles in the sidebar still end in an ellipsis,
  with the full title as a tooltip.

- **Rename sessions**: **Rename…** in a session's `⋯` menu (table, sidebar, phone list, session title menu), or
  a click on the session title in the top bar, edits the title in place (Enter saves, Escape cancels). The title
  is set in OpenCode itself (`session.update`), so terminals and other consoles see it; the console shows it at
  once (also while older catalog updates arrive) and reverts with a message if renaming fails. API: `POST /api/sessions/:id/rename {title}` → `{title}`
  (trimmed, 1–200 characters), through the owning process with a fallback to other processes that report the
  session; Voice-off sessions can be renamed too. New spoke op `rename`: a machine still on an older plugin
  does not answer it, so renaming its sessions fails after the 15 s request timeout until it is updated.
- **Archive sessions** (replaces Hide): **Archive** / **Unarchive** in a session's `⋯` menu, with **Undo**.
  Archived sessions leave the table, sidebar groups, Recents and Running on all your devices (synced through
  the view prefs and their SSE `prefs` event); the **Archived** chip (formerly Hidden; a saved Hidden filter
  opens Archived) lists them. An archived session that needs you still shows under **Needs you** so a question
  is not missed. Bulk: checkboxes in the table (and select all shown) with **Archive** / **Unarchive**, and
  **Archive inactive…** (more than N days without activity, 30 by default; not running, pinned or open in a
  terminal) after a confirmation with the count. Nothing is deleted and OpenCode is not changed: OpenCode has
  no archive API yet, so archiving is the hub's own (sessions archived in OpenCode itself are still never
  listed). Sessions hidden before are archived now: the stored list is the same `hiddenSessions`, which now
  holds up to 5000 sessions (`PUT /api/prefs/view`; other lists stay at 500), the oldest archives making room.
- **Composer**: a sent message (typed or dictated) no longer comes back into the input with a raw "Failed to
  fetch" under it when the connection of the turn's request drops after the hub took the turn (e.g. a proxy
  cutting the long request). If the session is running, the send counts as delivered: the input and the
  session's draft stay empty, a note says the connection was lost and the reply streams into the transcript.
  Only when the session never starts is the text put back (as for any refused send). Network-level failures
  of console API calls now read "Can't reach the hub: the connection dropped…" instead of the browser's
  "Failed to fetch".
- **Typed turns no longer hold a request open for the whole turn**: the console sends `POST
  /api/sessions/:id/turn` with `Prefer: respond-async`; a turn still running after 1.5 s is answered 202
  `{mode: "turn"}` and its result (failure notes, a reply that did not stream) arrives as a new SSE `turn`
  event. Before, the request stayed open until the turn ended, and proxies cut it (Traefik's default
  `readTimeout` is 60 s), which the console showed as "Failed to fetch". Quick results and refusals (busy,
  unknown session, spoke errors) answer as before; clients without the header keep the blocking answer.
- **Console**: table rows, sidebar rows and an open `⋯` menu no longer re-render (and close) when an unrelated
  catalog update arrives; unchanged rows keep their DOM.

## 0.6.1

- **GitHub installs**: an install without the built web app (`web/dist`, e.g. `opencode plugin add
  github:huynle/hub`) no longer starts a local hub that only answers 503: `/hub` → **Start local hub**
  (and opening the hub, and the automatic start) report that the web app is missing and how to get it
  (npm package, release binary, or `npm run build:web` in a checkout).
- **Push security**: `POST /api/push/subscribe` only accepts https endpoints on public hostnames. IP
  literals in loopback, private, link-local, CGNAT and ULA ranges, `localhost`, `*.local` and `*.internal`
  are rejected, and the host is resolved at subscribe time and rejected when it resolves to such an address
  or not at all (400). Push services (FCM, Mozilla, Apple, Windows) keep working.
- **Model overrides**: `PUT /api/sessions/:id/model-prefs` only accepts models (and variants) from the
  session's catalog; anything else is `400 Unknown model`, and a catalog that cannot be fetched is a 502
  instead of an accepted selection. Clearing a Voice model override switches the session back to the model
  it had before the first override (at the next turn boundary if it is running), unless you picked another
  model meanwhile.
- **State directory**: the hub no longer crashes with `EPERM` on a fresh volume whose mount root it does
  not own (a Kubernetes local-path PVC with `fsGroup`). When the state directory cannot be restricted to
  0700 but is writable, the hub logs a one-line warning and continues; state files are still written 0600.
  An unwritable directory still fails.
- **Permissions**: fixed "Permission request not found" when allowing or denying from the hub. OpenCode
  keeps pending permissions per location (directory), and the spoke replied through the first plugin
  instance of the process; it now replies through the instance of the location that holds the request.
  The hub tries every process that forwarded a request; a request nobody holds any more (answered in the
  terminal, expired) answers `409 {code: "gone"}` and its card goes away.
- **Questions**: forms from the agent (the question tool, any OpenCode form) are answered in the console:
  text, single and multiple choice (with your own answer), yes/no, numbers and links, with validation and
  Submit / Dismiss (`POST /api/sessions/:id/form`). A standalone server started by a TUI answers through
  that TUI (RPC `hub.formActions`).
- **Subagent sessions**: a subagent row opens the subagent's own page with a breadcrumb back to its
  parent, its own live output, status and permission/question cards, and a composer that steers it. The
  hub serves subagent sessions no process lists from their root's tree (same owner checks); a session is
  never nested under another user's session.

- **Console**: the All sessions table has no Voice column and no Voice on/off filter chips (saved Voice
  filters and sort are ignored). The session live in Voice (Voice mode in this browser, or a conversation)
  shows a small pulsing green dot left of its title in the table, the phone list and the sidebar
  (no animation with reduced motion); sessions that merely allow Voice get no badge. The row `⋯` menu
  says **Allow Voice** / **Disallow Voice**. The old session browser's "Voice on" filter is gone.

## 0.6.0

**OpenCode Hub is now Hub** (`@huynle/hub`): a harness-agnostic central hub that AI agent harnesses
connect to. OpenCode is the first supported harness; Voice is one feature (`/voice`), and `/hub`
configures the harness's hub connection. Everything from opencode-hub and opencode-voice keeps working;
see [Migrating from opencode-voice or opencode-hub](README.md#migrating-from-opencode-voice-or-opencode-hub).

- **Package and repository**: npm `@huynle/hub` 0.6.0, repository `github.com/huynle/hub`. Install with
  `opencode plugin add @huynle/hub`. The interim name `@huynle/opencode-hub` was never published to npm, so
  there is **no `@huynle/opencode-hub` shim**; `@huynle/opencode-voice` 0.6.0 re-exports `@huynle/hub`
  with a rename notice.
- **Commands**: the hub server command is `hub-server` (a bare `hub` would collide with GitHub's `hub`
  CLI); `opencode-hub` and `opencode-voice-hub` stay as aliases. Release binaries are
  `hub-<os>-<arch>[.exe]`; the image is `ghcr.io/huynle/hub`.
- **Plugin ids** `hub` and `hub.tui` (were `opencode-hub` / `opencode-hub.tui`); TUI command ids
  `hub.open` (`/hub`) and `hub.voice` (`/voice`) in the palette group "Hub". The RPC id stays `hub`, and the
  server still registers the legacy `voice` id. The TUI's commands come from a small registry
  (`src/tui-commands.ts`) so further `/<feature>` commands are one entry each.
- **Config and state**: `~/.config/hub/{config,hub}.json` and `~/.local/state/hub`. On first start, when
  the new location is missing, the `opencode-hub` copy is copied there, else the `opencode-voice` one
  (copy only, modes kept, the old copies never deleted, the `hub.pid` lock skipped; explicit paths skip
  it).
- **Env**: `HUB_SPOKE_CONFIG` is the new name of the plugin config path; `OPENCODE_HUB_CONFIG` and
  `OPENCODE_VOICE_CONFIG` still work with a one-time deprecation warning (newest legacy name wins). The
  other `HUB_*` names are unchanged, with the `VOICE_*` fallbacks as before.
- **Branding**: "Hub" in the console (title, sidebar, sign-in page), the installed app (manifest name and
  short name "Hub"), notifications, TUI toasts and dialogs, and the hub's logs (`[hub]` prefix). Prompts the
  hub sends carry `metadata.source: "hub"`; `"opencode-hub"` and `"opencode-voice"` are still recognized.
  The default VAPID subject is `mailto:hub@localhost`. Device cookies (`voice_device`, `voice_oidc`) and
  the `voice` agent are unchanged, so nobody is signed out.
- **New icon**: an original Hub mark (a central node in the console's accent joined by three spokes to
  satellite nodes) on the dark tile, as `icon.svg`, 192/512 px PNGs, a maskable icon, an Apple touch icon
  and a `favicon.ico` (16/32/48 px), also drawn inline next to the "Hub" wordmark in the sidebar and on the
  sign-in page. `scripts/gen-icons.ts` generates them all with headless Chromium.
- **launchd template** renamed to `scripts/io.github.huynle.hub.plist` (label `io.github.huynle.hub`).

Also in this release (listed as 0.5.1, unreleased, before):

- **New sessions, composer first.** `/new` is a big "Describe a task or ask a question" composer (with
  images) and a row under it: **Environment** (your machines; online first with process and OpenCode
  version, offline ones disabled; ✓ on the choice), **Project** (searchable Herdr workspaces and known
  folders), the folder's **branch**, and **Open in Herdr tab**. Submitting creates the session on that
  machine and sends the prompt as its first turn; the last environment and folder are remembered per
  device. The session rail's **Server** card is now a collapsible **Environment** card (machine and
  status, project, branch, where it is open), and every rail card collapses from its header (remembered),
  with MCP shown as **Connectors · N connected**.
- **`/hub` and `/voice` are separate commands.** `/hub` configures the hub connection: server URL and
  connection state, change the server (reachability checked) or use a hub on this computer, start the
  local hub, approval status, mode, this session on/off, pair a phone, open the hub in the browser.
  `/voice` has no menu: it sets up and connects first when needed, shares the session for Voice and opens
  it in the browser with Voice mode starting (`/s/<id>?voice=1` through a one-time sign-in link; the hub's
  `openLink` op takes `voice: true` and `/login` accepts `?voice=1`). When the browser needs a tap before
  it plays or records, the Voice bar shows **Tap to start Voice mode** instead of an error. "Talk on this
  device" is gone from `/hub` (use `/voice`).
- **"Voice mode on" notification.** While Voice mode is on, a silent persistent notification says which
  session and what Voice is doing ("API server · listening", updated at most every 3 s) with **End** (ends
  Voice mode through the page, or with no page open turns conversation mode off at the hub) and **Open**;
  it closes when Voice mode ends or the page unloads. The lock screen's media controls show "Voice mode on"
  and the session title, and pause/stop end Voice mode (before, pause muted listening). Without
  notification permission the Voice bar offers **Allow notifications**.
- **Notifications that arrive.** Settings → Notifications shows the real state of this device (permission,
  service worker, and whether this hub holds its subscription) and warns when nothing would arrive; **Enable
  notifications on this device** registers the worker and subscribes; the app re-subscribes by itself when
  permission is granted but the hub lost the subscription (e.g. after the hub moved to a new address), and
  the service worker follows `pushsubscriptionchange`. **Send test notification** (`POST /api/push/test`,
  only the caller's device, at most one per 10 s) reports where it went or the push service's status.
  Preferences can't be mistaken for working notifications any more: they say they apply once subscribed.
- **Personal notifications.** Separate toggles for questions, permissions, failed runs (split from
  finished), finished runs, hand-offs and Voice replies (0.5.0 prefs are migrated: blocked → question +
  permission, finished → finished + failed); quiet hours per device in its time zone; **Mute
  notifications** per session (⋯ menu, per user, `PUT /api/push/mute`). Questions, permissions and failures
  go out with high urgency and a one-hour TTL, stay on screen, vibrate and re-alert per session and kind; a
  permission shows what it is (fetched by the service worker, never in the payload) with **Allow once** /
  **Reject**.
- **Image attachments**: the composer's **+** button attaches images (file picker, which offers the camera
  on phones), as do paste and drag-and-drop; up to 4 per message, shown as removable thumbnails, and a
  message may be images only. The browser re-encodes each image before sending (longest side at most
  1600 px, JPEG with stepped-down quality, PNG kept for small transparent images; GIFs become their first
  frame; camera metadata such as location is dropped) so each stays under ~180 KB and all under ~700 KB of
  base64. `POST /api/sessions/:id/turn` takes `images: [{mime, data, name?}]` (validated by the hub and
  the spoke: at most 4, PNG/JPEG/WebP/GIF whose bytes match, ≤ 512 KB each, ≤ 750,000 base64 characters
  together) and the spoke passes them to OpenCode as inline (data URL) file attachments, for turns and
  steers alike. Utterances (Voice mode) stay text-only; a message with images sent while Voice mode is on
  goes as a typed turn.
- **Images in the transcript**: user messages show their image attachments as thumbnails, loaded on
  demand from the owner-scoped `GET /api/sessions/:id/timeline/messages/:message/files/:index`; other
  attached files show as named chips.
- **Fix: thoughts always expand.** "Thought for Ns" opens even when the provider stored no readable
  reasoning (Claude usually keeps only an encrypted signature) and then says so; live reasoning deltas go
  into the thought of the same message instead of a second, empty row when a session is opened mid-run.
- **Fix: speech model lists of OpenAI-compatible gateways.** `GET /api/settings/speech/models` answers
  `{models, note?}`: a gateway's full `/models` list is narrowed to speech-to-text or text-to-speech models
  (never chat, image, embedding, rerank or music models), the configured model is always offered first, and
  when nothing is labeled every model shows with a note. The pickers group models by provider.
- **Fix: Voice and Worker model menus.** The spoke listed models by their upstream `modelID` instead of
  OpenCode's catalog `id`, so models of gateway providers with aliases (e.g. `claude-opus-5-5` sent as
  `claude/claude-opus-5-5`) could not be selected or switched to. The menus now handle catalogs of hundreds
  of models (at most 100 rows rendered with a count, arrows + Enter, number keys only outside the search box so
  digits can be typed), have a Back button in the variant step, never hide every model when a catalog
  reports them all disabled, and report a failed save.
- **Fix: dictation and Voice mode stay with their session.** Stopping Voice mode while it was still starting
  (waiting for the microphone or the hub), or leaving the session meanwhile, left a hidden conversation
  listening that sent what the user said, including dictation in another session, to the first session. A
  start that is stopped now releases the microphone and turns conversation mode off again. Dictation is
  app-level: the text goes into the draft of the session where recording started (never sent), leaving that
  session while recording cancels it (a notice says so), and each session keeps its own unsent draft.
- **Voice mode is one app-level toggle.** The Voice button turns Voice mode on for the session (turning
  Voice on first when needed) and off again, and shows a pressed state while on. Only one session is in Voice
  mode at a time: turning it on in another session first turns the current one off (conversation mode off,
  microphone released, playback stopped). Voice mode keeps running while other sessions are viewed; they show
  a "Voice: <session>" pill (a link back, with End) and the sidebar marks the session. A failure to turn it on
  leaves Voice mode off and shows the error in that session. Dictation mutes Voice mode while it records.

## 0.5.0

**opencode-voice is now OpenCode Hub** (`@huynle/opencode-hub`, `github:huynle/opencode-hub`): a remote
console for your OpenCode sessions, with Voice as an optional feature instead of the access boundary.
Existing installs keep working; see [Migrating from opencode-voice](README.md#migrating-from-opencode-voice).

- **Rename**: npm `@huynle/opencode-hub`, command `opencode-hub` (alias `opencode-voice-hub`), binaries
  `opencode-hub-<os>-<arch>`, image `ghcr.io/huynle/opencode-hub`, plugin ids `opencode-hub` /
  `opencode-hub.tui`, TUI command **`/hub`** (`/voice` kept as an alias), RPC id `hub` (the server also
  registers the legacy `voice` id), log prefix `[opencode-hub]`, prompt metadata `source: "opencode-hub"`
  (readers accept `"opencode-voice"`). The `voice` agent keeps its name.
- **Environment**: `HUB_*` variables (`HUB_HOST`, `HUB_PORT`, `HUB_PUBLIC_URL`, `HUB_STATE_DIR`,
  `HUB_CONFIG`, `HUB_AUTH`, `HUB_OIDC_*`, `HUB_ADMIN_EMAILS`, `HUB_STT_MODEL`, `HUB_TTS_MODEL`,
  `HUB_VOICE`, `HUB_MAX_*`, `HUB_TURN_TIMEOUT_MS`, `HUB_VAPID_SUBJECT`) and `OPENCODE_HUB_CONFIG`. The
  legacy `VOICE_*` / `OPENCODE_VOICE_CONFIG` names are still read as fallbacks (the new name wins) with a
  one-time deprecation warning each. The Docker image now sets `HUB_HOST`/`HUB_PORT`/`HUB_STATE_DIR`:
  container overrides of `VOICE_HOST`/`VOICE_PORT`/`VOICE_STATE_DIR` must be renamed.
- **Config and state**: `~/.config/opencode-hub/config.json`, `~/.config/opencode-hub/hub.json` and
  `~/.local/state/opencode-hub/`. On first start the legacy `opencode-voice` files are copied there
  (modes kept, legacy files never deleted, logged once); explicit paths are used as they are.
- **Remote console**: every session a connected process reports is inspectable and controllable without
  Voice; Voice gates only conversation mode and utterances. `POST /api/sessions/:id/turn` steers while the
  session is busy (`{mode: "turn" | "steer"}`), `POST /api/sessions/:id/stop` stops the whole tree
  (descendants first), `GET …/summary` (context usage, todos, MCP, branch, change stats) and
  `GET …/diff?file=` (per-file patch, on demand), and per-user read marks (`POST …/read`, `GET /api/reads`).
- **Limits**: typed prompts/steers are capped at 100,000 characters (400); diffs at 400 KB of JSON and the
  summary at 500 changed files (`totalFiles`, `truncated`) and 100 MCP servers, so no reply outgrows a
  protocol frame; a spoke answers an oversize result with an error instead of dropping the connection.
  Stop and interrupt release the hub's turn lock (a waiting turn answers `interrupted`). The busy message
  is now "A turn is already running for this session". Reply links refuse backslashes and control
  characters.
- **Releases** publish to npm through trusted publishing (OIDC) instead of an `NPM_TOKEN`.
- **Legacy package**: `packages/opencode-voice-shim/` is a final `@huynle/opencode-voice` 0.5.0 that
  depends on and re-exports `@huynle/opencode-hub` and prints a one-line rename notice. It is published by
  hand: after `@huynle/opencode-hub@0.5.0` is on npm, `cd packages/opencode-voice-shim && npm publish
  --access public`, then `npm deprecate @huynle/opencode-voice@"<0.5.0" "Renamed to @huynle/opencode-hub"`.
- The phone now has separate per-session Voice and Worker model selectors, including model variants.
  Changes apply to the next turn or task; machine configuration remains the fallback.
- Thinking, tools and subagents now appear inline with the conversation in compact expandable rows inspired
  by OpenCode. Reopening loads ordered history from OpenCode, and complete tool input/output is fetched only
  when expanded instead of being stored in the hub.
- Conversation mode handles quick answers and up to two low-risk tools directly, uses the fast voice
  model for routine workers and the configured work model for complex work, and reuses workers only for
  follow-ups on the same active task.
- Successful worker results can be spoken directly from child completion events, removing the extra
  voice-agent summarization turn while filtering failed, interrupted and stale results.

## 0.4.0

Open sessions first: the phone now shows what is open in your terminals, like Herdr's sidebar, instead
of every stored session.

- **Open tab (default)**: sessions open in a terminal right now, grouped by Herdr workspace (or project
  folder), with working / idle / blocked dots and "Needs you" on top. "Open" comes from Herdr (`herdr
  agent list`, when installed) or from the OpenCode TUI itself (the plugin's TUI part reports the session
  and tabs it shows), so it works without Herdr too.
- **Recent tab**: the history window per machine — last 30 days, at most 100 sessions (config
  `list: {days, max}`); open, running, blocked, conversation and voice-enabled sessions are always
  included. Search and filters as before.
- **Hide and pin** sessions and workspaces, synced across your devices (per user); a **Hidden** tab to
  restore them.
- **New session from the phone** in a Herdr workspace or folder; with Herdr it opens in a new tab of that
  workspace (`opencode --session <id>`), so it appears in your terminal too.
- CI runs each test file in its own process (works around an intermittent Bun 1.3.5 hang on Linux).

## 0.3.0

One hub, several people. Each person signs in and sees only their own machines, sessions, phones and
speech settings. Without sign-in configured the hub is the single-owner hub it has always been.

- **Sign in with Google** (any OpenID Connect provider): `VOICE_AUTH=oidc` with a client ID/secret, an
  allow-list of emails or `@domains`, and admin emails. Authorization code flow with PKCE, state and nonce.
  Pairing codes and one-time login links keep working and belong to the machine's owner.
- **Ownership and isolation**: machines belong to whoever approves them, phones to whoever pairs them.
  Every API route declares its access level in one table; other people's sessions and machines answer
  404, and SSE and push only carry your own. A dedicated tenancy test suite covers every route.
- **Admin**: manage users (roles, disable), all machines and devices, pending approvals, and an audit
  log. Admins don't see other people's sessions.
- **Per-user speech settings** with a server default set by an admin; your keys are never shown to anyone
  else.
- **Migration**: existing machines and phones become the first admin's when sign-in is turned on.
- Unknown session IDs now return 404 (was 409) so IDs don't leak.

## 0.2.0

Easier to run, for people with their own voice server and for people who just want it on their computer.

- **First-run setup in `/voice`**: "On this computer" starts a local hub, connects this machine, shares
  sessions and opens the voice page; "Connect to a voice server…" checks the server, opens its approve page
  and asks which sessions to share once approved. A server already in the config is offered first.
  `/voice` → **Open voice UI** opens the page (starting the local hub if needed); **Server → Set up again…**
  switches between local and a server.
- **Zero-install local hub**: without Bun, the plugin runs the hub with OpenCode's own runtime
  (`BUN_BE_BUN=1`).
- **Speech onboarding on the page**: a "Set up speech" card until a provider is usable, the mic leads to
  speech settings instead of failing, and a "Test voice" step after saving. Sign-in links land on speech
  setup while it is missing. `GET /api/settings/speech` reports `ready: {stt, tts, reason?}`.
- **Standalone hub binaries** for macOS, Linux and Windows (runtime and web page embedded) with
  `SHA256SUMS`, built by `scripts/build-binaries.sh` and attached to each GitHub release.
- **Docker image** `ghcr.io/huynle/opencode-voice-hub` for linux/amd64 and linux/arm64.
- The hub answers `--help` and `--version`. With `VOICE_HOST=0.0.0.0` (Docker) and no `VOICE_PUBLIC_URL`,
  links default to `http://127.0.0.1:<port>`.
- Clearer pairing page: where codes come from (`/voice` → Pair a phone, or the hub's log for the first
  device).

## 0.1.0

First release.

- OpenCode plugin ("spoke") that connects every OpenCode process to a voice hub, with `/voice` to connect,
  share sessions, pair phones and open sessions in the browser.
- Voice hub with a dependency-free PWA: session browser, tap-to-talk and hands-free conversation mode,
  live activity, push notifications, speech via OpenRouter or OpenAI-compatible providers.
- Voice agent that answers in short spoken sentences and delegates work to subagents.
- Local hub auto-start for loopback servers; Dockerfile for self-hosting.
