# Hub MCP lifecycle completion

## Objective

Complete the public Hub MCP control-plane surface for an external orchestrator: create and supervise sessions, consume resumable events, organize and address sessions, complete messaging reads, manage durable webhooks, operate a real launch node, and archive finished work. MCP remains a thin front end to Hub Central's public agent API; it gets no separate policy path.

## Authority

Add the app-token scope `sessions:manage` for organizational changes: archive/unarchive, pin/unpin, naming, and role claim/release. It does not permit prompting, stopping, answering, approving, launching, credential management, or grant management. Existing tokens gain no new authority. `sessions:act` and `sessions:launch` continue to require grants.

An app token changing roles needs both `sessions:manage` and a matching grant with the existing `roles` verb. Sessions retain their existing self-management rules.

Credential and grant administration remain console-only. User Decisions remain user-only to answer.

## Session lifecycle

1. `launch` creates a managed session.
2. `events` follows progress with an opaque resumable cursor and bounded long polling.
3. `show`, `log`, `message_show`, and `decision_show` inspect it.
4. Messaging and acting tools interact with it under their existing scopes and grants.
5. Name, role, labels and pins organize it.
6. `stop` stops a turn; `launch_stop` ends a managed launch.
7. `archive` removes a finished session from normal Hub views without deleting the harness session; `unarchive` restores it.

Archive uses a dedicated agent API over the canonical `hiddenSessions` state rather than exposing the entire preferences document. Writes are bounded, idempotent, tenant-safe and audited.

## Events

Add an MCP `events(cursor?, wait?, limit?, types?, sessions?)` tool backed by a canonical bounded event journal. Results contain `events`, an opaque next `cursor`, and `more`. Waiting is capped at 60 seconds. Expired cursors return a typed reset with a fresh snapshot boundary. Filters never weaken tenancy.

Events cover session presence/state, blockers, archive state, messages and asks, launches, machine/spoke state, names, roles and later pins. Payloads are compact metadata: never prompt text, message bodies, credentials, webhook secrets or another tenant's identifiers. Existing SSE watch should consume the same event semantics to prevent divergent definitions.

Retention is bounded to 24 hours or 10,000 compact events per user, whichever trims first. Cursor reset is a typed successful response with `reset: true`, a fresh cursor, and the snapshot reads the caller must refresh. Compact events exclude blocker summaries and other free text. `/api/agent/watch`, not the richer console `/api/events`, aligns to these semantics.

Webhook creation and event polling require a dedicated `events:subscribe` app-token scope. Individual event families are additionally filtered by the token's read, manage, message or launch scopes.

## Ordered delivery

1. Archive/unarchive and `sessions:manage`, including token UI.
2. Resumable cursor events and SSE alignment.
3. MCP name, role claim and role release.
4. Mute/unmute, message lookup and Decision list/show.
5. Webhook MCP management and canonical event coverage.
6. Provision and verify an eligible launch node; exercise launch through end.
7. Pin/unpin and preview-first bulk archive-inactive.

Bulk archive applies only an exact bounded preview set and revalidates it at write time; sessions that became active, pinned or open are skipped and reported.

The phases are sequential because they share `packages/sdk`, `packages/cli/src/mcp.ts`, central agent routes, tests and documentation.

## Compatibility and rollout

New API routes and MCP tools are additive. Persisted event data must be bounded and tolerate mixed-version rolling deploys. Cursor tokens are opaque and versioned. An expired or unknown cursor never silently skips events. Bulk organization writes have hard size limits. Webhook signing secrets and app tokens are shown once and never logged.

Each phase ships independently through CI and Flux, then refreshes the gateway snapshot. Tool writes receive correct MCP annotations for gateway review. Existing approved tools remain available while newly discovered tools stay disabled until reviewed.

## Frozen public contracts

### Organization routes and tools

