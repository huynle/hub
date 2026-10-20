# Android Voice companion: hands-free Voice with the screen off

Status: design agreed 2026-10-20 (brainstorming session), revised the same day after codebase validation.
Brain: idea `50203efi`, decision `v3m6x0cp`, plan `nk6vrg70`; related decisions `4nlyn2nr` (voice loop) and
`x0n3qlaj` (live stream, replay, push).

## Problem

Android Chrome stops or mutes `getUserMedia` capture when the page is backgrounded or the phone is locked,
even with battery set to Unrestricted. Voice mode therefore stops hearing the user while driving. The web
app now shows an honest "paused — unlock to talk" state (`fix/voice-screen-off`), but no web workaround
keeps the mic open. A native app with a microphone foreground service can.

## Decisions

- **Shape: voice-only remote.** A small native app that does only what the web app cannot: listen with the
  screen off and behave well in a car. Transcript, typing, session browsing and Markdown stay in the web
  app; the app's "Open" action launches it. Rejected: a WebView hybrid (two voice pipelines competing for
  the mic, fiddly handoff) and a full native client (duplicates the web app).
- **Listening: always-on conversation with media-button mute.** Same model as web conversation mode.
  Rejected for v1: push-to-talk and a switchable mode.
- **Permissions: approve or deny by voice with read-back.** "Yes" sends `once`, "no" sends `reject`; voice
  never sends `always`. Unclear answer or ~20 s silence leaves the request open. Questions (forms) are
  announce-only in v1. Rejected: announce-only (blocked work stays blocked for the whole drive) and voice
  "approve all" (too risky).
- **Repo: `apps/android` in `huynle/hub`.** API and app change in one PR; shared voice config and test
  cases. Rejected: a separate repo (protocol drift, coordinated releases).
- **Distribution: Google Play internal testing track.** Rejected: sideloaded APK with in-app updater,
  Obtainium.
- **Sign-in: QR / deep link from the signed-in web app** using new, purpose-bound link codes. Rejected:
  reusing `/hub` login codes (2 min TTL, and the same code would also sign a browser in at `/login`); OIDC
  in a Custom Tab with a redirect back to the app (the cookie lands in the browser).
- **Car audio: communication mode.** With a car or headset connected, Voice uses the Bluetooth
  communication device (HFP): car mic, best echo cancellation; music pauses while Voice is on and the car
  may show a call. Without one, the phone mic and normal playback are used. Rejected: media mode with the
  phone mic (poor pickup, echo from car speakers); a switch between both (more to build and test).
- **Presence means "Voice active".** The app reports the session visible every 30 s while Voice runs, so
  the hub does not also push every spoken reply to the phone.

## Architecture

Kotlin, Jetpack Compose (two screens), OkHttp + okhttp-sse, ONNX Runtime Mobile (Silero VAD, the same
`silero_vad.onnx` the web uses, MIT), Media3 ExoPlayer. `minSdk 31`, `targetSdk` current. No database:
DataStore for settings, device token encrypted with a Keystore AES-GCM key (or Tink), not the deprecated
`security-crypto`.

| Component | Responsibility |
|---|---|
| `HubClient` | Only network code. Every request sends `Cookie: voice_device=<token>`; every non-GET sends `Origin: <hub publicURL origin>` (the hub rejects cross-origin writes before routing, public routes included). |
| `VoiceService` | Foreground service (`microphone\|mediaPlayback`), started only while the UI is visible (Android 14+ rule). Owns the voice loop, notification (Mute / End / Open), media session, audio focus, presence heartbeat. |
| `Listener` | `AudioRecord` 16 kHz mono, `VOICE_COMMUNICATION` source, AEC/NS when available; Silero VAD with the web's probability VAD, segmenter, sensitivity presets; endpointer and junk filter. |
| `Speaker` | Ordered, sentence-by-sentence playback of streamed MP3 from `POST /api/speak` (Media3 data source with POST body, Cookie and Origin); barge-in; cue tones. |
| `PermissionDialog` | Detects new permission blockers, reads them aloud, listens once, parses yes / no / unclear, confirms, times out to "left open". |
| UI | Link screen (QR scan or deep link, shows the target hub for confirmation); main screen: session picker, status, sensitivity, Start/Stop. |

## Hub API used by the app

