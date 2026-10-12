# Changelog

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
