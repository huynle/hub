// App/agent tokens (P1-T7, design §1.3, §7): bearer tokens a user creates for an app, CLI or external agent.
//
// Format: `hat_<id>_<secret>`; id is 16 hex characters (the AppToken id, no `_`), secret is 32 random bytes in
// base64url. Only sha256(token) is stored, on UserRecord.agent.appTokens (see ../agent-data.ts); the token is
// shown once, in the creation response. Tokens are global: the verifier finds the owner by id, then compares
// the hashes in constant time. Revoking deletes the entry; the resolver refuses tokens of disabled users.
//
// Management (create, list, revoke) is for user actors only (allow {}): a session or app token cannot mint or
// see tokens (escalation guard).
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { AppToken } from "../agent-data"
import { hashToken, type Store } from "../store"
import type { AppActor, BearerVerifier } from "./actor"
import { AgentError } from "./errors"
import type { AgentRoute } from "./routes"

/**
 * Scopes an app token may hold: reading sessions; sending (msg, ask, reply, decline, mute) and reading messages;
 * acting on sessions (approve, deny, answer, prompt, stop) and launching sessions (phase 4), each of which still
 * needs a grant held by the token (with the act verb, or `launch` covering the repo).
 */
export const APP_SCOPES: readonly string[] = ["sessions:read", "messages:send", "messages:read", "sessions:act", "sessions:launch"]
export const DEFAULT_APP_SCOPES: readonly string[] = ["sessions:read"]
export const MAX_APP_TOKENS = 50
export const MAX_APP_TOKEN_LABEL = 100

const PREFIX = "/api/agent/app-tokens"
const TOKEN = /^hat_([0-9a-f]{16})_([A-Za-z0-9_-]{43,})$/
const NO_STORE = { "cache-control": "no-store" }

/** Constant-time comparison of two hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

const scopesOf = (token: AppToken): string[] => (Array.isArray(token.scopes) ? token.scopes.filter((s): s is string => typeof s === "string") : [...DEFAULT_APP_SCOPES])

/** The app token verifier: `hat_<id>_<secret>` → the owner's app actor; anything else → undefined. */
export function appTokenVerifier(store: Store): BearerVerifier {
  return {
    kind: "app",
    async verify(token: string): Promise<AppActor | undefined> {
      const match = TOKEN.exec(token)
      if (!match) return undefined
      const id = match[1]!
      const owner = store.users().find((user) => user.agent?.appTokens?.some((t) => t.id === id))
      if (!owner) return undefined
      // A revocation on another pod applies at once: read the owner again (a no-op for the file store).
      await store.recheck({ users: [owner.id] })
      const record = store.user(owner.id)?.agent?.appTokens?.find((t) => t.id === id)
      if (!record || !sameHash(record.tokenHash, hashToken(token))) return undefined
      const label = typeof record.label === "string" ? record.label : undefined
      return { kind: "app", userID: owner.id, tokenID: record.id, scopes: scopesOf(record), ...(label ? { label } : {}) }
    },
  }
}

interface CreateInput {
  label?: string
  scopes: string[]
}

function parseCreate(body: unknown): CreateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AgentError("invalid", "Body must be a JSON object")
  const { label, scopes } = body as Record<string, unknown>
  const out: CreateInput = { scopes: [...DEFAULT_APP_SCOPES] }
  if (label !== undefined && label !== null) {
    if (typeof label !== "string") throw new AgentError("invalid", "label must be a string")
    const trimmed = label.trim()
    if (trimmed.length > MAX_APP_TOKEN_LABEL) throw new AgentError("invalid", `label must be at most ${MAX_APP_TOKEN_LABEL} characters`)
    if (trimmed) out.label = trimmed
  }
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || !scopes.every((s): s is string => typeof s === "string")) throw new AgentError("invalid", "scopes must be an array of strings")
    const unknown = scopes.filter((s) => !APP_SCOPES.includes(s))
    if (unknown.length) throw new AgentError("invalid", `Unknown scope: ${unknown[0]}`, { extra: { scopes: APP_SCOPES } })
    out.scopes = [...new Set(scopes)]
  }
  return out
}

const view = (token: AppToken) => ({
  id: token.id,
  ...(typeof token.label === "string" ? { label: token.label } : {}),
  scopes: scopesOf(token),
  ...(typeof token.created === "number" ? { created: token.created } : {}),
})

/** POST, GET and DELETE /api/agent/app-tokens: user actors only. */
export function appTokenRoutes(store: Store): AgentRoute[] {
  return [
    {
      method: "POST",
      path: PREFIX,
      allow: {},
      async handle({ request, user }) {
        const input = parseCreate(await request.json())
        const id = randomBytes(8).toString("hex")
        const token = `hat_${id}_${randomBytes(32).toString("base64url")}`
        const record: AppToken = { id, tokenHash: hashToken(token), ...(input.label ? { label: input.label } : {}), scopes: input.scopes, created: Date.now() }
        let full = false
        await store.updateAgentData(user.id, (data) => {
          const tokens = data.appTokens ?? []
          full = false
          if (tokens.length >= MAX_APP_TOKENS) {
            full = true
            return
          }
          data.appTokens = [...tokens, record]
        })
        if (full) throw new AgentError("rate_limited", `At most ${MAX_APP_TOKENS} app tokens per user`, { hint: "Revoke unused tokens" })
        await store.audit({ actor: user.id, action: "app-token.create", target: id, ...(input.label ? { detail: input.label } : {}) })
        return Response.json({ ...view(record), token }, { status: 201, headers: NO_STORE })
      },
    },
    {
      method: "GET",
      path: PREFIX,
      allow: {},
      handle: ({ user }) => Response.json({ tokens: (store.agentData(user.id).appTokens ?? []).map(view) }, { headers: NO_STORE }),
    },
    {
      method: "DELETE",
      path: `${PREFIX}/:id`,
      allow: {},
      async handle({ params, user }) {
        const id = params.id!
        let found = false
        await store.updateAgentData(user.id, (data) => {
          const tokens = data.appTokens ?? []
          found = tokens.some((t) => t.id === id)
          if (found) data.appTokens = tokens.filter((t) => t.id !== id)
        })
        if (!found) throw new AgentError("not_found", "No such app token")
        await store.audit({ actor: user.id, action: "app-token.revoke", target: id })
        return new Response(null, { status: 204, headers: NO_STORE })
      },
    },
  ]
}
