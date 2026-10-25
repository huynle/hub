// The agent directory (design §2, §7): persisted session records, @names, @@roles and address resolution,
// all lifecycle evaluated lazily against a fake clock. Spokes are faked by a SessionSource.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ALIAS_MS,
  Directory,
  NAME_RELEASE_MS,
  RECONNECT_WINDOW_MS,
  ROLE_OFFLINE_MS,
  SESSION_LIMIT,
  type ReportedSession,
} from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { Store } from "../src/central/store"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function setup() {
  let t = 1_700_000_000_000
  const now = () => t
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-directory-"))
  const store = Store.open(stateDir, now)
  const alice = store.upsertUser({ email: "alice@example.test", role: "user" }).id
  const bob = store.upsertUser({ email: "bob@example.test", role: "user" }).id
  const reported = new Map<string, ReportedSession[]>()
  const archived = new Map<string, Set<string>>()
  const source = { reported: (userID: string) => reported.get(userID) ?? [], archived: (userID: string) => archived.get(userID) ?? new Set<string>() }
  const open = () => new Directory({ store, source, now })
  const dir = open()
  return {
    store,
    stateDir,
    alice,
    bob,
    dir,
    /** A new Directory on the same store (a hub restart). */
    restart: () => open(),
    advance: (ms: number) => (t += ms),
    now,
    /** Replaces what the user's spokes report. */
    report: (userID: string, ...sessions: ReportedSession[]) => reported.set(userID, sessions),
    archive: (userID: string, ...ids: string[]) => archived.set(userID, new Set(ids)),
    data: (userID: string) => store.agentData(userID),
  }
}

const root = (sessionID: string, title: string, extra: Partial<ReportedSession> = {}): ReportedSession => ({ sessionID, title, machineID: "mch_1", project: "hub", ...extra })
const child = (sessionID: string, parentID: string, title = "worker"): ReportedSession => ({ sessionID, parentID, title, machineID: "mch_1", project: "hub" })

/** The AgentError a call throws. */
function failure(fn: () => unknown): AgentError {
  try {
    fn()
  } catch (cause) {
    if (cause instanceof AgentError) return cause
    throw cause
  }
  throw new Error("expected an AgentError")
}

const nameOf = (h: ReturnType<typeof setup>, userID: string, sessionID: string) =>
  h.data(userID).names?.find((n) => n.sessionID === sessionID && n.expiresAt === undefined)?.name

describe("session records", () => {
  test("a reported session gets a persisted record with machine, parent, project, firstSeen and lastSeen", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "Fix login"), child("ses_c", "ses_a"))
    h.dir.sync(h.alice)
    const sessions = h.data(h.alice).sessions!
    expect(sessions.find((s) => s.sessionID === "ses_a")).toMatchObject({ machineID: "mch_1", project: "hub", firstSeen: h.now(), lastSeen: h.now() })
    expect(sessions.find((s) => s.sessionID === "ses_c")).toMatchObject({ parentID: "ses_a", lastSeen: h.now() })
  })

  test("lastSeen is saved at minute granularity while online, and exactly when the session goes offline", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "Fix login"))
    h.dir.sync(h.alice)
    const start = h.now()
    const file = path.join(h.stateDir, "state.json")
    const inode = statSync(file).ino
    h.advance(30_000)
    h.dir.sync(h.alice)
    expect(statSync(file).ino).toBe(inode)
    expect(h.data(h.alice).sessions![0]!.lastSeen).toBe(start)
    h.advance(31_000)
    h.dir.sync(h.alice)
    expect(h.data(h.alice).sessions![0]!.lastSeen).toBe(start + 61_000)
    h.advance(10_000)
    h.report(h.alice)
    h.dir.sync(h.alice)
    expect(h.data(h.alice).sessions![0]!.lastSeen).toBe(start + 71_000)
  })

  test(`at most ${SESSION_LIMIT} records: archived ones go first, then the least recently seen, with their names`, () => {
    const h = setup()
    h.store.updateAgentData(h.alice, (data) => {
      data.sessions = Array.from({ length: SESSION_LIMIT }, (_, i) => ({ sessionID: `ses_${i}`, lastSeen: 1000 + i, named: true }))
      data.names = [
        { name: "five", sessionID: "ses_5" },
        { name: "zero", sessionID: "ses_0" },
        { name: "one", sessionID: "ses_1" },
      ]
    })
    h.archive(h.alice, "ses_5")
    h.report(h.alice, root("ses_new1", "x"), root("ses_new2", "y"))
    h.dir.sync(h.alice)
    const data = h.data(h.alice)
    const ids = new Set(data.sessions!.map((s) => s.sessionID))
    expect(data.sessions!.length).toBe(SESSION_LIMIT)
    expect(ids.has("ses_5")).toBe(false)
    expect(ids.has("ses_0")).toBe(false)
    expect(ids.has("ses_1")).toBe(true)
    expect(ids.has("ses_new1") && ids.has("ses_new2")).toBe(true)
    expect(data.names!.map((n) => n.name)).toEqual(["one"])
  })
})

