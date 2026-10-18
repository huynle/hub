# Changelog

## Unreleased

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
