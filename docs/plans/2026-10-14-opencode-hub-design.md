# opencode-hub: remote session console with Voice mode

Supersedes the visual/structure parts of `2026-10-14-remote-session-console-design.md`; its access model,
control behavior and race handling remain in force. Reference UI: Claude Code web (claude.ai/code).

## Product

`opencode-voice` becomes **opencode-hub**: a central console connecting many OpenCode servers. Every owned
session reported by a connected server is inspectable and remotely controllable; Voice is an optional
feature (dictation and hands-free conversation mode) rather than the access boundary.

## Rename

- npm `@huynle/opencode-hub`; a final `@huynle/opencode-voice` release depends on it and prints a rename
  notice. Plugin: `opencode plugin add github:huynle/opencode-hub`.
- Command `/hub`; `/voice` kept as an alias for Voice subcommands. The `voice` agent keeps its name.
- Repo `huynle/opencode-hub` (GitHub redirect); image `ghcr.io/huynle/opencode-hub`.
- Config `~/.config/opencode-hub/`, state `~/.local/state/opencode-hub/`; legacy directories migrated on
  first start. Env `HUB_*`; legacy `VOICE_*` read as fallbacks with a deprecation warning.
- Public hub `https://ochub.huynle.com`; `voice.huynle.com` redirects during cutover.

### OAuth / deployment touch points

1. Google Cloud Console OAuth client: add redirect URI `https://ochub.huynle.com/auth/callback` (and the
   JavaScript origin if listed); keep the old URI until cutover completes; rename the consent screen app.
2. `infra/apps/homelab/voice/voice-env.sops.yaml`: public URL becomes `https://ochub.huynle.com`.
3. `infra/apps/homelab/voice/release.yaml`: ingress host, redirect from the old host, new image.
4. Spoke config on each machine (`~/.config/opencode-voice/config.json`): hub URL; migrated automatically.
5. Device cookies are per-domain: browsers sign in again once.

## Architecture

- `src/spoke`: plugin. New ops `summary` (context %, todos, MCP status, diff stats), `diff` (per-file patch,
  on demand) and `stop` (whole tree). Events forwarded for every reported root and descendants in the
  history window regardless of Voice state, within existing limits.
- `src/central`: hub HTTP/SSE, OIDC, registry, speech.
- `web/`: new **Solid + Vite + TypeScript** app. Existing pure modules (timeline, browser, conversation,
  feedback, view) converted to TypeScript with their tests. One reactive store fed by the hub SSE stream.
  The image builds `web/` in a build stage; the hub serves `dist/`.

Context % = last assistant message tokens / model context limit. Summaries ride on status updates
(throttled ~1/s per session); diffs are fetched lazily and never persisted in the hub.

## API

All owner-scoped; cross-user sessions answer 404.

- `GET /api/sessions/:id/summary`, plus SSE `summary` events.
- `GET /api/sessions/:id/diff?file=` (512 KB cap per file).
- `POST /api/sessions/:id/read` (per-user unread state in hub).
- `POST /api/sessions/:id/stop`: descendants first, then root; idempotent.
- `POST /api/sessions/:id/turn`: auto-steers while busy; returns `{mode:"turn"|"steer"}`.
- Timeline, status, models, context, interrupt, permission/form replies work without Voice.
- Conversation mode, utterance and speech routes still require Voice enabled (403 `not_exposed`).

## Interface

Routes: `/` sessions table (list on phone), `/s/:sessionID`, `/new`, `/settings`.

- **Sidebar** (235px, collapsible, ⌘B): brand, search, New session; Needs you, Running, project groups
  (with `+` and group/sort menu), Recents. Rows: title, status icon, Voice badge, unread dot, `⋯` menu
  (pin, hide, rename, stop, Voice on/off). Footer: account and settings.
- **Top bar**: title menu, server/branch chip, rail toggle, Changes.
- **Transcript** (~680px): assistant markdown without bubbles; user grey right-aligned pills; thinking as
  "Thought for Ns ›"; consecutive tools as "Used N tools (k failed) ›" with lazily loaded full detail;
  subagent rows linking to child timelines; inline permission/form cards.
- **Right rail** (260px; phone bottom sheet): Server, Context, Todos, MCP, Changes; diff viewer opens as a
  wide panel over the transcript.
- **Composer**: `+` (future attachments), textarea with `/` commands, Send → Steer while busy, Stop while
  the tree runs; lower right Dictate mic and the Voice mode split button (waveform = conversation mode;
  chevron = mic picker with level meter). Meta row: agent/permission mode left; Voice and Worker
  model+effort menus right with number-key shortcuts.
- **Voice bar** (inline above composer in Voice mode): waveform, Listening/Thinking/Speaking, mute, model,
  End.
- **Home table**: status, title, project, server, open source, Voice, last activity, current activity;
  sortable, searchable, filter chips persisted locally, row actions.
- **Tokens**: bg `#141413`, sidebar `#1a1a18`, borders `#2a2a27`, text `#e8e6e1` / `#9b9890`, OpenCode
  accent; serif display, sans UI, mono code.
- **Phone**: sidebar drawer, rail sheet, full-width composer, safe-area Voice bar.

## Errors

Offline server → sessions read-only with banner. Rejected steer keeps the draft. Oversized diff or no git →
explained in Changes. Permission answered elsewhere disappears. Vanished session → home with notice.

## Delivery

1. Backend: Voice/control separation, stop, auto-steer, summary/diff/read ops.
2. Solid + Vite scaffold, TS core modules, SSE store.
3. Sidebar, home table, transcript, composer.
4. Right rail, diff viewer, Voice bar, mic picker.
5. Rename: package, config/env migration, `/hub` + alias, image, docs.
6. Deploy on `ochub.huynle.com` with redirect; user updates Google OAuth; infra and spokes updated.

## Verification

Route/op unit and integration tests including isolation; migration tests; component tests for table,
sidebar ordering and composer states; Playwright smoke on the mock hub at desktop and phone sizes; private
OpenCode end-to-end smoke; `scripts/test-ci.sh`, typecheck and image build.
