// Grants (design §5, §7; decisions wvqeuis0): per-user grants in the StateStore, created and edited only by the
// user. Holder and scope belong to the owner, checked on create and on every use; `@name` holders are pinned to
// the session holding the name at creation, reserved `@@role` holders follow the role, `app:<id>` holders must be
// the owner's app token. Expiry is absolute; revoke ends a grant; the hourly action cap counts per grant.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentActor } from "../src/central/agent/actor"
import { Directory, type ReportedSession } from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { GRANTS_ACTIVE_MAX, GRANTS_KEPT, Grants } from "../src/central/agent/grants"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { Store } from "../src/central/store"

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function setup() {
  let t = T0
  const now = () => t
  const store = Store.open(mkdtempSync(path.join(tmpdir(), "hub-grants-")), now)
  const alice = store.upsertUser({ email: "alice@example.test", role: "user" }).id
  const bob = store.upsertUser({ email: "bob@example.test", role: "user" }).id
  const reported = new Map<string, ReportedSession[]>()
  const directory = new Directory({ store, source: { reported: (u) => reported.get(u) ?? [], archived: () => new Set<string>() }, now })
  const summaries: { actor: string; action: string; target?: string; detail?: string }[] = []
  const state = new MemoryStateStore({ now })
  const grants = new Grants({ state, counters: new MemoryCounters({ now }), directory, store, admin: { audit: (e) => void summaries.push(e) }, now })
  const report = (userID: string, ...ids: string[]) => {
    reported.set(
      userID,
      ids.map((sessionID) => ({ sessionID, title: "", machineID: "mch_1", project: "hub" })),
    )
    directory.resolve(userID, ids[0]!)
  }
  const appToken = (userID: string, id: string) => store.updateAgentData(userID, (d) => void (d.appTokens = [...(d.appTokens ?? []), { id, tokenHash: "00" }]))
  return { grants, directory, store, state, alice, bob, summaries, report, appToken, now, advance: (ms: number) => void (t += ms) }
}

const spec = (holder: string, extra: Record<string, unknown> = {}) => ({ holder, scope: { projects: ["/Users/huy/projects/hub"] }, allow: ["approve", "deny"], ...extra })

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof AgentError) return cause
    throw cause
  }
  throw new Error("expected an AgentError")
}

const sessionActor = (userID: string, sessionID: string): AgentActor => ({ kind: "session", userID, machineID: "mch_1", sessionID })
const appActor = (userID: string, tokenID: string): AgentActor => ({ kind: "app", userID, tokenID, scopes: [] })

describe("Grants.create", () => {
  test("stores a validated grant with an id, owner, created and an absolute expiry", async () => {
    const { grants, alice, now } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator", { expires: "2h", maxActionsPerHour: 30, permissions: { allow: ["bash:bun test*"] } }))
    expect(grant.id).toMatch(/^g_[0-9a-f]{16}$/)
    expect(grant).toMatchObject({
      owner: alice,
      holder: "@@orchestrator",
      scope: { projects: ["/Users/huy/projects/hub"] },
      allow: ["approve", "deny"],
      permissions: { allow: ["shell:bun test*"], never: [] },
      allowAlways: false,
      maxActionsPerHour: 30,
      created: now(),
      expiresAt: now() + 2 * HOUR,
    })
    expect("holderSessionID" in grant).toBe(false)
    expect(await grants.get(alice, grant.id)).toEqual(grant)
  })

  test("rejects an invalid grant (validateGrant)", async () => {
    const { grants, alice } = setup()
    expect((await failure(grants.create(alice, spec("@@orchestrator", { allow: ["delete"] })))).code).toBe("invalid")
    expect((await failure(grants.create(alice, { holder: "@@reviewer", scope: { projects: ["/x"] }, allow: ["approve"] }))).code).toBe("invalid")
  })

  test("pins an @name holder to the session holding the name now", async () => {
    const { grants, directory, alice, report } = setup()
    report(alice, "ses_aaa")
    directory.setName(alice, "ses_aaa", "orch")
    const grant = await grants.create(alice, spec("@orch"))
    expect(grant).toMatchObject({ holder: "@orch", holderSessionID: "ses_aaa" })
  })

  test("pins a ses_ holder (a unique prefix resolves to the full ID)", async () => {
    const { grants, alice, report } = setup()
    report(alice, "ses_abc123")
    expect(await grants.create(alice, spec("ses_abc"))).toMatchObject({ holder: "ses_abc", holderSessionID: "ses_abc123" })
  })

  test("a session or name of another user is not_found", async () => {
    const { grants, directory, alice, bob, report } = setup()
    report(bob, "ses_bob")
    directory.setName(bob, "ses_bob", "bobs")
    expect((await failure(grants.create(alice, spec("ses_bob")))).code).toBe("not_found")
    expect((await failure(grants.create(alice, spec("@bobs")))).code).toBe("not_found")
  })

  test("an app holder must be one of the owner's app tokens", async () => {
    const { grants, alice, bob, appToken } = setup()
    appToken(bob, "0123456789abcdef")
    expect((await failure(grants.create(alice, spec("app:0123456789abcdef")))).code).toBe("not_found")
    appToken(alice, "fedcba9876543210")
    expect(await grants.create(alice, spec("app:fedcba9876543210"))).toMatchObject({ holder: "app:fedcba9876543210" })
  })

  test("an unknown owner is not_found", async () => {
    const { grants } = setup()
    expect((await failure(grants.create("nobody", spec("@@orchestrator")))).code).toBe("not_found")
  })

  test("caps active grants per user (rate_limited)", async () => {
    const { grants, alice } = setup()
    for (let i = 0; i < GRANTS_ACTIVE_MAX; i++) await grants.create(alice, spec("@@orchestrator"))
    expect((await failure(grants.create(alice, spec("@@orchestrator")))).code).toBe("rate_limited")
  })

  test("leaves the admin audit a summary without holder or permissions", async () => {
    const { grants, alice, summaries } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator"))
    expect(summaries).toEqual([{ actor: alice, action: "grant.create", target: grant.id }])
  })
})

