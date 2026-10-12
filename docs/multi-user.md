# Multi-user hub (0.3.0) — design contract

One hub can serve several people. Each person signs in, and sees and controls only their own machines,
sessions, phones and speech settings. Without sign-in configured the hub stays the single-owner hub it
has always been.

## Auth modes

| `VOICE_AUTH` | Who can use the hub | How a browser gets access |
|---|---|---|
| `pairing` (default) | One owner (the implicit user `local`) | Pairing code (`/voice → Pair a phone`, or the bootstrap code in the log), one-time login links |
| `oidc` | Users allowed by the allow-list | "Sign in with Google" (any OpenID Connect issuer); pairing codes and login links still work and belong to the issuing machine's owner |

`oidc` settings (env, or the `auth` object in `hub.json`):

| Env | hub.json | Default | Meaning |
|---|---|---|---|
| `VOICE_AUTH` | `auth.mode` | `pairing` | `pairing` or `oidc` |
| `VOICE_OIDC_ISSUER` | `auth.issuer` | `https://accounts.google.com` | Issuer; discovery at `<issuer>/.well-known/openid-configuration` |
| `VOICE_OIDC_CLIENT_ID` | `auth.clientId` | — | Required for `oidc` |
| `VOICE_OIDC_CLIENT_SECRET` | `auth.clientSecret` | — | Required for `oidc` (secret: never logged, never returned) |
| `VOICE_OIDC_ALLOWED` | `auth.allowed` | — | Comma list of emails and/or `@domain` entries. Required for `oidc` (no open sign-up) |
| `VOICE_ADMIN_EMAILS` | `auth.admins` | — | Comma list of admin emails (also allowed). At least one required for `oidc` |

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