describe("derived names", () => {
  test("a root session is named once from its first non-placeholder title", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "New session - 2026-10-24T20:43:31.123Z"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBeUndefined()
    h.report(h.alice, root("ses_a", "Fix the Login Redirect"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBe("fix-the-login-redirect")
    h.report(h.alice, root("ses_a", "Something else entirely"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBe("fix-the-login-redirect")
  })

  test("subagent sessions are never named", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "Parent work"), child("ses_c", "ses_a", "Explore the code"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_c")).toBeUndefined()
  })

  test("a taken derived name gets a suffix", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API refactor"), root("ses_b", "API Refactor!"), root("ses_c", "api refactor"))
    h.dir.sync(h.alice)
    expect([nameOf(h, h.alice, "ses_a"), nameOf(h, h.alice, "ses_b"), nameOf(h, h.alice, "ses_c")]).toEqual(["api-refactor", "api-refactor-2", "api-refactor-3"])
  })

  test("names are per user: another user's session may derive the same name", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API refactor"))
    h.report(h.bob, root("ses_b", "API refactor"))
    h.dir.sync(h.alice)
    h.dir.sync(h.bob)
    expect(nameOf(h, h.bob, "ses_b")).toBe("api-refactor")
  })

  test("a title without usable characters is skipped for good (derived once)", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "日本語"))
    h.dir.sync(h.alice)
    h.report(h.alice, root("ses_a", "Later title"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBeUndefined()
  })
})

describe("explicit names", () => {
  test("setName names a session; a leading @ is accepted", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "New session"))
    expect(h.dir.setName(h.alice, "ses_a", "@api")).toEqual({ sessionID: "ses_a", name: "api" })
    expect(nameOf(h, h.alice, "ses_a")).toBe("api")
    // Explicitly named: no derivation later.
    h.report(h.alice, root("ses_a", "Real title"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBe("api")
  })

  test("a taken name fails with name_taken; an invalid one with invalid; an unknown session with not_found", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"), root("ses_b", "Other"))
    h.dir.sync(h.alice)
    expect(failure(() => h.dir.setName(h.alice, "ses_b", "api")).code).toBe("name_taken")
    expect(failure(() => h.dir.setName(h.alice, "ses_b", "Bad_Name")).code).toBe("invalid")
    expect(failure(() => h.dir.setName(h.alice, "ses_zzz", "free")).code).toBe("not_found")
    // Another user's session is unknown to this user.
    h.report(h.bob, root("ses_bob", "Bob"))
    h.dir.sync(h.bob)
    expect(failure(() => h.dir.setName(h.alice, "ses_bob", "free")).code).toBe("not_found")
  })

  test("setting the session's own name again is a no-op", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    expect(h.dir.setName(h.alice, "ses_a", "api")).toEqual({ sessionID: "ses_a", name: "api" })
    expect(h.data(h.alice).names).toHaveLength(1)
  })

  test(`a rename keeps the old name as an alias for ${ALIAS_MS / HOUR} h: it still resolves and stays taken`, () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"), root("ses_b", "Other"))
    h.dir.sync(h.alice)
    expect(h.dir.setName(h.alice, "ses_a", "backend")).toEqual({ sessionID: "ses_a", name: "backend", alias: "api" })
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
    expect(h.dir.resolveOne(h.alice, "@backend").sessionID).toBe("ses_a")
    expect(failure(() => h.dir.setName(h.alice, "ses_b", "api")).code).toBe("name_taken")
    h.advance(ALIAS_MS - 1)
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
    h.advance(1)
    expect(failure(() => h.dir.resolveOne(h.alice, "@api")).code).toBe("not_found")
    expect(h.dir.setName(h.alice, "ses_b", "api").name).toBe("api")
  })

  test("renaming back to an alias makes it the name again", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    h.dir.setName(h.alice, "ses_a", "backend")
    expect(h.dir.setName(h.alice, "ses_a", "api")).toEqual({ sessionID: "ses_a", name: "api", alias: "backend" })
    expect(h.data(h.alice).names!.map((n) => [n.name, n.expiresAt !== undefined])).toEqual([
      ["backend", true],
      ["api", false],
    ])
  })
})