describe("Grants.list, get, update and revoke", () => {
  test("lists the owner's grants newest first, with their state; other users see none", async () => {
    const { grants, alice, bob, advance } = setup()
    const first = await grants.create(alice, spec("@@orchestrator", { expires: "1h" }))
    advance(1)
    const second = await grants.create(alice, spec("@@concierge"))
    advance(HOUR)
    const listed = await grants.list(alice)
    expect(listed.map((g) => [g.id, g.state])).toEqual([
      [second.id, "active"],
      [first.id, "expired"],
    ])
    expect(await grants.list(bob)).toEqual([])
  })

  test("another user's grant, or a malformed id, is not_found", async () => {
    const { grants, alice, bob } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator"))
    expect((await failure(grants.get(bob, grant.id))).code).toBe("not_found")
    expect((await failure(grants.get(alice, "../x"))).code).toBe("not_found")
    expect((await failure(grants.revoke(bob, grant.id))).code).toBe("not_found")
  })

  test("update replaces the grant (expiry restarts), keeping id, holder, pin and created", async () => {
    const { grants, directory, alice, report, advance, now } = setup()
    report(alice, "ses_aaa", "ses_bbb")
    directory.setName(alice, "ses_aaa", "orch")
    const grant = await grants.create(alice, spec("@orch", { expires: "2d" }))
    // The name moves to another session (after the old name's alias ran out): an edit keeps the original pin.
    directory.setName(alice, "ses_aaa", "old")
    advance(25 * HOUR)
    directory.setName(alice, "ses_bbb", "orch")
    const edited = await grants.update(alice, grant.id, spec("@orch", { allow: ["answer"], expires: "30m" }))
    expect(edited).toMatchObject({ id: grant.id, holder: "@orch", holderSessionID: "ses_aaa", allow: ["answer"], created: grant.created, updated: now(), expiresAt: now() + 30 * MIN })
    expect(await grants.get(alice, grant.id)).toEqual(edited)
  })

  test("update cannot change the holder, and rejects invalid grants", async () => {
    const { grants, alice } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator"))
    expect((await failure(grants.update(alice, grant.id, spec("@@concierge")))).code).toBe("invalid")
    expect((await failure(grants.update(alice, grant.id, spec("@@orchestrator", { allow: [] })))).code).toBe("invalid")
  })

  test("revoke ends a grant (kept as revoked); revoking or editing an ended grant is gone", async () => {
    const { grants, alice, now, summaries } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator"))
    const revoked = await grants.revoke(alice, grant.id)
    expect(revoked).toMatchObject({ id: grant.id, revokedAt: now() })
    expect((await grants.list(alice))[0]!.state).toBe("revoked")
    expect((await failure(grants.revoke(alice, grant.id))).code).toBe("gone")
    expect((await failure(grants.update(alice, grant.id, spec("@@orchestrator")))).code).toBe("gone")
    expect(summaries.map((s) => s.action)).toEqual(["grant.create", "grant.revoke"])
  })

  test("an expired grant cannot be edited (gone)", async () => {
    const { grants, alice, advance } = setup()
    const grant = await grants.create(alice, spec("@@orchestrator", { expires: "1m" }))
    advance(MIN)
    expect((await failure(grants.update(alice, grant.id, spec("@@orchestrator")))).code).toBe("gone")
  })

  test("ended grants beyond GRANTS_KEPT are dropped, oldest first", async () => {
    const { grants, alice, advance } = setup()
    const ids: string[] = []
    for (let i = 0; i < GRANTS_KEPT + 2; i++) {
      advance(1)
      const grant = await grants.create(alice, spec("@@orchestrator"))
      await grants.revoke(alice, grant.id)
      ids.push(grant.id)
    }
    await grants.create(alice, spec("@@orchestrator"))
    const listed = (await grants.list(alice)).map((g) => g.id)
    expect(listed.length).toBe(GRANTS_KEPT + 1)
    expect(listed).not.toContain(ids[0])
    expect(listed).not.toContain(ids[1])
  })
})

