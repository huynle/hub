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
import { GRANTS_ACTIVE_MAX, Grants } from "../src/central/agent/grants"
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
    expect((await failure(grants.create(alice, spec("@@orchestrator", { allow: ["launch"] })))).code).toBe("invalid")
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