describe("primer", () => {
  test("primed is false until markPrimed, then persisted on the session record (survives a restart)", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API refactor"))
    h.dir.sync(h.alice)
    expect(h.dir.primed(h.alice, "ses_a")).toBe(false)
    h.dir.markPrimed(h.alice, "ses_a")
    expect(h.dir.primed(h.alice, "ses_a")).toBe(true)
    expect(h.data(h.alice).sessions?.find((s) => s.sessionID === "ses_a")?.primed).toBe(h.now())
    expect(h.restart().primed(h.alice, "ses_a")).toBe(true)
  })

  test("primed is per session and per user; unknown sessions are not primed and markPrimed ignores them", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "one"), root("ses_b", "two"))
    h.report(h.bob, root("ses_x", "three"))
    h.dir.markPrimed(h.alice, "ses_a")
    expect(h.dir.primed(h.alice, "ses_b")).toBe(false)
    expect(h.dir.primed(h.bob, "ses_a")).toBe(false)
    h.dir.markPrimed(h.bob, "ses_a")
    expect(h.dir.primed(h.bob, "ses_a")).toBe(false)
    expect(h.data(h.bob).sessions?.some((s) => s.sessionID === "ses_a")).toBe(false)
  })

  test("onNamed hears explicit names only, never derived ones", () => {
    const h = setup()
    const heard: Array<[string, string, string]> = []
    const off = h.dir.onNamed((userID, sessionID, name) => heard.push([userID, sessionID, name]))
    h.report(h.alice, root("ses_a", "API refactor"))
    h.dir.sync(h.alice)
    expect(nameOf(h, h.alice, "ses_a")).toBe("api-refactor")
    expect(heard).toEqual([])
    h.dir.setName(h.alice, "ses_a", "backend")
    expect(heard).toEqual([[h.alice, "ses_a", "backend"]])
    expect(failure(() => h.dir.setName(h.alice, "ses_a", "Bad_Name")).code).toBe("invalid")
    expect(heard).toHaveLength(1)
    off()
    h.dir.setName(h.alice, "ses_a", "other")
    expect(heard).toHaveLength(1)
  })

  test("a throwing onNamed listener does not fail setName", () => {
    const h = setup()
    h.dir.onNamed(() => {
      throw new Error("boom")
    })
    h.report(h.alice, root("ses_a", "New session - 2026-10-24T20:43:31.123Z"))
    expect(h.dir.setName(h.alice, "ses_a", "api")).toEqual({ sessionID: "ses_a", name: "api" })
  })
})

describe("name release", () => {
  test(`a name stays bound while its session is offline; it is released ${NAME_RELEASE_MS / DAY} d after the session is archived`, () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    h.report(h.alice)
    h.advance(30 * DAY)
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
    h.archive(h.alice, "ses_a")
    h.dir.sync(h.alice)
    h.advance(NAME_RELEASE_MS - 1)
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
    h.advance(1)
    expect(failure(() => h.dir.resolveOne(h.alice, "@api")).code).toBe("not_found")
    h.report(h.alice, root("ses_b", "Other"))
    expect(h.dir.setName(h.alice, "ses_b", "api").name).toBe("api")
  })

  test("unarchiving before the release keeps the name", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    h.archive(h.alice, "ses_a")
    h.dir.sync(h.alice)
    h.advance(3 * DAY)
    h.archive(h.alice)
    h.dir.sync(h.alice)
    h.advance(10 * DAY)
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
  })

  test(`a deleted session's name is released ${NAME_RELEASE_MS / DAY} d after the deletion`, () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    h.report(h.alice)
    h.dir.markDeleted(h.alice, "ses_a")
    h.advance(NAME_RELEASE_MS - 1)
    expect(h.dir.resolveOne(h.alice, "@api").sessionID).toBe("ses_a")
    h.advance(1)
    expect(failure(() => h.dir.resolveOne(h.alice, "@api")).code).toBe("not_found")
  })
})

