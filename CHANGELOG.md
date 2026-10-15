# Changelog

## 0.5.1 (unreleased)

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