| Purpose | Request |
|---|---|
| Version gate (public) | `GET /healthz` → `{ok, version, spokes}`; the app requires a minimum hub version before redeeming (unknown public routes answer 401, not 404). |
| Me | `GET /api/me` → device, user, `publicURL`, `version` |
| Session picker | `GET /api/machines` → `machines[].processes[].sessions[]` (`exposed`, `status`, `busy`, `conversation`, `title`) |
| One session | `GET /api/sessions/:id` → status tree with blockers |
| Enable Voice | `POST /api/sessions/:id/expose {on:true}` (required before conversation/utterance, else `403 not_exposed`) |
| Conversation | `POST /api/sessions/:id/conversation {on}` (`409 NO_OWNER` when no OpenCode process) |
| Utterance | `POST /api/sessions/:id/utterance {text}` (≤ 4000 chars) → 202 `{inboxID}` |
| Interrupt ("stop") | `POST /api/sessions/:id/interrupt` |
| Presence | `POST /api/sessions/:id/presence {visible}` every 30 s while active; `false` on stop |
| Permission | `POST /api/sessions/:root/permission {requestID, decision: once\|reject}`; `409 gone` = answered elsewhere |
| Transcribe | `POST /api/transcribe`, raw body, `Content-Type: audio/wav` (16 kHz mono) → `{text}` |
| Speak | `POST /api/speak {text}` → streamed `audio/mpeg` |
| Live stream | `GET /api/events?lite=1&session=<id>` with `Last-Event-ID`; ping every 20 s; `resync` after too large a gap |

SSE messages the app handles (`RegistryMessage` in `src/central/registry.ts`, `SessionStatus`/`Blocker` in
`src/status.ts`):

- `say {sessionID, messageID, ordinal, seq?, text}`: root replies one sentence per message with `seq`;
  subagent results whole; hub announcements without `seq` and with `messageID` `announce:failed:…`,
  `announce:permission:<requestID>`, `announce:form:<formID>`.
- `heard {sessionID, inboxID}`, `conversation {sessionID, on}` (stop on `false`).
- `status {sessionID, sessions}`: permission and form blockers live here. The hub announces worker
  permissions but never root-session ones, so the app announces root permissions itself and drops the
  duplicate `announce:permission:<id>` when it speaks one.
- `resync`: re-read `GET /api/sessions/:id`.

## Server changes

Only device linking.

- `Auth` gets purpose-bound link codes: `linkCodes`, `LINK_TTL_MS = 5 min`, `issueLinkCode(ownerID)`,
  `redeemLink(code, deviceName)`. 256-bit codes, single use, owner must be active, deleted before the device
  is created. Not redeemable at `/login`. No shared rate limiter (the global pairing limiter would let bad
  redeems lock out pairing; 256-bit codes cannot be brute-forced).
- `POST /api/devices/link` (user) → `{code, expiresAt, hub, url}` with
  `url = hubvoice://link?hub=<publicURL>&code=<code>`.
- `POST /api/devices/redeem` (public, Origin required) `{code, deviceName}` → `{device, token}` plus
  `Set-Cookie`. Device named "Android (<model>)", sanitized to 64 chars; audited `device.pair` / `android link`.
- Web Settings → Devices → **Add Android app**: dialog with QR (small dependency-free QR library rendered as
  inline SVG) and the link; the device list refreshes after redeem.
- The custom scheme can be claimed by another app, and a malicious link could point the app at another hub:
  the app shows the hub URL and asks before redeeming, and requires `https`.

## Voice loop

1. **Start (UI visible):** read the session; expose it if needed; conversation on; open the lite SSE
   stream; start presence; play the listening tone.
2. **Utterance:** VAD segment ends → transcribe the segment right away → junk filter → endpointer holds
   text that looks unfinished for `holdMs` (800 ms) and merges follow-ups → voice commands ("stop",
   "never mind" → interrupt; "pause listening" → mute) → heard tone → utterance.
3. **Replies:** `say` sentences assembled by `(messageID, ordinal, seq)` with dedupe, spoken through
   `/api/speak` in order. Barge-in drops unspoken text; it never stops the agent or its workers.
   Announcements share the queue. Progress cues as on the web.
4. **Permission:** new blocker → read aloud → listen once → `once` / `reject` / leave open → speak result.
5. **Disconnect:** backoff reconnect with `Last-Event-ID`; one "offline" tone, one "back" tone.

Known limit: a browser tab and the app running Voice on the same session both speak every reply, and either
turning conversation off ends it for both. Documented, not prevented, in v1.

## Audio and car behavior

- **Routing:** with a car or headset connected, `setCommunicationDevice` to it and play replies with
  `USAGE_VOICE_COMMUNICATION` (needs `BLUETOOTH_CONNECT`). Otherwise phone mic and `USAGE_ASSISTANT`
  playback with transient ducking focus.
