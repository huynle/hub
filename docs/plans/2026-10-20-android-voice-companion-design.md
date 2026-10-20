# Android Voice companion: hands-free Voice with the screen off

Status: design agreed 2026-10-20 (brainstorming session). Brain: idea `50203efi`, decisions `4nlyn2nr`
(voice loop) and `x0n3qlaj` (live stream, replay, push).

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
- **Permissions: approve or deny by voice with read-back.** Unclear answer or ~20 s silence leaves the
  request open. Questions (forms) are announce-only in v1. Rejected: announce-only (blocked work stays
  blocked for the whole drive) and voice "approve all" (too risky).
- **Repo: `apps/android` in `huynle/hub`.** API and app change in one PR; shared voice config and test
  cases. Rejected: a separate repo (protocol drift, coordinated releases).
- **Distribution: Google Play internal testing track.** Rejected: sideloaded APK with in-app updater,
  Obtainium.
- **Sign-in: QR / deep link from the signed-in web app**, built on the existing one-time login codes.
  Rejected: OIDC in a Custom Tab with a redirect back to the app (the cookie lands in the browser, needs a
  redirect allow-list and an app handoff code).

## Architecture

Kotlin, Jetpack Compose (two screens), OkHttp (SSE + HTTP), ONNX Runtime Mobile (Silero VAD), ExoPlayer.
`minSdk 31`, `targetSdk` current. No database: DataStore for settings, device token encrypted with a
Keystore-backed key.

| Component | Responsibility |
|---|---|
| `HubClient` | Only network code. Cookie-authenticated: `/api/events?lite=1&session=…` with `Last-Event-ID`, `/api/transcribe`, `/session/utterance`, `/session/conversation`, `/api/speak`, the permission endpoint. Sends `Origin: <hub URL>` to pass the hub's same-origin check on state-changing requests. |
| `VoiceService` | Foreground service (`microphone\|mediaPlayback`) owning the voice loop, notification (Mute / End / Open), media session and audio focus. |
| `Listener` | `AudioRecord` 16 kHz mono, `VOICE_COMMUNICATION` source, AEC/NS when available; Silero VAD with web `VOICE_TIMINGS` and Low/Normal/High sensitivity; junk-transcript filter. |
| `Speaker` | Ordered, sentence-by-sentence playback of streamed MP3 from `/api/speak`; barge-in; cue tones. |
| `PermissionDialog` | Reads the request aloud, listens once, parses yes / no / unclear, confirms, times out to "left open". |
| UI | Link screen (QR scan or deep link); main screen: session picker, status, sensitivity, Start/Stop. |

## Server changes

Only device linking; the voice loop uses existing APIs.

- `POST /api/devices/link` (user): issues a one-time login code bound to the caller's user, 5 min TTL.
  Web Settings → Devices → **Add Android app** shows it as a QR code and a
  `hubvoice://link?hub=<url>&code=<code>` link.
- `POST /api/devices/redeem` (public, code-gated): redeems the code once and returns a device token for a
  new device named "Android (<model>)". Audited as `device.pair` with detail `android link`.
- The device appears in the Devices list and is revoked like any other.

## Voice loop

1. **Start:** conversation on for the chosen session (one session in Voice mode at a time, as on the web),
   open the lite SSE stream for that session, play the listening tone.
2. **Utterance:** VAD speech, then 800 ms hold → heard tone → `/api/transcribe` → junk filter →
   `/session/utterance`.
3. **Replies:** `say` events ordered by `seq`, each sentence spoken through `/api/speak`. Barge-in drops
   unspoken text; it never stops the agent or its workers. Announcements share the playback queue.
4. **Permission:** read aloud, listen once, approve/deny on a clear answer, speak the result.
5. **Disconnect:** backoff reconnect with `Last-Event-ID` replay; one "offline" tone, one "back" tone.

## Audio and car behavior

- **Echo:** the mic stays open during playback; barge-in needs a stronger speech threshold while a reply is
  playing so the app does not hear itself through car speakers.
- **Routing:** prefer the connected car or headset mic (`setCommunicationDevice`), fall back to the phone mic.
- **Focus:** replies take transient focus with ducking (music and navigation are lowered, not paused).
  A phone call pauses listening and playback; both resume after the call with a tone.
- **Media button:** play/pause or headset hook toggles mute; "muted" is spoken once and shown in the
  notification.
- **Notification is the driving UI:** Listening · Muted · Working · Offline · Waiting for approval.

## Errors

| Case | Behavior |
|---|---|
| Mic taken by another app | Say "mic unavailable", retry. |
| STT failure | Error tone + "didn't catch that", rate-limited. |
| 401 (device revoked) | Stop the service; show "Device removed, scan a new code". |
| Session ended or Voice turned off elsewhere | Say so, stop. |

## Parity with the web voice code

`web/src/core/` (`conversation-core.ts` `VOICE_TIMINGS`, `speech-vad.ts`, `junk-transcript.ts`) stays the
source of truth.

- A build script exports timings, sensitivity presets and junk patterns to `apps/android/…/voice-config.json`.
- Shared test cases (VAD frames → expected segments; transcripts → keep/drop) are checked in once and run
  by both the web and Kotlin test suites.
- CI fails when the generated config is stale.

## Testing

- **JVM unit tests:** voice loop state machine (idle → listening → heard → sending → speaking, plus mute,
  barge-in, permission, offline), `seq` ordering, yes/no parsing, backoff, shared VAD and junk cases.
- **`HubClient` against a fake hub** (`MockWebServer`): recorded SSE streams, `Last-Event-ID` replay,
  401 handling.
- **Server (Bun):** link/redeem expiry, single use, user binding, audit, device naming.
- **Instrumented (emulator), few:** foreground start, notification actions, audio focus.
- **Manual drive checklist** (`apps/android/TESTING.md`): 30+ min screen off, car Bluetooth, incoming call,
  dead zones, battery per hour.

## CI and release

- `android.yml` runs on changes to `apps/android/**` or `web/src/core/**`: Gradle build, lint, unit tests,
  stale config check. Web CI also runs the shared test cases.
- Tag `android-vX.Y.Z`: signed AAB (upload key in GitHub secrets; Play App Signing holds the app key),
  published to the **internal** track with Gradle Play Publisher (service account JSON in secrets).
  `versionCode` from the CI run number, `versionName` from the tag, release notes from the CHANGELOG.
  Promotion beyond internal is manual in Play Console.

### Owner setup (manual)

1. Play developer account ($25, identity verification) and the app entry.
2. Foreground service declaration for `microphone` (with a short video showing screen-off Voice).
3. Play service account and upload key, stored as repository secrets.

## Milestones

Each is a small PR in a worktree, test-first.

1. Server device link: endpoints, web "Add Android app" QR, Bun tests, Flux release.
2. Android skeleton + CI: Gradle project, `android.yml`, shared test cases, generated config + stale check.
3. `HubClient` + linking: QR/deep-link redeem, encrypted token, session picker, SSE with replay.
4. Voice loop logic (JVM only): state machine, `seq` ordering, permission parsing, backoff.
5. Service and audio: foreground service, notification, media session, VAD capture, playback, barge-in,
   focus and Bluetooth routing, instrumented tests.
6. Play release pipeline: signing, internal track, first `android-v0.1.0` (needs owner setup).
7. Drive test and polish: run the checklist, fix findings, record quirks in Brain.

**v1 is done when** a 30-minute screen-off drive covers start, ask, hear replies, barge-in, approve a
permission and steering-wheel mute, with no silent failure.

## Later

Android Auto, wake word, streaming PCM STT, answering forms by voice, transcript view.