describe("roles", () => {
  const two = () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "Alpha"), root("ses_b", "Beta"), root("ses_c", "Gamma", { project: "web" }))
    h.dir.sync(h.alice)
    return h
  }

  test("claims add holders, each new holder with a new generation; claiming again keeps it", () => {
    const h = two()
    expect(h.dir.claimRole(h.alice, "ses_a", "reviewer")).toEqual({ role: "reviewer", generation: 1 })
    expect(h.dir.claimRole(h.alice, "ses_b", "reviewer")).toEqual({ role: "reviewer", generation: 2 })
    expect(h.dir.claimRole(h.alice, "ses_a", "reviewer")).toEqual({ role: "reviewer", generation: 1 })
    expect(h.dir.resolve(h.alice, "@@reviewer").sessions.map((s) => s.sessionID)).toEqual(["ses_a", "ses_b"])
    const err = failure(() => h.dir.resolveOne(h.alice, "@@reviewer"))
    expect(err.code).toBe("ambiguous")
    expect(err.options.extra?.candidates).toEqual([
      { sessionID: "ses_a", name: "alpha", project: "hub" },
      { sessionID: "ses_b", name: "beta", project: "hub" },
    ])
  })

  test("release gives the role up; generations are never reused", () => {
    const h = two()
    h.dir.claimRole(h.alice, "ses_a", "reviewer")
    h.dir.releaseRole(h.alice, "ses_a", "reviewer")
    expect(failure(() => h.dir.resolve(h.alice, "@@reviewer")).code).toBe("not_found")
    expect(failure(() => h.dir.releaseRole(h.alice, "ses_a", "reviewer")).code).toBe("not_found")
    expect(h.dir.claimRole(h.alice, "ses_a", "reviewer").generation).toBe(2)
    // Survives a restart (persisted counter).
    h.dir.releaseRole(h.alice, "ses_a", "reviewer")
    expect(h.restart().claimRole(h.alice, "ses_b", "reviewer").generation).toBe(3)
  })

  test("an exclusive claim fails while another live holder exists, and blocks later claims", () => {
    const h = two()
    h.dir.claimRole(h.alice, "ses_a", "lead")
    expect(failure(() => h.dir.claimRole(h.alice, "ses_b", "lead", { exclusive: true })).code).toBe("name_taken")
    h.dir.releaseRole(h.alice, "ses_a", "lead")
    expect(h.dir.claimRole(h.alice, "ses_b", "lead", { exclusive: true })).toEqual({ role: "lead", generation: 2, exclusive: true })
    expect(failure(() => h.dir.claimRole(h.alice, "ses_a", "lead")).code).toBe("name_taken")
    expect(failure(() => h.dir.claimRole(h.alice, "ses_a", "lead", { exclusive: true })).code).toBe("name_taken")
  })

  test(`a holder offline for ${ROLE_OFFLINE_MS / MIN} min loses the role (from its persisted lastSeen)`, () => {
    const h = two()
    h.advance(RECONNECT_WINDOW_MS)
    h.dir.claimRole(h.alice, "ses_a", "lead", { exclusive: true })
    h.report(h.alice, root("ses_b", "Beta"))
    h.dir.sync(h.alice)
    h.advance(ROLE_OFFLINE_MS - 1)
    expect(failure(() => h.dir.claimRole(h.alice, "ses_b", "lead")).code).toBe("name_taken")
    expect(h.dir.resolveOne(h.alice, "@@lead").sessionID).toBe("ses_a")
    h.advance(1)
    expect(failure(() => h.dir.resolve(h.alice, "@@lead")).code).toBe("not_found")
    expect(h.dir.claimRole(h.alice, "ses_b", "lead", { exclusive: true }).generation).toBe(2)
  })

  test("an online holder never loses its role, however long ago it claimed", () => {
    const h = two()
    h.dir.claimRole(h.alice, "ses_a", "lead")
    h.advance(5 * HOUR)
    expect(h.dir.resolveOne(h.alice, "@@lead").sessionID).toBe("ses_a")
  })

  test(`no role is lost during the first ${RECONNECT_WINDOW_MS / MIN} min after the hub starts (spokes reconnect)`, () => {
    const h = two()
    h.dir.claimRole(h.alice, "ses_a", "lead")
    h.dir.claimRole(h.alice, "ses_b", "lead")
    // The hub goes down; an hour later it starts again and nobody has reconnected yet.
    h.report(h.alice)
    h.advance(HOUR)
    const dir = h.restart()
    expect(dir.resolve(h.alice, "@@lead").sessions.map((s) => s.sessionID)).toEqual(["ses_a", "ses_b"])
    h.advance(RECONNECT_WINDOW_MS - 1_000)
    h.report(h.alice, root("ses_a", "Alpha"))
    dir.sync(h.alice)
    h.advance(1_000)
    expect(dir.resolve(h.alice, "@@lead").sessions.map((s) => s.sessionID)).toEqual(["ses_a"])
  })

  test("reserved roles (orchestrator…, concierge…) are refused for sessions, allowed for the user", () => {
    const h = two()
    expect(failure(() => h.dir.claimRole(h.alice, "ses_a", "orchestrator")).code).toBe("forbidden")
    expect(failure(() => h.dir.claimRole(h.alice, "ses_a", "concierge-2")).code).toBe("forbidden")
    expect(h.dir.claimRole(h.alice, "ses_a", "orchestrator", { byUser: true }).generation).toBe(1)
  })

  test("project scope: role.project claims, @@role.project resolution, exclusivity and generations per scope", () => {
    const h = two()
    expect(h.dir.claimRole(h.alice, "ses_a", "reviewer.hub", { exclusive: true })).toEqual({ role: "reviewer", project: "hub", generation: 1, exclusive: true })
    expect(h.dir.claimRole(h.alice, "ses_c", "reviewer.web", { exclusive: true })).toEqual({ role: "reviewer", project: "web", generation: 1, exclusive: true })
    expect(failure(() => h.dir.claimRole(h.alice, "ses_b", "reviewer.hub")).code).toBe("name_taken")
    expect(h.dir.resolveOne(h.alice, "@@reviewer.hub").sessionID).toBe("ses_a")
    expect(h.dir.resolveOne(h.alice, "@@reviewer.web").sessionID).toBe("ses_c")
    expect(h.dir.resolve(h.alice, "@@reviewer").sessions.map((s) => s.sessionID)).toEqual(["ses_a", "ses_c"])
    // An unscoped holder counts for the project its session is in.
    h.dir.claimRole(h.alice, "ses_b", "tester")
    expect(h.dir.resolveOne(h.alice, "@@tester.hub").sessionID).toBe("ses_b")
    expect(failure(() => h.dir.resolve(h.alice, "@@tester.web")).code).toBe("not_found")
    h.dir.releaseRole(h.alice, "ses_a", "reviewer.hub")
    expect(failure(() => h.dir.resolve(h.alice, "@@reviewer.hub")).code).toBe("not_found")
  })

  test("bad roles are invalid; unknown and other users' sessions are not_found", () => {
    const h = two()
    h.report(h.bob, root("ses_bob", "Bob"))
    h.dir.sync(h.bob)
    expect(failure(() => h.dir.claimRole(h.alice, "ses_a", "Bad Role")).code).toBe("invalid")
    expect(failure(() => h.dir.claimRole(h.alice, "ses_zzz", "reviewer")).code).toBe("not_found")
    expect(failure(() => h.dir.claimRole(h.alice, "ses_bob", "reviewer")).code).toBe("not_found")
  })
})

