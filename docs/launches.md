# Launches

A **launch** asks the hub to start an agent session for you on one of your machines: in a fresh git worktree (or
a checkout or a clone), with a name, roles, labels and a first prompt, and to end it when it is done. You, a
script or an app say *what* to run; the hub picks a machine, a `hub node` daemon on that machine prepares the
workspace, and the machine's harness service (the OpenCode background service, `opencode serve --service`) creates
the session in it.

```
hub launch --branch feat/search --name search --role builder --label task=42 --prompt "Add full-text search"
```

The parts:

| Part | Where | Does |
|---|---|---|
| hub | your hub | accepts launches, applies grants, caps and the kill switch, places them on nodes, runs each to its end, sends events and webhooks |
| `hub node` | each machine that runs launches | prepares, inspects and cleans up workspaces under its `workspaceRoots`; starts nothing and runs no commands for the hub |
| service spoke | the same machine | the OpenCode plugin in the background service: creates the session in the prepared directory (only under the node's roots) |

## Starting a launch

`POST /api/agent/launches` with a launch spec (below), or `hub launch` (the CLI turns its flags into the spec), or
the SDK's `hub.launches.create(spec)`, or the MCP tool `launch`.

```http
POST /api/agent/launches
Authorization: Bearer hat_…
Content-Type: application/json

{
  "key": "task-42",
  "name": "search",
  "roles": ["builder"],
  "workspace": { "repo": "/Users/you/projects/app", "branch": "feat/search", "base": "main" },
  "placement": { "labels": { "pool": "laptops" } },
  "prompt": "Add full-text search",
  "labels": { "task": "42" },
  "end": { "when": "idle", "timeout": "4h", "cleanup": "remove" }
}
```

| Route | Answers |
|---|---|
| `POST /api/agent/launches` | `201 {launch}`; the same `key` with an equivalent body again: `200 {launch}` (the existing launch, also once it ended); the same key with another body: `400 invalid` |
| `GET /api/agent/launches?state=queued,running&label=task=42` | `{launches}`, oldest first; every `label` given must match |
| `GET /api/agent/launches/:id` | `{launch}` |
| `DELETE /api/agent/launches/:id` | `200 {launch}`, ended with outcome `stopped`; already ended: `410 gone` |

A launch as the API shows it: `{id, state, reason, spec, created, updated, by, machineID?, directory?, sessionID?,
name?, outcome?, artifacts?, history}`. `by` is `user`, `app:<token id>` or the launching session's ID. `history`
lists each step with its state, reason and time (the first step and the latest ones, at most 20). Ended launches
are kept for 7 days (at most 500 per user), then removed and their keys freed.

The CLI's exit codes follow the error codes: `invalid` 2, `not_found` and `name_taken` 3, `forbidden` and `paused` 5,
`rate_limited` 6, `gone` 8.

### Who may launch

- **Users** always, on their own machines.
- **App tokens** with scope `sessions:launch` **and** a grant (verb `launch`) whose projects cover
  `workspace.repo`; without the grant `403 forbidden`. Each new launch spends one action of the grant (its
  `maxActionsPerHour`); an idempotent repeat spends none.
- **Sessions** only through their act token (the OpenCode `hub` tool), under such a grant; a session's shell token
  never launches (`403`).
- The kill switches (`PUT /api/agent/acting`, the admin's `PUT /api/admin/agents/acting`) pause launching by apps
  and sessions (`423 paused`); the user's own launches go on.
- Apps and sessions see and stop only the launches they started; any other launch answers `404 not_found`.
- A launched session gets no powers beyond its launcher's (a spec cannot carry a grant).

Every launch and stop is in the user's agent audit (verbs `launch` and `launch.stop`).

## The spec

Unknown fields are refused (`400 invalid`), as is anything malformed; the hub fills in the defaults.

| Field | Default | Rules |
|---|---|---|
| `key` | none | 1–200 visible ASCII characters; makes retries safe (see above) |
| `name` | none | the session's `@name` without the `@`: `[a-z0-9-]`, 2–40, not reserved; refused with `name_taken` when a session or another live launch holds it |
| `roles` | `[]` | up to 10 role names (`reviewer`, `reviewer.project`); a role the launcher may not claim is noted in the launch's reason, not fatal |
| `harness` | `opencode` | the harness the session runs in |
| `agent` | the harness's default | `[A-Za-z0-9_.-]`, up to 80 |
| `model` | the harness's default | `provider/model`, up to 200 characters |
| `workspace.repo` | (required) | absolute path of the repository **on the node**; must resolve (through symlinks) under one of the node's `workspaceRoots` |
| `workspace.mode` | `worktree` | `worktree`, `checkout` or `clone` |
| `workspace.branch` | none | required for `worktree`; a name `git check-ref-format --branch` accepts, printable ASCII, no part starting with `-` or `.`, up to 200 |
| `workspace.base` | `HEAD` | what a new branch starts from (same rules as `branch`) |
| `workspace.remote` | none | required for `clone`: `https://host/path`, `ssh://[user@]host/path` or `user@host:path`, no credentials, up to 500 |
| `runtime` | `{kind: "host"}` | `host` (the machine's own harness service); `openshell` is reserved for sandbox runtimes (clone workspaces only) that no node offers yet |
| `placement.labels` | `{}` | node labels to match |
| `placement.machine` | none | a machine ID or name |
| `placement.mode` | `require` | `require` (labels and machine must match) or `prefer` (they only rank nodes) |
| `prompt` | none | the first prompt, up to 10,000 characters |
| `labels` | `{}` | your own tags, never interpreted by the hub: up to 32, keys `[A-Za-z0-9._/-]` up to 63, values up to 256 characters |
| `end.when` | `idle` | `idle`, `asked` or `never` (see *Ending*) |
| `end.timeout` | none | 1 minute to 30 days (`90`, `30m`, `4h`, `2d`), counted from the launch's creation |
| `end.cleanup` | `keep` | `keep` or `remove` the workspace at the end (see *Workspaces*) |

## States and outcomes

```
queued → placing → provisioning → running → ended {outcome}
            ↘ queued (no node can take it yet)          (every live state may end)
```

| State | Means |
|---|---|
| `queued` | accepted, waiting for a node (the reason says why: no node fits, or the fitting ones are full) |
| `placing` | a node was picked |
| `provisioning` | on a node: the workspace is prepared, the session created, named, given its roles and the hub's primer, then prompted |
| `running` | the session runs; `sessionID`, `name` and `directory` are set |
| `ended` | final, with an `outcome` and, once the session was prompted, `artifacts` |

| Outcome | When |
|---|---|
| `idle` | the session finished its work (see *Ending*) |
| `needs_user` | `end.when: asked` and the session waits on you (a permission, a question, an ask or a Decision); the workspace is always kept |
| `timeout` | `end.timeout` passed; the hub stopped the session |
| `stopped` | stopped through `DELETE` (or `hub launches stop`); a running session is stopped first |
| `failed` | a step failed (the reason says which and why) |
| `lost` | the node went away while provisioning (or did not come back within 5 minutes of a hub restart), or the session was not reported for 10 minutes |

`artifacts` are what the node found in the workspace at the end: `{branch, base?, head, commits?, dirty}`
(`commits`: the commits on the branch since `base`).

### Ending

- **`idle`**: only after the prompt was seen working, the session must be idle by real evidence (the harness says
  so, nothing in its session tree runs, no hub turn holds it), with no pending permission or question, none of its
  own asks waiting and none of its Decisions open, unchanged for 30 seconds.
- **`asked`**: as `idle`, and also ends `needs_user` when a question stays open that long.
- **`never`**: only a stop or the timeout ends it.

When a launch ends, the hub collects its artifacts and asks the node to clean up (see *Workspaces*). If the node is
away then, the cleanup waits and runs when it reconnects.

A restarted hub carries on: queued launches are placed again, provisioning ones continue from their last recorded
step, and running ones are watched again.

### Events

Every change of a launch is an SSE event `{type: "launch", launch}` on the user's `/api/events` stream, and a
`launch` event on `GET /api/agent/watch` (without the prompt). The `placing` step and a fall back to `queued` are
not reported; they are in the launch's history.

## Placement and caps

A launch goes to one of **its user's own** connected nodes that:

- is not draining, offers the runtime and the harness, and lists a workspace root containing `workspace.repo`;
- for `host` launches, has a connected service spoke on the same machine that announces `launch`;
- matches `placement.machine` and `placement.labels` (mode `require`), and has a free slot.

Of the nodes that fit, the hub picks the preferred one (mode `prefer`), then the one with most free slots, then the
lowest machine ID. Launches are placed oldest first; one that cannot be placed waits and does not hold back later
ones. A node's labels are its own `os` and `arch` plus the `labels` in its node.json.

Per-user caps in `hub.json` (`agents.launches`, each a whole number from 1 to 100,000):

| Field | Default | |
|---|---|---|
| `maxQueued` | 50 | launches waiting to be placed; past it a new launch is `429 rate_limited` |
| `maxActive` | 4 | launches placing, provisioning or running; the next ones wait `queued` |
| `perHour` | 60 | new launches per clock hour; past it `429 rate_limited` (with the retry time) |

```json
{ "agents": { "launches": { "maxActive": 2, "perHour": 20 } } }
```

## hub node

`hub node` runs on each machine that should take launches. It needs:

1. an **enrolled machine**: the OpenCode plugin's `/hub` dialog enrols it; the node reads the hub URL and machine
   token from the spoke's `~/.config/hub/config.json` (read-only; spoke and node share the machine);
2. a **node.json** beside it (`~/.config/hub/node.json`, or next to `$HUB_SPOKE_CONFIG`):

```json
{ "workspaceRoots": ["/Users/you/projects"], "labels": { "pool": "laptops" }, "slots": 4, "memoryMB": 49152 }
```

| Field | Default | |
|---|---|---|
| `workspaceRoots` | none | absolute paths (not `/`), at most 32; every workspace must resolve under one. With none the node takes nothing |
| `labels` | `{}` | added to the node's `os` and `arch` labels for placement |
| `slots` | 4 | launches the node holds at once (from prepare until cleanup), 1–10,000 |
| `memoryMB` | none | reported to the hub; not matched yet |
| `openshell` | none | `{ "enabled": true, "gateway"?: name, "image"?: ref, "profiles"?: {…} }`: also offer the `openshell` runtime (sandboxes through the `openshell` CLI, in its workspace `hub`). The node then announces the `sandbox` feature (start/stop), reports its profiles and the gateway's compute drivers (backends), and at startup reports the sandboxes labelled `hub.machine=<this machine>` as launches (`running` or `stopped`) so the hub reconciles them. An unusable CLI is logged and the node offers `host` only |

The OpenCode service spoke reads the same `workspaceRoots` and creates launch sessions only under them.

Commands:

| Command | |
|---|---|
| `hub node run` | runs the daemon in the foreground until Ctrl-C or SIGTERM; exits 1 when the machine is not enrolled, 78 when node.json lists no workspace roots, 0 after a clean stop |
| `hub node install [--dry-run]` | writes a launchd agent (macOS, `~/Library/LaunchAgents/io.github.huynle.hub-node.plist`) or a systemd user unit (Linux, `~/.config/systemd/user/hub-node.service`) from the templates in `scripts/`, and **prints** the `launchctl` / `systemctl` commands that load it (hub never runs them). Re-run it after upgrading OpenCode: the unit records the runtime's path |
| `hub node uninstall [--dry-run]` | removes the unit file and prints the commands that stop the service |
| `hub node status` | the unit file (up to date or not), the enrolment (never the token), node.json, and how to inspect the service |

The daemon keeps one outbound WebSocket to the hub's `/spoke/ws` (with the machine token), reconnects with backoff,
retries a hub that does not serve nodes only every 30 minutes, and stops for good when the machine is revoked. The
hub can ask it for exactly four things per launch: prepare, collect, cleanup and cancel. There is no way for the hub
to run commands on the node.

### Workspaces (host runtime)

| Mode | Workspace | At the end, with `cleanup: remove` |
|---|---|---|
| `worktree` | `<repo>/.worktrees/<branch>`, a new `git worktree` on the branch (created from `base` when the branch does not exist); a branch that already has a worktree reuses it | `git worktree remove` (never forced); the branch stays |
| `checkout` | the repository itself, switched to the branch | never removed |
| `clone` | a fresh clone of `remote` at `repo` (which must not exist yet) | removed when it has no unpushed commits |

The node is careful with your files:

- Every path is resolved through symlinks and must stay under a workspace root.
- Git runs without a shell, with `--` before paths, only over https and ssh (no `ext::`, `file://` or local
  remotes), without terminal or credential prompts, without inherited `GIT_*` settings (except the ssh ones), with
  a time limit, and is killed (with what it started) on cancel.
- Each workspace it makes carries a marker naming the launch in its git directory. Cleanup removes only a workspace
  its own launch made, and never one that was reused, a checkout, a workspace root, or one with uncommitted changes
  (or, for clones, unpushed commits); the launch's reason says why a workspace was kept.
- The cleanup policy is `keep` for `needs_user`, `remove` when the session was never prompted (the launch failed
  before its work began), and `end.cleanup` otherwise.

Add `.worktrees/` to the repository's `.gitignore` so the worktrees do not show up as untracked files in the main
checkout.

## Webhooks

Users, and app tokens with scope `sessions:launch`, register URLs the hub POSTs launch events to.

| Route | Answers |
|---|---|
| `POST /api/agent/webhooks {url, events?, label?}` | `201 {webhook, secret}`; the `whsec_…` secret is shown only here. `events`: exact types or `launch.*` (the default) |
| `GET /api/agent/webhooks` | `{webhooks}` (never the secrets) |
| `GET /api/agent/webhooks/:id` | `{webhook, deliveries}` (recent deliveries and their status) |
| `DELETE /api/agent/webhooks/:id` | `204`; its pending deliveries are dropped |

At most 20 per user. A user manages all their registrations, an app token only the ones it made; an app's
registrations get only the events of launches that app started and stop when its token is revoked or loses the
scope. Sessions cannot register webhooks.

Event types: `launch.queued`, `launch.provisioning`, `launch.running`, `launch.ended`. The body:

```json
{
  "id": "evt_…",
  "type": "launch.ended",
  "source": "https://hub.example.com",
  "subject": "l_…",
  "time": "2026-10-25T09:00:00.000Z",
  "user": "…",
  "schemaVersion": 1,
  "data": { "launch": { "id": "l_…", "state": "ended", "outcome": "idle", "history": [] } }
}
```

`data.launch` is the launch as the API shows it. Headers: `Hub-Event` (the type), `Hub-Delivery` (stable across
retries) and `Hub-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256, keyed with the secret, of
`<t>.<raw body>`.

Delivery is **at least once**: answer 2xx quickly; anything else (or no answer within 10 seconds) is retried after
10 s, 1 min, 5 min, 30 min, 2 h and 6 h, then given up. Deduplicate by `Hub-Delivery`. Deliveries run concurrently,
so they can arrive **out of order**: order a launch's events by its `history` (or `updated`), not by arrival. The hub
reads at most 64 KiB of a response and never follows redirects.

### Verifying a delivery

Always check the signature against the **raw** body before parsing it, in constant time, and refuse old timestamps
(replays). The SDK does all of that:

```ts
import { verifyWebhook } from "@huynle/hub-sdk"

Bun.serve({
  async fetch(request) {
    const body = await request.text()
    const check = verifyWebhook({ body, headers: request.headers, secret: process.env.HUB_WEBHOOK_SECRET! })
    if (!check.ok) return new Response(check.reason, { status: 401 }) // missing, malformed, stale or mismatch
    const event = JSON.parse(body)
    // check.delivery for deduplication, event.data.launch for the launch
    return new Response("ok")
  },
})
```

`secret` may be a list while you rotate secrets; `tolerance` (seconds, default 300) bounds the timestamp's age.

### Where webhooks may go

By default only `https://` URLs on public hosts: the host is resolved at registration and **again before every
send**, and loopback, private, link-local and other local addresses are refused. A self-hosted hub whose receivers
live on the local network may allow them in `hub.json`:

```json
{ "agents": { "webhooks": { "allowPrivate": true } } }
```

`allowPrivate` admits `http://` and private or loopback hosts for every user of the hub; turn it on only when you
trust everyone who can register webhooks.

## Tenancy

Launches, their keys, webhooks and their deliveries are per user. Another user's launch or webhook answers
`404 not_found` on every route, exactly like an unknown one; lists never include them; two users can use the same
`key`. Launches are placed only on the launching user's own machines. See [multi-user.md](multi-user.md).
