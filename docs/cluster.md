# Cluster mode

By default the hub is one process that keeps its state in files under `HUB_STATE_DIR`. **Cluster mode** runs
several hub processes ("pods") side by side, behind one load balancer, sharing their state through **Postgres**
and **Valkey** (or Redis). Any pod answers any request: spokes, `hub node` daemons, browsers and apps may land on
any pod, and a pod can be replaced at any time (a rolling update, a node drain) without dropping the hub.

```
 phones, browsers, apps ─┐                       ┌─ Postgres  (users, machines, devices, settings, agent data)
 spokes, hub node (WS) ──┼─▶ load balancer ─▶ pods ┤
                         ┘   (no sticky sessions) └─ Valkey    (who is connected where, live events, leases, codes)
```

Use it when one process is not enough or when the hub must survive a pod or node going away. For one machine
or a small team, the single process is simpler and needs nothing else.

Ready-made Kubernetes manifests are in [`deploy/k8s/`](../deploy/k8s/).

## Requirements

| | |
|---|---|
| Hub | a release with cluster mode; every pod runs the same version |
| Postgres | one database the hub owns (tested with Postgres 16). The schema is applied by `hub-server migrate` |
| Valkey or Redis | one standalone server or primary (tested with Valkey 8). Valkey/Redis *Cluster* (sharded) is not supported |
| Sign-in | `HUB_AUTH=oidc` ([multi-user](multi-user.md)): pairing mode (pairing codes, the local owner) works in a single process only, so cluster mode refuses it |
| Token keys | `HUB_TOKEN_KEYS`, the same on every pod (the keys that sign session tokens) |
| Public URL | `HUB_PUBLIC_URL`, the https origin of the load balancer |

## Configuration

Cluster mode turns on when both URLs are set; setting only one stops the hub with an error. Environment
variables win over `hub.json`.

