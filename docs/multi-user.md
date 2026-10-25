# Multi-user hub (0.3.0) — design contract

One hub can serve several people. Each person signs in, and sees and controls only their own machines,
sessions, phones and speech settings. Without sign-in configured the hub stays the single-owner hub it
has always been.

## Auth modes

| `HUB_AUTH` | Who can use the hub | How a browser gets access |
|---|---|---|
| `pairing` (default) | One owner (the implicit user `local`) | Pairing code (`/hub → Pair a phone`, or the bootstrap code in the log), one-time login links |
| `oidc` | Users allowed by the allow-list | "Sign in with Google" (any OpenID Connect issuer); pairing codes and login links still work and belong to the issuing machine's owner |

`oidc` settings (env, or the `auth` object in `hub.json`):

| Env | hub.json | Default | Meaning |
|---|---|---|---|
| `HUB_AUTH` | `auth.mode` | `pairing` | `pairing` or `oidc` |
| `HUB_OIDC_ISSUER` | `auth.issuer` | `https://accounts.google.com` | Issuer; discovery at `<issuer>/.well-known/openid-configuration` |
| `HUB_OIDC_CLIENT_ID` | `auth.clientId` | — | Required for `oidc` |
| `HUB_OIDC_CLIENT_SECRET` | `auth.clientSecret` | — | Required for `oidc` (secret: never logged, never returned) |
| `HUB_OIDC_ALLOWED` | `auth.allowed` | — | Comma list of emails and/or `@domain` entries. Required for `oidc` (no open sign-up) |
| `HUB_ADMIN_EMAILS` | `auth.admins` | — | Comma list of admin emails (also allowed). At least one required for `oidc` |

The redirect URI to register with the provider is `<publicURL>/auth/callback`.

## OIDC flow

Authorization code flow with PKCE (S256), `state` and `nonce`, scope `openid email profile`.

1. `GET /auth/login?next=/path` → stores `{state, nonce, verifier, next, expires(10 min)}` server-side
   (in memory, keyed by state; also a short-lived `voice_oidc` cookie holding the state, HttpOnly,
   SameSite=Lax) → 302 to the provider's authorization endpoint.
2. `GET /auth/callback?code&state` → state must match the cookie and an unexpired pending entry
   (single use). Exchange the code at the token endpoint (confidential client, `client_secret_post`)
   over TLS. Validate the ID token claims (the token comes straight from the token endpoint over TLS, so
   OIDC Core 3.1.3.7 allows skipping the signature check): `iss` equals the issuer, `aud` contains the
   client ID, `exp` in the future, `nonce` matches, `email` present and `email_verified` true.
3. The email must be allowed (`allowed` or `admins`); otherwise 403 page "Not allowed". Allowed →
   upsert the user, create a device for this browser (name from the user agent), set the `voice_device`
   cookie exactly like pairing does, 302 to `next` (same-origin path only).
4. `POST /api/logout` removes the device (unchanged).

Errors from the provider (`error` query param) show a readable page with a link back to `/`.

## Data model (state.json, mode 0600)

```ts
interface UserRecord {
  id: string            // "local" in pairing mode; random base64url otherwise
  email?: string        // lowercased; absent for "local"
  name?: string
  role: "admin" | "user"
  created: number
  lastSeen: number
  disabled?: boolean
  speech?: StoredSpeech // per-user speech settings (same shape as today's state.speech)
}
MachineRecord  += ownerID: string
DeviceRecord   += ownerID: string
StateData      += users: UserRecord[]; audit: AuditEntry[]   // audit ring, newest last, max 500
                  speech (existing) becomes the SERVER DEFAULT speech settings
interface AuditEntry { at: number; actor: string /* userID or "system" */; action: string; target?: string; detail?: string }
```

Migration on load (idempotent): ensure user `local` exists (role admin); any machine/device without
`ownerID` gets `ownerID: "local"`. In `oidc` mode, the first time an admin email signs in, every record
owned by `local` is reassigned to that admin (audit `migrate.local`), and `local` is kept but disabled.

## Ownership rules

- Device-code enrollment: the approving device's owner becomes the machine's owner.
- Pairing code requested by a spoke (`pairCode`) → the new device belongs to the machine's owner.
- One-time login link (`openLink`) → logs in as (creates a device for) the machine's owner.
- Bootstrap pairing code (no devices yet) and loopback first-machine auto-approve: `pairing` mode only.
- A disabled user's devices and machines are refused (401 / WebSocket `bye "revoked"`).

## Isolation

