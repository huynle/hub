// Kill switches (design §5, §7): a per-user acting switch (AgentData.actingPaused, GET/PUT /api/agent/acting,
// users only, audited) and the admin's hub-wide one (Store); isActingPaused(userID) is either; hubNever() is the
// hub.json agents.never patterns. Acting verbs (P3-T7) call ensureActing() and answer 423 paused.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ActingSwitch, actingSwitchRoutes } from "../src/central/agent/acting-switch"
import type { AgentActor } from "../src/central/agent/actor"
import { AgentAudit } from "../src/central/agent/audit"
import { AgentError, agentFailure } from "../src/central/agent/errors"
import type { AgentContext } from "../src/central/agent/routes"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { LOCAL_USER, Store } from "../src/central/store"

const USER_ACTOR: AgentActor = { kind: "user", userID: LOCAL_USER, deviceID: "dev_1", via: "cookie" }

async function setup(never: readonly string[] = []) {
  const store = Store.open(mkdtempSync(path.join(tmpdir(), "hub-acting-")))
  const bob = await store.upsertUser({ email: "bob@example.com", role: "user" })
  const audit = new AgentAudit({ state: new MemoryStateStore(), admin: store })
  const acting = new ActingSwitch({ store, never, audit })
  return { store, bob, audit, acting }
}

const paused = (fn: () => void): AgentError => {
  try {
    fn()
  } catch (cause) {
    return cause as AgentError
  }
  throw new Error("expected paused")
}

describe("ActingSwitch", () => {
  test("isActingPaused: per user, or hub-wide for everyone", async () => {
    const { store, bob, acting } = await setup()
    expect(acting.isActingPaused(LOCAL_USER)).toBe(false)
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, false)
    expect(store.agentData(LOCAL_USER).actingPaused).toBe(true)
    expect(acting.isActingPaused(LOCAL_USER)).toBe(true)
    expect(acting.isActingPaused(bob.id)).toBe(false)
    await store.setActingPaused(true)
    expect(acting.isActingPaused(bob.id)).toBe(true)
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, true)
    expect(store.agentData(LOCAL_USER).actingPaused).toBeUndefined()
    expect(acting.isActingPaused(LOCAL_USER)).toBe(true)
    await store.setActingPaused(false)
    expect(acting.isActingPaused(LOCAL_USER)).toBe(false)
  })

  test("ensureActing throws paused (423), naming which switch is on", async () => {
    const { store, acting } = await setup()
    expect(() => acting.ensureActing(LOCAL_USER)).not.toThrow()
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, false)
    const user = paused(() => acting.ensureActing(LOCAL_USER))
    expect(user).toBeInstanceOf(AgentError)
    expect(user.code).toBe("paused")
    expect(user.message).toMatch(/this user/)
    expect(agentFailure(user).status).toBe(423)
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, true)
    await store.setActingPaused(true)
    const hub = paused(() => acting.ensureActing(LOCAL_USER))
    expect(hub.code).toBe("paused")
    expect(hub.message).toMatch(/hub admin/)
  })

  test("hubNever: the hub.json agents.never patterns, parsed", async () => {
    expect((await setup()).acting.hubNever()).toEqual([])
    expect((await setup(["shell:git push*", "external_directory"])).acting.hubNever()).toEqual([
      { action: "shell", resource: "git push*" },
      { action: "external_directory", resource: "*" },
    ])
  })

  test("each change is in the user's agent audit (and the admin summary)", async () => {
    const { store, audit, acting } = await setup()
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, false)
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, true)
    const { entries } = await audit.list(LOCAL_USER)
    expect(entries.map((e) => [e.verb, e.actor.kind, e.decision, e.outcome])).toEqual([
      ["acting.resume", "user", "allow", "ok"],
      ["acting.pause", "user", "allow", "ok"],
    ])
    expect(store.auditLog()[0]).toMatchObject({ actor: LOCAL_USER, action: "agent.acting.resume" })
  })

  test("without an agent audit, changes go to the hub audit", async () => {
    const store = Store.open(mkdtempSync(path.join(tmpdir(), "hub-acting-")))
    const acting = new ActingSwitch({ store })
    await acting.setUserActing(LOCAL_USER, USER_ACTOR, false)
    expect(store.auditLog()[0]).toMatchObject({ actor: LOCAL_USER, action: "acting.pause" })
  })
})

describe("GET/PUT /api/agent/acting", () => {
  const ctx = (store: Store, method: string, body?: unknown): AgentContext => ({
    request: new Request("http://hub/api/agent/acting", { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }),
    url: new URL("http://hub/api/agent/acting"),
    params: {},
    actor: USER_ACTOR,
    credential: "cookie",
    user: store.user(LOCAL_USER)!,
  })
  const call = async (routes: ReturnType<typeof actingSwitchRoutes>, store: Store, method: string, body?: unknown) => {
    const route = routes.find((r) => r.method === method && r.path === "/api/agent/acting")!
    try {
      return await route.handle(ctx(store, method, body))
    } catch (cause) {
      return agentFailure(cause)
    }
  }

  test("users only; GET shows both switches; PUT {enabled} sets the user's", async () => {
    const { store, acting } = await setup()
    const routes = actingSwitchRoutes(acting)
    expect(routes.map((r) => [r.method, r.path, r.allow])).toEqual([
      ["GET", "/api/agent/acting", {}],
      ["PUT", "/api/agent/acting", {}],
    ])
    expect(await (await call(routes, store, "GET")).json()).toEqual({ enabled: true, hubEnabled: true })
    const off = await call(routes, store, "PUT", { enabled: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ enabled: false, hubEnabled: true })
    await store.setActingPaused(true)
    expect(await (await call(routes, store, "GET")).json()).toEqual({ enabled: false, hubEnabled: false })
    expect(await (await call(routes, store, "PUT", { enabled: true })).json()).toEqual({ enabled: true, hubEnabled: false })
    expect(acting.isActingPaused(LOCAL_USER)).toBe(true)
  })

  test("PUT needs enabled true or false", async () => {
    const { store, acting } = await setup()
    const routes = actingSwitchRoutes(acting)
    for (const body of [{}, { enabled: "no" }, [], null]) {
      const res = await call(routes, store, "PUT", body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error.code).toBe("invalid")
    }
  })
})