- **Echo:** the mic stays open during playback; barge-in uses the web's stronger speaking-time threshold and
  `SPEAKING_TAIL_MS`.
- **Calls:** a phone call pauses listening and playback; both resume after the call with a tone.
- **Media button:** play/pause or headset hook toggles mute; "muted" is spoken once and shown in the
  notification.
- **Notification is the driving UI:** Listening · Muted · Working · Offline · Waiting for approval.

## Errors

| Case | Behavior |
|---|---|
| 401 (device revoked) | Stop; show "Device removed, scan a new code". |
| 403 `not_exposed` | Expose again once; if that fails, say so and stop. |
| 403 other | Origin bug: log, show error, stop. |
| 409 `NO_OWNER` | Say "session offline", retry with backoff. |
| 409 `gone` (permission) | Say "already answered". |
| 413 | Drop the clip. |
| 502 / STT failure | Error tone + "didn't catch that", rate-limited. |
| Mic taken by another app | Say "mic unavailable", retry. |
| Conversation turned off elsewhere | Say so, stop. |

## Parity with the web voice code

`web/src/core/` stays the source of truth: `conversation-core.ts` (`VOICE_TIMINGS`, segmenter constants,
endpointer, `looksComplete`, `isFiller`, `parseCommand`, `splitSentences`, `SayAssembler`), `speech-vad.ts`
(`NORMAL_VAD`, sensitivity presets, `SPEAKING_TAIL_MS`, `MIN_VOICED_RATIO`), `junk-transcript.ts`.

- Private constants are exported; regexes are exported as `.source` strings (Kotlin uses
  `UNICODE_CHARACTER_CLASS` where needed).
- `scripts/gen-voice-config.ts` writes `apps/android/app/src/main/assets/voice-config.json`; CI fails when it
  is stale.
- Shared cases in `test/fixtures/voice-parity/*.json` (junk keep/drop, VAD probability sequences → events,
  endpointer, sentences, say ordering, commands) run in `bun test` and in the Kotlin unit tests.

## Testing

- **Server (Bun):** link/redeem expiry, single use, user binding, disabled owner, not redeemable at
  `/login`, cross-origin 403, name sanitizing, revoke.
- **JVM unit tests:** all parity cases; voice loop state machine (idle → listening → hearing → transcribing
  → sent → speaking, plus muted, paused, offline, awaiting permission); permission detection and dedupe;
  yes/no parsing; backoff.
- **`HubClient` against a fake hub** (`MockWebServer`): recorded SSE, `Last-Event-ID` replay, `resync`,
  401, `not_exposed`, `gone`, Origin and Cookie on every request.
- **Instrumented (emulator), few:** foreground start, notification actions, audio focus.
- **Manual drive checklist** (`apps/android/TESTING.md`): 30+ min screen off, car Bluetooth, incoming call,
  dead zones, battery per hour.

## CI and release

- `android.yml` runs on changes to `apps/android/**`, `web/src/core/**`, `test/fixtures/voice-parity/**`,
  `scripts/gen-voice-config.ts`: Gradle lint, unit tests, debug build. The stale-config check runs in
  `ci.yml`, which always runs. `ci.yml` push builds ignore `apps/**` so Android-only merges do not rebuild
  the hub image.
- `.gitignore` gets Android build outputs and key files; `.dockerignore` gets `apps`.
- `android-release.yml` on `android-v*` tags (no clash with `v*`): signed AAB (upload key in secrets, Play
  App Signing holds the app key), Gradle Play Publisher to the **internal** track. `versionCode` derived
  from the tag (re-runs keep the same number), release notes from
  `apps/android/app/src/main/play/release-notes/en-US/default.txt` (≤ 500 chars). Promotion beyond internal
  is manual.

### Owner setup (manual)

1. Play developer account ($25, identity verification) and the app entry.
2. Foreground service declaration for `microphone` (with a short video showing screen-off Voice).
3. Play service account and upload key, stored as repository secrets.

## Milestones

Each is a small PR, test-first.

1. Server device link + web QR (deploys on merge).
2. Voice parity data and shared cases.
3. Android skeleton + CI.
4. App API contract doc.
5. `HubClient` + linking.
6. Voice loop logic (JVM only).
7. Service and audio.
8. Play release pipeline (needs owner setup).
9. Drive test and polish.

**v1 is done when** a 30-minute screen-off drive covers start, ask, hear replies, barge-in, approve a
permission and steering-wheel mute, with no silent failure.

## Later

Android Auto, wake word, streaming PCM STT, answering forms by voice, transcript view, a media-mode audio
option.