Every authenticated request resolves `device → user`. A user only ever sees and acts on:

- machines with `ownerID === user.id` (catalog, `GET /api/machines`, SSE `catalog`),
- sessions reported by those machines' processes (all session endpoints; anything else → **404**
  `{"error":"Not found"}` — never 403, so IDs don't leak),
- their own devices, push subscriptions and speech settings.

SSE: each connection belongs to one user and only receives messages about that user's machines and
sessions (`catalog`, `status`, `delta`, `reasoning`, `say`, `heard`, `activity`, `conversation`,
`handoff`). `enrollment` events go to admins only. Push notifications go only to the session owner's
devices.

Admins do **not** see other users' sessions. They manage users, machines and devices.

## API

Unchanged paths keep their shapes; they are filtered by owner.

New or changed:

| Method + path | Who | Notes |
|---|---|---|
| `GET /api/me` | any | `{device:{id,name}, user:{id, email?, name?, role}, auth:"pairing"\|"oidc"}` |
| `GET /api/auth` | public | `{mode, signIn: "/auth/login" \| null}` — lets the pairing page show "Sign in with Google" |
| `GET /auth/login`, `GET /auth/callback` | public | see OIDC flow |
| `GET /api/enrollments` | admin | pending enrollments (users approve through `/approve?code=` only) |
| `POST /api/enrollments/:code/approve\|deny` | any | approver becomes owner |
| `GET /api/settings/speech` | any | the caller's effective settings (user → server default → hub.json → env), `ready`, keys masked, plus `scope: "user"` and `default: {...masked server default...}` |
| `PUT /api/settings/speech` | any | updates the caller's own settings |
| `GET/PUT /api/settings/speech/default` | admin | the server default (today's behavior) |
| `GET /api/admin/users` | admin | `[{id,email,name,role,disabled,created,lastSeen,machines:n,devices:n}]` |
| `PUT /api/admin/users/:id` | admin | `{role?, disabled?}`; cannot demote/disable the last active admin |
| `GET /api/admin/machines` | admin | all machines with owner email |
| `DELETE /api/admin/machines/:id`, `DELETE /api/admin/devices/:id` | admin | revoke anyone's |
| `GET /api/admin/audit` | admin | newest first, max 200 |
| `GET /api/devices`, `DELETE /api/devices/:id` | any | own devices only |
| `POST /api/devices/link` | any | `{code, expiresAt, hub, url}`: a single-use app link code (256-bit, 5 min) for the caller; `url` is `hubapp://link?hub=<public URL>&code=<code>` |
| `POST /api/devices/redeem {code, deviceName?, publicKey?}` | public | `{device, token}`: a new device of the code's issuer; `token` is its device token (`Authorization: Bearer`), no cookie |
| `DELETE /api/machines/:id` | any | own machines only (admins use the admin route for others') |

In `pairing` mode the single user is admin, so everything works as before.

## Agent actors and tokens

`/api/agent/*` (the agent API, see the README's *Agent identity*) resolves every request to exactly one actor
from exactly one credential. Credentials never mix: the device cookie together with a bearer token the hub
recognises is refused (`400 invalid`); a bearer the hub does not know next to the cookie (e.g. one an auth proxy
adds) is ignored.

| Actor | Credential | Format and storage | Lifetime | Ends when |
|---|---|---|---|---|
| `user` (`via: "cookie"`) | `voice_device` cookie | random secret; only its hash is stored (DeviceRecord) | until revoked | the device is revoked, the user signs out or is disabled |
| `user` (`via: "device-token"`) | `Authorization: Bearer <device token>` | the same secret as the cookie, issued by `POST /api/devices/redeem` for a link code | until revoked | as above; bearer requests skip the same-origin check |
| `session` `{userID, machineID, sessionID}` | `Authorization: Bearer hst1.…` | `hst1.<payload>.<HMAC-SHA256>`, claims `typ, uid, mid, sid, exp, kid, ue, me, aud`; minted by the hub, never stored | 24 h (renewed with ⅓ left) | see *Epochs and revocation* |
| `app` `{userID, tokenID, scopes, label?}` | `Authorization: Bearer hat_<id>_<secret>` | created by a user (`POST /api/agent/app-tokens`, shown once); only a sha256 hash is stored; at most 50 per user | until revoked | revoked (`DELETE /api/agent/app-tokens/:id`) or the user disabled |

What each actor may do:

- **user**: everything on `/api/agent`, and the console routes.
- **session**: read every session of its user; name, claim and release roles **for its own session only**
  (`403 forbidden` for another one); send, answer and read its own messages (never to itself); no console
  routes (`403`), no token management, no messaging switch.
- **app**: what its scopes allow: `sessions:read` (status, sessions, show, log, watch, who), `messages:send`
  (msg, ask, reply, decline, mute, unmute) and `messages:read` (inbox, messages/:id, its own `message` watch
  events); `whoami` always. No other writes, no console routes, no token management (`403`).

Messages are per user like everything else: another user's session, name, role or message id answers
`404 not_found` on every message route, exactly like one that does not exist, and admins get no access to them.

**Session token delivery.** The hub mints a token for every session (subagents included) that a spoke reports for
its own user, and pushes it with the `sessionTokens` op only to spokes that announce the feature; spokes of other
harnesses that do not announce it get none. The spoke keeps tokens in memory (never logged, dropped when they
expire, when the session is deleted or when the connection changes) and puts a session's token into the shells
that session starts (`HUB_SESSION_TOKEN`, with `HUB_URL`). Tokens are sent again after a reconnect, an epoch or key
change, and by a 10-minute sweep before they get old. A token in a shell is visible to that shell's child
processes; its reach is limited by its expiry, the session's liveness and the session verbs above.

**Signing keys.** HMAC keys live in `<HUB_STATE_DIR>/token-keys.json` (0600, created on first use) or come from
`HUB_TOKEN_KEYS` (same JSON, e.g. shared by several hub instances). Older keys are kept so tokens they signed still
verify until they expire.

### Epochs and revocation

Each user and each machine has a token epoch (`tokenEpoch`, 0 when absent) that every session token carries
(`ue`, `me`). A session token is accepted only while all of this holds: the signature under a known key, the hub's
audience, the expiry, the user's and machine's **current** epochs, the machine exists, is not revoked and still
belongs to the token's user, the user exists and is not disabled, and a connected process of that machine still
reports the session for that user.

| Event | Effect on tokens |
|---|---|
| Machine revoked (`DELETE /api/machines/:id`, admin route too) | machine epoch +1: its session tokens are dead at once |
| User disabled | user epoch +1: all their session tokens are dead and stay dead after re-enabling; their device and app tokens are refused while disabled |
| First admin sign-in migrates `local` (oidc) | moved machines and `local` get a new epoch: tokens minted before the move are dead |
| Session no longer reported by that machine, or the spoke disconnects | its token answers `401` while no process of that machine reports the session |
| Token expired | `401 token_expired`; a new shell gets the renewed token |
| Device revoked / app token revoked | that token answers `401` |
| Role change of a user | nothing (no epoch bump) |

Tokens, codes and secrets are never logged or audited; app token creation and revocation are audited
(`app-token.create`, `app-token.revoke`) without the token.

### Agent tenancy

- Every agent route answers only from the actor's user: status, sessions, show, log, watch, who, names and roles.
  Another user's sessions, names and roles do not exist: `404 not_found`, exactly like unknown ones, for every
  actor kind (so `hub show @name` of someone else's session exits 3).
- Addresses (`ses_…` or a unique prefix, `@name[.project]`, `@@role[.project]`) resolve within the caller's
  sessions; `ambiguous` candidates never list another user's sessions.
- Names and roles are per user (stored in the user's record): two users can both have `@scout`.
- The watch stream reads only the caller's tenant; session IDs are claimed by the tenant of the earliest
  connected process that reports them, and the hub mints tokens only for sessions a spoke reports for its own
  user (a session ID another user's process already claimed gets no token).
- Admins manage users, machines and devices but, as on the console, do not read other users' sessions through
  the agent API.

### Messaging tenancy

Agent messages (msg, ask, reply, decline), Decisions, pending deliveries and mutes are per user, like sessions:

- **Senders** are the authenticated actor only (a session, an app token, or the user); a request body cannot name
  one. Envelope labels come from the hub's own directory, sanitised.
- **Recipients** resolve within the sender's user. Another user's sessions, names, roles, message ids and Decision
  ids answer `404 not_found` on every route (msg, ask, reply, decline, messages/:id, decisions, the console's
  `/api/decisions/:id/answer`), exactly like unknown ones. Only a message's recipient may reply to or decline it.
- **`@me`** is the actor's own user. A session or app may message or ask it; the user cannot message themselves.
  No session can take the name `me`.
- **Decisions** are answered only by their user (console cookie, or a device token for `confirm` Decisions; `tap`
  needs the cookie), never by a session or app token and never by the asker. The first answer wins.
- **Scopes** for app tokens: `messages:send` (msg, ask, reply, decline, mute, unmute) and `messages:read` (inbox,
  messages/:id, decisions, its own `message` watch events). Sessions may send and read their own messages without
  scopes. A message carries no grants: receiving one gives the recipient no new rights.
- **Delivery** goes hub → spoke only, to connections of the recipient's user that report the session and announce
  `deliver`.
- **Limits** are counted per user (pairs, per-user total, wakes per recipient, hop depth), so one user's agents
  cannot use up another's.
- **Messaging switch**: `PUT /api/agent/messaging {enabled}` (users only) turns sending off for that user
  (`423 paused`); reading keeps working. Audited as `messaging.pause` / `messaging.resume`.
- **Storage**: messages, asks, Decisions, pending deliveries and mutes live under `<HUB_STATE_DIR>/agent/`, one file
  per user and collection (mode 0600), not in `state.json`. Admins get no access to them through any route.

## Speech settings precedence

user settings field → server default (admin, stored in `state.speech`) → `hub.json` → env. A user's
keys are never shown to anyone else (admins see only `set: true/false` for the default). Changing
provider/baseURL drops the stored key of that scope (existing rule).

## Audit actions

`signin`, `signin.denied`, `device.pair`, `device.revoke`, `machine.approve`, `machine.deny`,
`machine.revoke`, `user.role`, `user.disable`, `user.enable`, `speech.default`, `migrate.local`,
`device.link` (an app link code issued), `app-token.create`, `app-token.revoke`, `messaging.pause`,
`messaging.resume`, `decision.answer` (the chosen option, or `text`).
Never include tokens, codes, keys or session content.

## Implementation notes (server, 0.3.0)

Details the contract above leaves open, as implemented in `src/central/`:

- **Response shapes**: `GET /api/admin/users`, `GET /api/admin/machines` and `GET /api/admin/audit` return
  bare JSON arrays. User rows are `{id, email?, name?, role, disabled: boolean, created, lastSeen,
  machines, devices}` (non-revoked machines); `PUT /api/admin/users/:id` returns the updated row (400 bad
  body, 404 unknown user, 409 last active admin). Machine rows are `{id, name, created, lastSeen, online,
  ownerID, ownerEmail?}` (no sessions). Non-admins get `403 {"error": "Admins only"}` on admin routes.
- **Speech view for a user** adds `user: {stt, tts}`, the user's own saved fields (key masked with
  `source: "user"`). Key sources are `user`, `settings` (server default), `config` (hub.json), `env`,
  `none`; keys that are not the caller's own show only `{set, source}` (no `last4`). The `default` field
  has no `voiceHints`/`ready`. The `local` user (pairing mode) has no own scope: its GET/PUT
  `/api/settings/speech` is the server default, unchanged from 0.2 (no `scope`, `default` or `user`).
- **Unknown sessions**: every session route answers `404 {"error": "Not found"}` when none of the caller's
  machines reports the session (0.2 answered 409 for a session nobody reported).
- **Route table**: `Central.routes` lists every `/api/*` route with its access (`public`, `user`, `admin`,
  `session`, `machine`); the router checks access before any handler runs (`test/central-tenancy.test.ts`
  iterates it).
- **Session IDs are claimed** by the tenant of the earliest connected process that reports them. A
  process of another user reporting the same ID is ignored for it: no listing, routing, status or events
  (events nesting a child under someone else's session are dropped too). A spoke `handoff` for another
  user's session is refused.
- **Admins from the config** (`HUB_ADMIN_EMAILS`) are made admin at every sign-in; a role change through
  the API lasts until that person signs in again while still listed.
- **Sign-in device**: a browser already signed in as the same user keeps its device; otherwise a new
  device named from the user agent is created. A one-time login link signs the browser in as the
  machine's owner (a browser signed in as someone else gets a new device for the owner).
- **Audit**: `signin.denied` has `target` = the email for "not allowed" / "disabled", and only `detail`
  (the reason, e.g. `nonce mismatch`) for failed claim checks after a valid `state`. Requests with an
  invalid `state` are not audited (they are unauthenticated and could flood the ring).
- **Google** documents `iss` as `https://accounts.google.com` or `accounts.google.com`; both are accepted
  for that issuer.
- **Dev only**: `HUB_OIDC_INSECURE_ISSUER=1` allows a plain-http issuer on loopback (tests and local
  development with a fake provider).
- **Switching back** from `oidc` to `pairing` re-enables `local` as admin; records owned by other users
  stay theirs (their devices keep working; the owner can manage them through the admin API).
