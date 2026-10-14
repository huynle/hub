# Per-session model controls and inline OpenCode-style timeline

## Goal

Let a person choose the conversational Voice model and the complex-worker model from the phone for each
session, including model variants, and replace the separate activity panel with an inline chronological
timeline of thinking, tools, subagents, permissions and replies. The interaction should feel like
OpenCode's web UI while remaining a small dependency-free PWA.

## Reference implementation

This design is grounded in the read-only OpenCode checkout at commit
`e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`:

- `packages/app/src/providers/models/select-dialog.tsx`: searchable model catalog, provider grouping,
  selected checkmark and keyboard navigation.
- `packages/app/src/composer/composer.tsx`: the model trigger lives directly in the composer.
- `packages/session-ui/src/message/message-content.tsx`: reasoning is a compact, expandable tool-like
  timeline row with streaming state and duration.
- `packages/session-ui/src/tools/tool-renderer.tsx`: tools expose structured state and expandable detail.
- `packages/protocol/src/groups/model.ts`: `/api/model` returns available models with variants.
- `packages/protocol/src/groups/message.ts`: paginated projected session messages preserve timeline order.

The checkout is locally dirty and was treated as read-only.

## Model controls

The session composer gets two compact controls:

- **Voice** — model and variant for the root conversational agent.
- **Worker** — model and variant explicitly passed to complex subagents.

Each opens the existing mobile picker sheet, enhanced to search and group by provider with the selected
item checked. A second compact variant list appears for models that expose variants. Both choices persist
per user and per session in the hub. Machine `voiceModel` and `workModel` remain fallbacks when a session
has no override.

Changing a selection during active work records it immediately but applies it only to the next root turn
or newly spawned complex worker. Current root and child executions are never interrupted. Missing or
disabled catalog entries remain visible as stale selections with a warning; the UI does not silently
substitute another model.

The owning spoke obtains OpenCode's model catalog and switches the root session to the selected Voice
model before its next turn. The conversation context supplies the selected Worker model/variant to the
orchestrator for complex subagent calls. Turning conversation mode off restores the pre-conversation
model only when the session is still on the active Voice model.

## Inline timeline

The separate Activity section is replaced by a chronological transcript timeline:

- User and assistant messages remain the strongest visual elements.
- A **Thinking** row shimmers while streaming, then shows `Thought · <duration>`. It is collapsed by
  default with a short heading/latest line and expands to full reasoning.
- A **tool** row shows an icon, friendly name, state and duration. Expanding lazily loads complete input,
  output, metadata and errors from OpenCode.
- A **subagent** row groups the child's own thinking and tools, with running, blocked, complete and failed
  states.
- Permission and form requests remain prominent and actionable at their chronological position.
- The assistant reply follows the work that produced it.

Rows use restrained status color, small monospace metadata and subtle motion modeled on OpenCode, while
retaining opencode-voice's dark mobile identity and accessibility conventions.

## History and live data

OpenCode remains the source of truth. The hub does not persist full tool payloads or reasoning.

1. The phone requests the newest timeline page through the hub.
2. The hub routes it to the owning spoke.
3. The spoke calls OpenCode's paginated message API and normalizes projected messages into Voice timeline
   records with stable message/part IDs.
4. Older pages load when scrolling upward.
5. Live forwarded events merge by stable IDs without duplication.

Live SSE carries ordering, state, duration, summaries and references. Reasoning and assistant text keep
streaming. Full tool inputs/outputs are fetched only when a row is expanded, then cached in the browser
for that page load. Large values render in bounded scrollable code panels without silent summarization.

All model, history and detail operations use existing per-user session ownership and 404 isolation.

## Protocol and storage

New server-to-spoke operations:

- `models` — available model catalog and variants for the session's location.
- `modelPrefs` — read effective per-session Voice/Worker selections and machine fallbacks.
- `setModelPrefs` — validate and apply a partial per-session preference update.
- `timeline` — paginated normalized session history.
- `timelinePart` — full detail for one authorized tool part.

The store gains per-user session model preferences keyed by session ID, bounded like view preferences.
Catalogs and full timeline details are not persisted. The hub may keep short-lived bounded catalog and
timeline caches to reduce repeated spoke calls.

## Failure and security behavior

- Unknown sessions, models, variants, message IDs and part IDs return 404 where isolation requires it;
  malformed values return 400.
- A disconnected owner produces the existing unavailable response and leaves preferences unchanged.
- Full tool details can contain secrets and file contents. They are fetched only after authorization,
  never broadcast to other users, never included in push notifications and never written to hub state.
- A model unavailable at execution time produces an inline warning and leaves the turn unsent until the
  person chooses a valid model or clears the override.
- Pagination and detail payloads have explicit count and byte bounds.

## Verification

- Protocol parsing and bounds for every new operation.
- Store tests for per-user/per-session preference isolation and bounded persistence.
- Spoke tests for catalogs, variants, next-turn switching, worker routing, message normalization,
  pagination and detail authorization.
- Hub HTTP tests for ownership, 404 isolation, stale selections and disconnected owners.
- Pure web tests for provider grouping, search, variants, timeline ordering, live/history deduplication,
  nesting, expansion and large detail rendering.
- Full suite and TypeScript checks.
- Private OpenCode server plugin smoke test.
- Mobile browser verification at narrow and desktop viewport sizes, including keyboard and screen reader
  labels.