describe("Grants.usable (checked on every use)", () => {
  const HUB = { directory: "/Users/huy/projects/hub/.worktrees/x" }

  test("a pinned session holder: only that session, only in scope, only granted verbs, only while active", async () => {
    const { grants, directory, alice, report, advance } = setup()
    report(alice, "ses_aaa", "ses_bbb")
    directory.setName(alice, "ses_aaa", "orch")
    const grant = await grants.create(alice, spec("@orch", { expires: "1h" }))
    expect((await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).map((g) => g.id)).toEqual([grant.id])
    expect(await grants.usable(sessionActor(alice, "ses_bbb"), "approve", HUB)).toEqual([])
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "prompt", HUB)).toEqual([])
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", { directory: "/Users/huy/projects/hubby" })).toEqual([])
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", { directory: "relative/hub" })).toEqual([])
    advance(HOUR)
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).toEqual([])
  })

  test("an @name grant never follows a later holder of the name", async () => {
    const { grants, directory, alice, report, advance } = setup()
    report(alice, "ses_aaa", "ses_bbb")
    directory.setName(alice, "ses_aaa", "orch")
    await grants.create(alice, spec("@orch", { expires: "2d" }))
    directory.setName(alice, "ses_aaa", "old")
    advance(25 * HOUR)
    directory.setName(alice, "ses_bbb", "orch")
    expect(await grants.usable(sessionActor(alice, "ses_bbb"), "approve", HUB)).toEqual([])
    expect((await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).length).toBe(1)
  })

  test("a reserved role holder follows the role", async () => {
    const { grants, directory, alice, report } = setup()
    report(alice, "ses_aaa", "ses_bbb")
    const grant = await grants.create(alice, spec("@@orchestrator"))
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).toEqual([])
    directory.claimRole(alice, "ses_aaa", "orchestrator", { byUser: true })
    expect((await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).map((g) => g.id)).toEqual([grant.id])
    directory.releaseRole(alice, "ses_aaa", "orchestrator")
    directory.claimRole(alice, "ses_bbb", "orchestrator", { byUser: true })
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).toEqual([])
    expect((await grants.usable(sessionActor(alice, "ses_bbb"), "approve", HUB)).length).toBe(1)
  })

  test("an app holder: only that token, only while the owner still has it", async () => {
    const { grants, store, alice, appToken } = setup()
    appToken(alice, "fedcba9876543210")
    await grants.create(alice, spec("app:fedcba9876543210"))
    expect((await grants.usable(appActor(alice, "fedcba9876543210"), "deny", HUB)).length).toBe(1)
    expect(await grants.usable(appActor(alice, "0123456789abcdef"), "deny", HUB)).toEqual([])
    store.updateAgentData(alice, (d) => void (d.appTokens = []))
    expect(await grants.usable(appActor(alice, "fedcba9876543210"), "deny", HUB)).toEqual([])
  })

  test("another user's session or token never uses the owner's grant; users and revoked grants get none", async () => {
    const { grants, directory, alice, bob, report } = setup()
    report(alice, "ses_aaa")
    directory.setName(alice, "ses_aaa", "orch")
    const grant = await grants.create(alice, spec("@orch"))
    expect(await grants.usable(sessionActor(bob, "ses_aaa"), "approve", HUB)).toEqual([])
    expect(await grants.usable({ kind: "user", userID: alice, deviceID: "dev_1", via: "cookie" }, "approve", HUB)).toEqual([])
    await grants.revoke(alice, grant.id)
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).toEqual([])
  })

  test("a disabled owner's grants are unusable", async () => {
    const { grants, store, alice, report } = setup()
    report(alice, "ses_aaa")
    await grants.create(alice, spec("ses_aaa"))
    store.setUser(alice, { disabled: true })
    expect(await grants.usable(sessionActor(alice, "ses_aaa"), "approve", HUB)).toEqual([])
  })
})

describe("Grants.consume (maxActionsPerHour)", () => {
  test("counts actions per grant in the clock hour; past the cap rate_limited with retryAfter", async () => {
    const { grants, alice, advance } = setup()
    const a = await grants.create(alice, spec("@@orchestrator", { maxActionsPerHour: 2 }))
    const b = await grants.create(alice, spec("@@orchestrator", { maxActionsPerHour: 2 }))
    await grants.consume(a)
    await grants.consume(a)
    const limited = await failure(grants.consume(a))
    expect(limited.code).toBe("rate_limited")
    const retryAfter = limited.options.extra?.retryAfter as number
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    await grants.consume(b)
    advance(retryAfter * 1000)
    await grants.consume(a)
  })
})