| Env | hub.json | |
|---|---|---|
| `HUB_DATABASE_URL` | `cluster.database` | `postgres://` or `postgresql://` URL of the database (holds the password: keep it in a secret) |
| `HUB_VALKEY_URL` | `cluster.valkey` | `redis://`, `rediss://`, `valkey://` or `valkeys://` URL |
| `HUB_POD_ID` | | this pod's id, unique in the cluster (default: the hostname; in Kubernetes, the pod name). 1–128 letters, digits, `.`, `_` or `-` |
| `HUB_TOKEN_KEYS` | | required: `{"active": "<kid>", "keys": [{"kid", "secret", "created"}]}` (see the README's Central server table) |
| `HUB_AUTH` | `auth.mode` | must be `oidc`, with the usual `HUB_OIDC_*` and `HUB_ADMIN_EMAILS` |

The URLs are never logged or echoed in errors. When other users can read `hub.json`, a `cluster` URL in it that
holds a password is ignored (with a warning to `chmod 600` it), as with its API keys. In cluster mode `HUB_STATE_DIR` holds nothing:
state is in Postgres and the token keys come from `HUB_TOKEN_KEYS` (the `token-keys.json` file is never written).

## Setting up

1. **Create the database and Valkey user** (see [Security](#security)).
2. **Apply the schema**: `hub-server migrate` with `HUB_DATABASE_URL` set. It is idempotent and takes a Postgres
   advisory lock, so two runs at once are safe. Pods never migrate by themselves: a pod refuses a database whose
   schema is older than its code, so run `migrate` (in Kubernetes, the Job in `deploy/k8s/migrate/`) before every
   rollout of a new version. Each schema keeps working with the previous release, so old pods keep running while
   the new ones start.
3. **Start the pods** with the settings above. `/readyz` answers 200 once the pod reaches Postgres and Valkey.
4. **Register** `<public URL>/auth/callback` as the OIDC redirect URI, as for any multi-user hub.

### Moving a single-process hub into a cluster

`hub-server import` copies a single-process hub's state directory into Postgres. Machines and devices keep their
tokens (only token hashes are stored), so nothing needs to be enrolled or paired again.

1. **Stop the single-process hub**, so its files are complete. Keep its state directory.
2. **Migrate** the database (`hub-server migrate`).
3. **Check** with a dry run: `hub-server import --state <dir> --dry-run` reports, per collection, what it would
   create, what is already there unchanged and what conflicts. Nothing is written.
4. **Import**: `hub-server import --state <dir>`. It is idempotent: rows already in the database are kept and listed
   as conflicts; `--force` overwrites them. The exit code is 1 when a row failed.
5. **Carry the token keys over**: `hub-server import --state <dir> --print-token-keys` prints the old
   `token-keys.json` as the `HUB_TOKEN_KEYS` value on stdout (the report goes to stderr). Put it in the pods'
   secret, so session tokens the old hub issued keep verifying. The keys are never stored in the database.
6. **Start the pods** with `HUB_AUTH=oidc`. A hub that ran in pairing mode had one owner, `local`: the first admin
   who signs in takes over everything `local` owned ([multi-user](multi-user.md)).
7. **Keep the public URL**: point its DNS name at the cluster's load balancer. Spokes, nodes, apps and browsers
   then carry on with their tokens and cookies. At a new URL, spokes have to be set up again (`/hub` →
   **Server**; machine tokens belong to one hub) and browsers sign in again.

`import` needs only `HUB_DATABASE_URL` and read access to the state directory; run it wherever that directory is
(the old server, or a machine you copied it to).

## Kubernetes

[`deploy/k8s/`](../deploy/k8s/) has a Kustomize base. Nothing in it is applied for you; review it and replace the
example host, emails, selectors and the image tag (`VERSION`) first.

| File | |
|---|---|
| `namespace.yaml` | the `hub` namespace (Pod Security `restricted`); apply it first |
| `secret.example.yaml` | template of the Secret `hub` (placeholders only; create the real one outside Git, or encrypt it with SOPS) |
| `migrate/` | the `hub-server migrate` Job (its own Kustomization: re-create it for each release) |
| `deployment.yaml` | 2 replicas spread across nodes and zones, `HUB_POD_ID` from the pod name, `/readyz` readiness, `/healthz` liveness, `preStop` sleep 5 s, 60 s grace period, non-root, read-only root filesystem with an `emptyDir` state dir, resource requests |
| `service.yaml` | ClusterIP on port 80, no session affinity |
| `pdb.yaml` | PodDisruptionBudget `minAvailable: 1` |
| `networkpolicy.yaml` | default deny; the server takes traffic from the ingress controller and talks to DNS, Postgres, Valkey and HTTPS; the Job reaches DNS and Postgres |
| `ingress.yaml` | an Ingress example (ingress-nginx annotations) |
| `traefik/ingressroute.yaml` | optional: Traefik IngressRoute, with the entryPoint timeouts to raise |
| `flux/hub.yaml` | optional: Flux example (secrets with SOPS → migrate → hub) |

```sh
kubectl kustomize deploy/k8s            # render
kubectl kustomize deploy/k8s/migrate
```

The manifests are checked offline with `kubeconform -strict` (Traefik and Flux objects against their CRD
schemas) and `test/deploy-k8s.test.ts`.

### Ingress and proxies

- **No sticky sessions.** Any pod serves any request; a pod that goes away sends its clients to the others.
- **WebSockets** on `/spoke/ws` (spokes and `hub node`) and **SSE** on `/api/events` and `/api/agent/watch` are
  long-lived: give them long read and write timeouts (an hour, or none) and turn response buffering off. The hub
  pings WebSockets and SSE streams every 20 s, so idle timeouts above 60 s keep idle connections open.
- **Plain requests** can take up to about 60 s (agent long-polls with `wait` ≤ 60 s): allow at least 120 s.
  Traefik v3's default entryPoint `readTimeout` is 60 s; raise it (see `traefik/ingressroute.yaml`).
- **Body size**: up to `HUB_MAX_AUDIO_BYTES` (default 10 MiB) for Voice uploads.

## Draining and readiness

| Endpoint | Answers | Use for |
|---|---|---|
| `/healthz` | 200 while the process runs | liveness: a database outage must not restart every pod |
| `/readyz` | 200 when ready; 503 while draining, or when Postgres (`SELECT 1`) or Valkey (`PING`) does not answer within 2 s | readiness: take the pod out of the load balancer |

Neither endpoint needs credentials or says more than ok / not ok.

On **SIGTERM** (a rollout, a node drain, `docker stop`) a pod drains:

1. `/readyz` answers 503; new WebSocket upgrades are refused with 503 and `Retry-After`.
2. Each spoke and node gets `bye {reason: "draining", retryAfterMs}` once its requests in flight are answered,
   and the socket closes with code 4006. They reconnect after a random 0–`retryAfterMs` (5 s), through the load
   balancer, to another pod.
3. The pod gives up its leader leases at once (another pod takes the timed jobs over, see below) and withdraws its
   connections from the cluster view.
4. SSE streams end with `retry: 2000`; browsers reconnect to another pod and resume from their last event.
5. It waits for requests in flight, at most 50 s, then stops.

A second SIGTERM or SIGINT during the drain stops at once (exit 1). SIGINT alone (Ctrl-C) stops without draining.
In Kubernetes, `terminationGracePeriodSeconds: 60` covers the 5 s `preStop` sleep (which lets endpoints and the
ingress stop sending new requests first) and the 50 s drain.

## How it works

### State

Durable state (users, machines, devices, push subscriptions, settings, the audit log, agent data such as
messages, names and launches) is in Postgres. Each pod caches what it reads; a write tells the other pods which
records changed (topic `store.changed`, keys and versions only), and every pod also reloads its cache every
30 s in case it missed a message. Writes are version-checked, so two pods writing the same record never lose
an update. Token checks that matter for security (a device, machine, session, launch or app token still valid)
read the database, not the cache, and every pod re-checks its sockets every 30 s, closing those of revoked
machines and disabled users.

Short-lived shared data is in Valkey: pairing, login and link codes, enrollments, OIDC sign-in state, rate-limit
counters, push cooldowns and answered-request markers. A code issued by one pod is redeemed on any other.

### Routing

Each pod is the only writer of its own WebSocket connections. When a spoke or node connects, its pod records
`connection → pod` in Valkey (refreshed every 15 s, expiring after 45 s). A request for a session whose spoke is
on another pod is sent to that pod over Valkey (its topic `pod.<id>.rpc`); the owning pod checks the tenant
again and answers. A pod that dies without cleaning up drops out of the directory within 45 s.

So that every pod knows every connection (which sessions exist, who owns them, which process to route a turn
to), each pod publishes a summary of its connections: deltas on `cluster.view` shortly after a change, plus a
full copy in Valkey refreshed every 15 s and dropped 45 s after its pod stops refreshing it.

### Live events

Live events (session updates, messages, launches) are published per user (`user.<id>.live`). Every event except
streaming text deltas is also appended to the user's event stream in Valkey (the last 2000 events, at most
5 minutes old), so an SSE client that reconnects to *another* pod with `Last-Event-ID` gets what it missed; when
the gap is too old it gets a `resync` and refetches. Streamed text (deltas, reasoning) is sent live only: a
console that reconnects refetches the transcript. Message and launch feeds (`feed.messages`, `feed.launches`) reach every pod, so a watcher
anywhere sees them.

### Leaders

Timed jobs run on one pod at a time, the holder of a fenced lease in Valkey: decision deadlines (`decisions`),
message re-wakes (`delivery`), the launch supervisor (`launches`) and the webhook sender (`webhooks`). A lease
lasts 15 s and is renewed every 5 s. A draining pod releases its leases and another pod takes over within one
message; a pod that dies is replaced within about 20 s. Requests that need a job (such as stopping a launch) are
forwarded to its leader; work that any pod can do (accepting a launch, an answer, a webhook registration) is
done where the request lands. Smaller leases keep one pod at a time on a session's turn (`turn:<sessionID>`)
and on flushing a session's messages (`deliver:<user>:<session>`).

### Where things are

Postgres: `hub_state` (one row per record: `user_id`, `collection`, `key`, `value` jsonb, `version`; hub-wide
records under the user `_hub`), `hub_claims` (unique claims such as names) and `hub_schema` (applied
migrations).

Valkey keys, by prefix:

| Prefix | |
|---|---|
| `kv:` | short-lived values: `kv:dir:<connection>` (where a connection is), `kv:pod:<id>` (a pod is alive), codes, sign-in state, cooldowns |
| `ctr:` | rate-limit and budget counters (fixed windows) |
| `lock:`, `fence:` | leases (`lock:leader:<job>`, `lock:turn:<session>`, `lock:deliver:<user>:<session>`, …) and their fencing counters |
| `hub:ev:{<user>}` | a user's event stream (and its `:epoch`) |
| `hub:cat:{<user>}` | a user's catalog reports and the pods' cluster-view copies |

Pub/sub channels are under `hub:bus:` (`hub:bus:t:<topic>` for topics such as `store.changed`, `cluster.view`,
`cluster.close`, `cluster.recommend`, `user.<id>.live`, `live.catalog`, `feed.messages`, `feed.launches`;
`hub:bus:rpc:<topic>` for requests such as `pod.<id>.rpc`; `hub:bus:reply:<instance>` for answers).

## Security

- **Secrets**: `HUB_DATABASE_URL`, `HUB_VALKEY_URL` (both carry passwords), `HUB_TOKEN_KEYS` and
  `HUB_OIDC_CLIENT_SECRET` belong in a Kubernetes Secret (or SOPS-encrypted in Git). Anyone with
  `HUB_TOKEN_KEYS` can mint session tokens; anyone with database access can read token hashes and agent data.
- **TLS**: add `?sslmode=require` (or `verify-full`) to the Postgres URL and use `rediss://` / `valkeys://` when
  the traffic leaves a trusted network.
- **Valkey ACL**: give the hub its own user limited to its keys and channels, e.g.

  ```
  ACL SETUSER hub on >PASSWORD resetchannels &hub:bus:* resetkeys ~kv:* ~ctr:* ~lock:* ~fence:* ~hub:* -@all +@read +@write +@scripting +@pubsub +@connection -@dangerous
  ```

  (the hub uses plain key commands, streams, hashes, sets, Lua scripts and pub/sub). Do not share the database
  or the Valkey keyspace with other applications.
- **Postgres**: a database and role for the hub only; `migrate` needs to create tables, the pods need
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` on them.
- **NetworkPolicy**: `deploy/k8s/networkpolicy.yaml` admits only the ingress controller and lets the pods reach
  only DNS, Postgres, Valkey and HTTPS (sign-in, push, speech, webhooks). Pods never talk to each other directly.
- The pods run as a non-root user with a read-only root filesystem and no capabilities; they need no Kubernetes
  API access (`automountServiceAccountToken: false`).
- `/readyz` and `/healthz` are public and reveal nothing about the backends.

## Limits and known gaps

- **Valkey is a single point of coordination.** While it is unreachable, pods are not ready, cross-pod routing,
  live events and leases stop, and sign-in and pairing codes cannot be issued. Pub/sub delivery is at most once:
  messages sent while a pod's connection to Valkey is down are lost. The 30 s cache reload, the view's 15 s
  refresh and SSE `resync` repair most of it; some live updates in that window are not replayed.
- **Valkey/Redis Cluster** (sharded) is not supported: some scripts touch keys they were not given.
- **Postgres** cannot store the NUL character (`\u0000`) in jsonb; such values are refused.
- **Pairing mode** (one owner, pairing codes, local auto-approval) is single-process only.
- **Activity digest notifications** are collected per pod; text deltas are not resumable after a reconnect.
- **Long-polls** (`wait`) are not counted as requests in flight while draining: a long-poll on a draining pod may
  end with a connection error, and the client retries.
- **Audit order**: entries written by two pods in the same millisecond may be listed in either order.
- Writes by the launch supervisor are not yet checked against its lease's fence; a deposed leader's last write
  can land after a new leader started.
- Run the same version on every pod; mixed versions are expected only briefly, during a rollout.
