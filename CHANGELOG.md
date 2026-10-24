# Changelog

## Unreleased

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
- **App tokens**: a signed-in user (device cookie or device token) creates app/agent tokens with
  `POST /api/agent/app-tokens {label?, scopes?}` → `201 {id, token, label?, scopes, created}` (the token,
  `hat_<id>_<secret>`, is shown only here), lists them with `GET /api/agent/app-tokens` → `{tokens}` (no secrets)
  and revokes one with `DELETE /api/agent/app-tokens/:id` → `204`. Labels ≤ 100 characters; scopes from
  `sessions:read` (the default); at most 50 per user (`429 rate_limited`). Only sha256 hashes are stored. An app
  token is an app actor on `/api/agent/*` routes its scopes allow (`whoami` always); it is refused on console
  routes and on token management (`403 forbidden`), and once revoked or its user disabled (`401`). Creation and
  revocation are audited (`app-token.create`, `app-token.revoke`).
- **Device tokens, agent API framework, discovery**: every `/api` request now resolves its caller through one
  credential resolver. Besides the `voice_device` cookie, the same device secret works as
  `Authorization: Bearer <device token>` (for native apps and CLIs) with the same powers and without the
  same-origin check; the cookie together with a hub bearer token is refused (400 `invalid`), while a bearer the hub does not know (e.g. from an auth proxy) next to the cookie is ignored. New `/api/agent/*` routes answer
  errors as `{error: {code, message, hint?}}` (`unauthorized`, `token_expired`, `forbidden`, `not_found`, …)
  and start with `GET /api/agent/whoami` (`{actor, user}`). `GET /.well-known/hub` (public) answers
  `{publicURL, version, minClientVersion, auth: {modes, oidc?}, features}`. Existing routes keep their error
  format.
- **Harness-neutral spoke protocol** (still version 1, compatible both ways). The hello may carry `harness`,
  `harnessVersion` and `evidence` (`native` | `hooks` | `rpc` | `screen`; anything else counts as `unknown`); the
  OpenCode spoke sends `harness: "opencode"`, `evidence: "native"` and keeps `opencodeVersion` for older hubs. A
  hello without `harness` is an OpenCode spoke with the implied v1 features (`IMPLIED_OPENCODE_FEATURES`); new
  spokes announce all their features (`SPOKE_FEATURES`). The welcome lists the hub's features (`HUB_FEATURES`,
  now `["harness"]`) and spokes remember them (`hubSupports`). `/api/machines` processes gain `harness`,
  `harnessVersion` and `evidence`.

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
