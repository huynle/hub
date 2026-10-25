// /api/agent/grants (design §5, §7): the user's grants. User actors only (allow {}): the device cookie (same-origin
// writes, checked by the agent framework) or a device token. A session or app token never creates, edits, reads
// or revokes a grant (escalation guard). Answers {grant} / {grants}, never cached; the owner is not echoed.
//
//   POST   /api/agent/grants       create (201)          GET /api/agent/grants      list, newest first
//   GET    /api/agent/grants/:id   one grant             PUT /api/agent/grants/:id  replace (holder fixed)
//   DELETE /api/agent/grants/:id   revoke (gone when already ended)
//
// Agents only request one (grant-requests.ts): POST /api/agent/grants/requests {grant, why} from a session (any of
// its tokens) or an app token with messages:send → 201 {message, decision} (a tap Decision for the user); the user
// gets invalid (create it directly).
import type { GrantRequests } from "./grant-requests"
import { type Grant, type Grants, grantState } from "./grants"
import type { AgentRoute } from "./routes"

// A literal: routes.ts imports this module (AGENT_PREFIX is not initialised yet when it loads).
const PREFIX = "/api/agent/grants"
const NO_STORE = { "cache-control": "no-store" }

/** A grant as the API shows it: without the owner, with its state now. */
export function grantView(grant: Grant, at: number) {
  const { owner: _owner, ...rest } = grant
  return { ...rest, state: grantState(grant, at) }
}

export function grantRoutes(grants: Grants, now: () => number = Date.now, requests?: GrantRequests): AgentRoute[] {
  const one = (grant: Grant, status = 200) => Response.json({ grant: grantView(grant, now()) }, { status, headers: NO_STORE })
  return [
    ...(requests
      ? [
          {
            method: "POST",
            path: `${PREFIX}/requests`,
            allow: { session: true, scope: "messages:send" },
            handle: async ({ request, actor, user }) => Response.json(await requests.request(user.id, actor, await request.json()), { status: 201, headers: NO_STORE }),
          } satisfies AgentRoute,
        ]
      : []),
    {
      method: "POST",
      path: PREFIX,
      allow: {},
      handle: async ({ request, user }) => one(await grants.create(user.id, await request.json()), 201),
    },
    {
      method: "GET",
      path: PREFIX,
      allow: {},
      handle: async ({ user }) => Response.json({ grants: (await grants.list(user.id)).map((g) => grantView(g, now())) }, { headers: NO_STORE }),
    },
    {
      method: "GET",
      path: `${PREFIX}/:id`,
      allow: {},
      handle: async ({ params, user }) => one(await grants.get(user.id, params.id!)),
    },
    {
      method: "PUT",
      path: `${PREFIX}/:id`,
      allow: {},
      handle: async ({ params, request, user }) => one(await grants.update(user.id, params.id!, await request.json())),
    },
    {
      method: "DELETE",
      path: `${PREFIX}/:id`,
      allow: {},
      handle: async ({ params, user }) => one(await grants.revoke(user.id, params.id!)),
    },
  ]
}