- `PUT /api/agent/sessions/:addr/archive {"archived": boolean}` → `{sessionID, archived, changed}`. MCP: `archive(addr)` and `unarchive(addr)`.
- `PUT /api/agent/sessions/:addr/pin {"pinned": boolean}` → `{sessionID, pinned, changed}`. MCP: `pin(addr)` and `unpin(addr)`.
- Existing name and role routes remain; MCP adds `name`, `role_claim`, and `role_release` without changing their wire contracts.
- Archive/pin/name require `sessions:manage`. App role writes require `sessions:manage` plus a matching grant containing `roles` and covering the target project.
- Foreign and unknown addresses both answer `404 not_found`. Invalid input is `400 invalid`; missing scope is `403 forbidden`.

### Events route and tool

`GET /api/agent/events?cursor=&wait=&limit=&type=&session=` and MCP `events` use the same contract. `wait` is seconds, 0–60; `limit` is 1–200, default 50; `type` and `session` may repeat. The server inspects at most 1,000 journal records per request. Filters advance the cursor over every inspected record. `more` means unscanned records remain, whether or not they match.

Normal response:

```json
{"events":[{"id":"evt_…","at":1793090000000,"type":"session.changed","subject":{"sessionID":"ses_…"},"data":{"state":"idle"}}],"cursor":"hev1_…","more":false,"reset":false}
```

Expired or trimmed cursor (successful recovery response, never silent):

```json
{"events":[],"cursor":"hev1_…","more":false,"reset":true,"refresh":["status","sessions","inbox","decisions","launches"]}
```

Malformed, forged, future, cross-user or unsupported-version cursors answer `400 invalid_cursor`; they do not reset. Cursors are opaque, versioned, authenticated, tenant-bound strings. Unknown event types are valid and must be ignored by clients. Compact payloads are built from allowlists and contain no free text. Tenant-visible machine identity may include machine ID/name, online state and advertised harness capabilities; connection, pod and transient spoke IDs are forbidden.

### Webhooks

MCP tools are `webhook_create`, `webhooks`, `webhook_show`, and `webhook_delete`. Management and polling require `events:subscribe`. Delivery is additionally filtered: session/catalog events need `sessions:read`; archive/name/role/pin events need `sessions:manage`; message/Decision events need `messages:read`; launch events need `sessions:launch`. Mixed-family registration requires every applicable scope. The signing secret appears only in `webhook_create` output.

### Messaging and bulk organization

Messaging MCP tools are `mute`, `unmute`, `message_show`, `decisions`, and `decision_show`. Mute means agent-message mute. No Decision-answer tool is added.

Bulk inactive archive is a two-step contract: `archive_inactive(preview=true, inactiveFor, limit)` returns an opaque short-lived preview token and exact candidates; `archive_inactive(previewToken, confirm=true)` revalidates that exact bounded set. Sessions now active, pinned, open, foreign or already archived are skipped with reasons. The result returns `changed` and `skipped` IDs; no atomic rollback is promised.

### Event rollout

Phase 2 deploys in compatibility stages: (1) canonical writers deploy while old agent watch stays authoritative; (2) all pods are verified on the writer version; (3) events readers/API and MCP are enabled; (4) `/api/agent/watch` switches to canonical semantics; (5) compatibility code is removed only in a later release. One stable event ID is assigned before cross-pod fanout, and storage append is idempotent by that ID. Rollback readers reject unsupported versions rather than skipping records.

## Verification

Each phase uses red-first tests for conditional behavior and security boundaries, then typecheck, web/server build, targeted integration tests, repository CI, live `/mcp` discovery and at least one end-to-end call through `gateway.huynle.com`. Security coverage includes scope denial, tenant isolation, cursor tampering/expiry, bounded reads and writes, retry/idempotency, secret redaction and no prompt/message contents in compact events.

The launch phase additionally performs a real create → events → inspect/interact → end flow on an eligible node. Production infrastructure changes require an explicit preview and confirmation before application.
