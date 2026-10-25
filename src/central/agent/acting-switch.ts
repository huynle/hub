// Kill switches and the hub-wide never rules for agent actions (design §5, §7; decision wvqeuis0).
// - Per user: AgentData.actingPaused, set by the user through GET/PUT /api/agent/acting (users only; sessions and
//   apps never turn it on or off). Each change is in the user's agent audit (acting.pause / acting.resume).
// - Hub-wide: the admin's switch in the Store (PUT /api/admin/agents/acting in http.ts); it applies to everyone.
// - Either one pauses every agent action (approve, deny, answer, prompt, stop, launch, roles): the acting code
//   (agent/acting.ts) calls ensureActing() first and again before the spoke request; it answers 423 paused.
//   Reading and messaging keep working (messaging has its own switch, AgentData.messagingPaused).
// - hubNever(): hub.json `agents.never` (already validated by config.ts), checked before every grant.
import type { Store } from "../store"
import type { AgentActor } from "./actor"
import type { AgentAudit } from "./audit"
import { partyFromActor } from "./envelope"
import { AgentError } from "./errors"
import { parsePattern, type Pattern } from "./policy"
import { AGENT_PREFIX, type AgentRoute } from "./routes"

export interface ActingSwitchDeps {
  readonly store: Pick<Store, "agentData" | "updateAgentData" | "actingPaused" | "audit">
  /** hub.json `agents.never` patterns (CentralConfig.agentsNever). */
  readonly never?: readonly string[]
  /** The agent audit (P3-T5): records each per-user change; the hub audit when absent. */
  readonly audit?: AgentAudit
}

export class ActingSwitch {
  private readonly never: readonly Pattern[]

  constructor(private readonly deps: ActingSwitchDeps) {
    this.never = (deps.never ?? []).flatMap((text) => parsePattern(text) ?? [])
  }

  /** The user turned agent actions off. */
  userPaused(userID: string): boolean {
    return this.deps.store.agentData(userID).actingPaused === true
  }

  /** The admin turned agent actions off for the whole hub. */
  hubPaused(): boolean {
    return this.deps.store.actingPaused()
  }

  /** Agent actions are off for this user: their own switch or the hub-wide one. */
  isActingPaused(userID: string): boolean {
    return this.hubPaused() || this.userPaused(userID)
  }

  /** Throws paused (423) while a kill switch is on for this user. */
  ensureActing(userID: string): void {
    if (this.hubPaused()) throw new AgentError("paused", "Agent actions are paused by the hub admin", { hint: "Ask the hub admin to resume them" })
    if (this.userPaused(userID)) {
      throw new AgentError("paused", "Agent actions are off for this user", { hint: "Turn them on in the console (PUT /api/agent/acting)" })
    }
  }

  /** The hub-wide never rules (hub.json agents.never), for every user; they beat any grant. */
  hubNever(): readonly Pattern[] {
    return this.never
  }

  /** Turns the user's agent actions on or off, and audits it. */
  async setUserActing(userID: string, actor: AgentActor, enabled: boolean): Promise<void> {
    this.deps.store.updateAgentData(userID, (data) => {
      if (enabled) delete data.actingPaused
      else data.actingPaused = true
    })
    const verb = enabled ? "acting.resume" : "acting.pause"
    if (this.deps.audit) {
      await this.deps.audit.record(userID, { actor: partyFromActor(actor), verb, target: {}, decision: "allow", outcome: "ok" })
    } else this.deps.store.audit({ actor: userID, action: verb })
  }
}

const NO_STORE = { "cache-control": "no-store" }

/** GET/PUT /api/agent/acting {enabled}: the caller's own switch (users only); hubEnabled shows the admin's. */
export function actingSwitchRoutes(acting: ActingSwitch): AgentRoute[] {
  const view = (userID: string) => Response.json({ enabled: !acting.userPaused(userID), hubEnabled: !acting.hubPaused() }, { headers: NO_STORE })
  return [
    { method: "GET", path: `${AGENT_PREFIX}/acting`, allow: {}, handle: ({ user }) => view(user.id) },
    {
      method: "PUT",
      path: `${AGENT_PREFIX}/acting`,
      allow: {},
      async handle({ request, user, actor }) {
        const body: unknown = await request.json()
        const enabled = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).enabled : undefined
        if (typeof enabled !== "boolean") throw new AgentError("invalid", "enabled must be true or false")
        await acting.setUserActing(user.id, actor, enabled)
        return view(user.id)
      },
    },
  ]
}