describe("resolution", () => {
  test("session IDs exactly or by unique prefix; an ambiguous prefix lists the candidates", () => {
    const h = setup()
    h.report(h.alice, root("ses_abc1", "One"), root("ses_abc2", "Two"), root("ses_xyz", "New session"))
    h.dir.sync(h.alice)
    expect(h.dir.resolveOne(h.alice, "ses_xyz").sessionID).toBe("ses_xyz")
    expect(h.dir.resolveOne(h.alice, "ses_x").sessionID).toBe("ses_xyz")
    const err = failure(() => h.dir.resolveOne(h.alice, "ses_abc"))
    expect(err.code).toBe("ambiguous")
    expect(err.options.extra?.candidates).toEqual([
      { sessionID: "ses_abc1", name: "one", project: "hub" },
      { sessionID: "ses_abc2", name: "two", project: "hub" },
    ])
    expect(failure(() => h.dir.resolveOne(h.alice, "ses_nope")).code).toBe("not_found")
  })

  test("@name and @name.project; a wrong project is not_found; malformed addresses are invalid", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API", { project: "hub" }))
    h.dir.sync(h.alice)
    expect(h.dir.resolveOne(h.alice, "@api")).toMatchObject({ sessionID: "ses_a", name: "api", project: "hub", online: true, machineID: "mch_1" })
    expect(h.dir.resolveOne(h.alice, "@api.hub").sessionID).toBe("ses_a")
    expect(h.dir.resolveOne(h.alice, "@api.HUB").sessionID).toBe("ses_a")
    expect(failure(() => h.dir.resolveOne(h.alice, "@api.web")).code).toBe("not_found")
    expect(failure(() => h.dir.resolveOne(h.alice, "api")).code).toBe("invalid")
  })

  test("tenancy: another user's IDs, names and roles are not_found and never candidates", () => {
    const h = setup()
    h.report(h.alice, root("ses_a1", "Mine"))
    h.report(h.bob, root("ses_a2", "Theirs"), root("ses_bob", "Secret"))
    h.dir.sync(h.alice)
    h.dir.sync(h.bob)
    h.dir.claimRole(h.bob, "ses_bob", "reviewer")
    expect(failure(() => h.dir.resolveOne(h.alice, "@secret")).code).toBe("not_found")
    expect(failure(() => h.dir.resolveOne(h.alice, "@@reviewer")).code).toBe("not_found")
    expect(failure(() => h.dir.resolveOne(h.alice, "ses_bob")).code).toBe("not_found")
    // ses_a matches ses_a1 (alice) and ses_a2 (bob): only alice's counts, so it is unique.
    expect(h.dir.resolveOne(h.alice, "ses_a").sessionID).toBe("ses_a1")
  })
})

