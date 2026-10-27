// The webhook API on /api/agent (P4-T10; decision znbg8xa5 #8), over Webhooks (webhooks.ts):
//
//   POST   /api/agent/webhooks        {url, events?, label?} → 201 {webhook, secret} (the secret only here)
//   GET    /api/agent/webhooks        → {webhooks}
//   GET    /api/agent/webhooks/:id    → {webhook, deliveries} (recent deliveries, oldest first)
//   DELETE /api/agent/webhooks/:id    → 204 (its pending deliveries are dropped)
//
// Who: users (all of their registrations, their own and their app tokens'); app tokens with sessions:launch (the
// scope of the only events so far, launch.*), which see and delete only the registrations they made and get only
// the events of launches they started. Sessions cannot register webhooks. Another user's registration, or (apps)
// one the token did not make, is 404 not_found.
import type { Store } from "../store"
import type { AgentActor } from "./actor"
import { AgentError } from "./errors"
import type { AgentRoute } from "./routes"
import { webhookEventScopes, type WebhookOwner, type Webhooks } from "./webhooks"

// A literal: routes.ts imports this module.
const PATH = "/api/agent/webhooks"
const NO_STORE = { "cache-control": "no-store" }
/** Users; apps with sessions:launch. */
export const WEBHOOK_SCOPE = "events:subscribe"
const ALLOW = { scope: WEBHOOK_SCOPE } as const

export type RouteWebhooks = Pick<Webhooks, "register" | "list" | "get" | "remove" | "deliveries">

/** The registrations an actor manages: an app token its own, a user all (undefined). */
const ownerOf = (actor: AgentActor): WebhookOwner | undefined => (actor.kind === "app" ? `app:${actor.tokenID}` : undefined)

const notFound = (id: string) => new AgentError("not_found", `No webhook ${id}`)

const requireEventScopes = (actor: AgentActor, events: unknown) => {
  if (actor.kind !== "app") return
  const patterns = events === undefined ? ["launch.*"] : Array.isArray(events) && events.every((e) => typeof e === "string") ? events : []
  const missing = webhookEventScopes(patterns).filter((scope) => !actor.scopes.includes(scope))
  if (missing.length) throw new AgentError("forbidden", `Webhook events need scope ${missing.join(", ")}`)
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await request.text()) as unknown
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AgentError("invalid", "Body must be a JSON object")
  return raw as Record<string, unknown>
}

export function webhookRoutes(webhooks: RouteWebhooks, store?: Pick<Store, "audit">): AgentRoute[] {
  return [
    {
      method: "POST",
      path: PATH,
      allow: ALLOW,
      async handle({ request, actor, user }) {
        const input = await bodyOf(request)
        requireEventScopes(actor, input.events)
        const result = await webhooks.register(user.id, ownerOf(actor) ?? "user", { url: input.url, events: input.events, label: input.label })
        await store?.audit({ actor: user.id, action: "webhook.create", target: result.webhook.id, detail: new URL(result.webhook.url).host })
        return Response.json(result, { status: 201, headers: NO_STORE })
      },
    },
    {
      method: "GET",
      path: PATH,
      allow: ALLOW,
      handle: async ({ actor, user }) => Response.json({ webhooks: await webhooks.list(user.id, ownerOf(actor)) }, { headers: NO_STORE }),
    },
    {
      method: "GET",
      path: `${PATH}/:id`,
      allow: ALLOW,
      async handle({ params, actor, user }) {
        const webhook = await webhooks.get(user.id, params.id!, ownerOf(actor))
        if (!webhook) throw notFound(params.id!)
        return Response.json({ webhook, deliveries: await webhooks.deliveries(user.id, webhook.id) }, { headers: NO_STORE })
      },
    },
    {
      method: "DELETE",
      path: `${PATH}/:id`,
      allow: ALLOW,
      async handle({ params, actor, user }) {
        if (!(await webhooks.remove(user.id, params.id!, ownerOf(actor)))) throw notFound(params.id!)
        await store?.audit({ actor: user.id, action: "webhook.delete", target: params.id! })
        return new Response(null, { status: 204, headers: NO_STORE })
      },
    },
  ]
}
