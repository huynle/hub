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

## Speech settings precedence

user settings field → server default (admin, stored in `state.speech`) → `hub.json` → env. A user's
keys are never shown to anyone else (admins see only `set: true/false` for the default). Changing
provider/baseURL drops the stored key of that scope (existing rule).

## Audit actions

`signin`, `signin.denied`, `device.pair`, `device.revoke`, `machine.approve`, `machine.deny`,
`machine.revoke`, `user.role`, `user.disable`, `user.enable`, `speech.default`, `migrate.local`.
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