describe("who", () => {
  test("named, role-holding and online sessions, filtered by project and role; archived ones are left out", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"), root("ses_b", "New session"), root("ses_c", "Web", { project: "web" }), root("ses_d", "Old"))
    h.dir.sync(h.alice)
    h.dir.claimRole(h.alice, "ses_b", "reviewer")
    h.dir.claimRole(h.alice, "ses_c", "reviewer.web")
    h.archive(h.alice, "ses_d")
    expect(h.dir.who(h.alice).map((s) => s.sessionID)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(h.dir.who(h.alice, { project: "web" }).map((s) => s.sessionID)).toEqual(["ses_c"])
    expect(h.dir.who(h.alice, { role: "reviewer" }).map((s) => s.sessionID)).toEqual(["ses_b", "ses_c"])
    expect(h.dir.who(h.alice, { role: "@@reviewer.web" }).map((s) => s.sessionID)).toEqual(["ses_c"])
    expect(h.dir.who(h.alice, { role: "reviewer", project: "hub" }).map((s) => s.sessionID)).toEqual(["ses_b"])
    expect(h.dir.who(h.bob)).toEqual([])
    const b = h.dir.who(h.alice).find((s) => s.sessionID === "ses_b")!
    expect(b).toEqual({ sessionID: "ses_b", machineID: "mch_1", project: "hub", title: "New session", online: true, lastSeen: h.now(), roles: [{ role: "reviewer", generation: 1 }] })
  })

  test("an offline named session stays listed until its name is released", () => {
    const h = setup()
    h.report(h.alice, root("ses_a", "API"))
    h.dir.sync(h.alice)
    h.report(h.alice)
    h.advance(DAY)
    expect(h.dir.who(h.alice)).toMatchObject([{ sessionID: "ses_a", name: "api", online: false }])
  })
})

describe("migrateLocal", () => {
  test("a local name colliding with an admin name for another session is kept with a suffix", () => {
    const h = setup()
    h.store.updateAgentData("local", () => ({ names: [{ name: "api", sessionID: "ses_local" }] }))
    h.store.updateAgentData(h.alice, () => ({ names: [{ name: "api", sessionID: "ses_admin" }] }))
    expect(h.store.migrateLocal(h.alice)).toBe(true)
    expect(h.data(h.alice).names).toEqual([
      { name: "api", sessionID: "ses_admin" },
      { name: "api-2", sessionID: "ses_local" },
    ])
  })
})
