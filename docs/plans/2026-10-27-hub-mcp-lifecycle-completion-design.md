# Hub MCP lifecycle completion

## Objective

Complete the public Hub MCP control-plane surface for an external orchestrator: create and supervise sessions, consume resumable events, organize and address sessions, complete messaging reads, manage durable webhooks, operate a real launch node, and archive finished work. MCP remains a thin front end to Hub Central's public agent API; it gets no separate policy path.

## Authority

Add the app-token scope `sessions:manage` for organizational changes: archive/unarchive, pin/unpin, naming, and role claim/release. It does not permit prompting, stopping, answering, approving, launching, credential management, or grant management. Existing tokens gain no new authority. `sessions:act` and `sessions:launch` continue to require grants.

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

## Ordered delivery

1. Archive/unarchive and `sessions:manage`, including token UI.
2. Resumable cursor events and SSE alignment.
3. MCP name, role claim and role release.
4. Mute/unmute, message lookup and Decision list/show.
5. Webhook MCP management and canonical event coverage.
6. Provision and verify an eligible launch node; exercise launch through end.
7. Pin/unpin and preview-first bulk archive-inactive.

The phases are sequential because they share `packages/sdk`, `packages/cli/src/mcp.ts`, central agent routes, tests and documentation.

## Compatibility and rollout

New API routes and MCP tools are additive. Persisted event data must be bounded and tolerate mixed-version rolling deploys. Cursor tokens are opaque and versioned. An expired or unknown cursor never silently skips events. Bulk organization writes have hard size limits. Webhook signing secrets and app tokens are shown once and never logged.

Each phase ships independently through CI and Flux, then refreshes the gateway snapshot. Tool writes receive correct MCP annotations for gateway review. Existing approved tools remain available while newly discovered tools stay disabled until reviewed.

## Verification

Each phase uses red-first tests for conditional behavior and security boundaries, then typecheck, web/server build, targeted integration tests, repository CI, live `/mcp` discovery and at least one end-to-end call through `gateway.huynle.com`. Security coverage includes scope denial, tenant isolation, cursor tampering/expiry, bounded reads and writes, retry/idempotency, secret redaction and no prompt/message contents in compact events.

The launch phase additionally performs a real create → events → inspect/interact → end flow on an eligible node. Production infrastructure changes require an explicit preview and confirmation before application.
