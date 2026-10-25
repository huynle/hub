// The launch routes (P4-T9; design §6.1, §7, §8; decision znbg8xa5) over a fake launch engine, grants, kill switch
// and audit: who may launch (users; apps with sessions:launch and a launch grant; sessions through their act token
// and a launch grant), the acting check order (kill switch → grant → consume → kill switch → engine), idempotent
// repeats (200, no grant action spent), the list filters and the API view of a launch.
import { beforeEach, describe, expect, test } from "bun:test"
import type { AgentActor, AppActor, SessionActor, UserActor } from "../src/central/agent/actor"
import type { AuditInput } from "../src/central/agent/audit"
import { AgentError } from "../src/central/agent/errors"
import type { Grant } from "../src/central/agent/grants"
import { type LaunchRoutesDeps, launchInfo, launchRoutes } from "../src/central/agent/launch-routes"
import { launchBodyKey, validateLaunchSpec } from "../src/central/agent/launch-spec"
import type { Launch, LaunchFilter } from "../src/central/agent/launch-store"
import { agentApi, type AgentRoute } from "../src/central/agent/routes"
import type { UserRecord } from "../src/central/store"

const USER = "u_1"
const user: UserActor = { kind: "user", userID: USER, deviceID: "dev_1", via: "cookie" }
const app = (scopes: string[] = ["sessions:launch"], tokenID = "tok_1"): AppActor => ({ kind: "app", userID: USER, tokenID, scopes })
const actSession: SessionActor = { kind: "session", userID: USER, machineID: "mch_1", sessionID: "ses_1", via: "act" }
const shellSession: SessionActor = { ...actSession, via: "shell" }

const REPO = "/p/hub"
const body = (extra: Record<string, unknown> = {}) => ({ key: "k1", workspace: { repo: REPO, branch: "feat/x" }, prompt: "Go", labels: { app: "brain", "brain.task": "t1" }, end: { timeout: "4h" }, ...extra })

/** An in-memory launch engine (accept, view, list, stop). */
class FakeLaunches {
  readonly launches: Launch[] = []
  accepted = 0
  private n = 0
  async accept(userID: string, input: unknown, options: { by?: string } = {}) {
    const spec = validateLaunchSpec(input)
    const existing = spec.key !== undefined ? this.launches.find((l) => l.owner === userID && l.spec.key === spec.key) : undefined
    if (existing) {
      if (launchBodyKey(existing.spec) !== launchBodyKey(spec)) throw new AgentError("invalid", "This key was used with another body", { hint: "Use a new key" })
      return { launch: existing, created: false }
    }
    this.accepted++
    const at = 1000 + this.n
    const launch: Launch = { id: `lch_${++this.n}`, owner: userID, spec, ...(options.by ? { by: options.by } : {}), state: "queued", reason: "Queued", at, created: at, history: [{ state: "queued", reason: "Queued", at }] }
    this.launches.push(launch)
    return { launch, created: true }
  }
  async view(userID: string, id: string) {
    return this.launches.find((l) => l.owner === userID && l.id === id)
  }
  async list(userID: string, filter: LaunchFilter = {}) {
    return this.launches.filter(
      (l) =>
        l.owner === userID &&
        (!filter.states || filter.states.includes(l.state)) &&
        Object.entries(filter.labels ?? {}).every(([k, v]) => l.spec.labels[k] === v),
    )
  }
  async stop(userID: string, id: string) {
    const index = this.launches.findIndex((l) => l.owner === userID && l.id === id)
    if (index < 0) throw new AgentError("not_found", `No launch ${id}`)
    const launch = this.launches[index]!
    if (launch.state === "ended") throw new AgentError("gone", "The launch already ended")
    const ended: Launch = { ...launch, state: "ended", reason: "Stopped", outcome: "stopped", at: 5000 }
    this.launches[index] = ended
    return ended
  }
  set(id: string, patch: Partial<Launch>) {
    const index = this.launches.findIndex((l) => l.id === id)
    this.launches[index] = { ...this.launches[index]!, ...patch }
  }
}

const grant = (id = "grt_1"): Grant => ({ id, owner: USER, holder: "app:tok_1", scope: { projects: [REPO] }, allow: ["launch"], permissions: { allow: [], never: [] }, allowAlways: false, maxActionsPerHour: 30, created: 1, expires: 9e15 }) as unknown as Grant

let launches: FakeLaunches
let usable: Grant[]
let usableCalls: Array<{ actor: AgentActor; verb: string; target: { directory: string } }>
let consumed: string[]
let consumeError: AgentError | undefined
let paused: boolean
let pauseOnConsume: boolean
let audited: AuditInput[]
let actor: AgentActor

function deps(): LaunchRoutesDeps {
  return {
    launches,
    grants: {
      usable: async (a, verb, target) => {
        usableCalls.push({ actor: a, verb, target })
        return usable
      },
      consume: async (g) => {
        if (consumeError) throw consumeError
        consumed.push(g.id)
        if (pauseOnConsume) paused = true
      },
    },
    acting: {
      ensureActing: () => {
        if (paused) throw new AgentError("paused", "Agent actions are off for this user")
      },
    },
    audit: { record: async (_userID, entry) => (audited.push(entry), { ...entry, seq: audited.length, at: 0 }) },
  }
}

const userRecord = { id: USER, role: "user" } as UserRecord

function api(routes: readonly AgentRoute[]) {
  return agentApi({
    resolve: Object.assign(async () => ({ ok: true as const, credential: "app-token" as const, actor, user: userRecord }), { mode: async () => "bearer" as const }),
    cookieName: "voice_device",
    sameOrigin: () => true,
    routes,
  })
}

async function call(method: string, pathname: string, json?: unknown) {
  const url = new URL(`http://hub.test${pathname}`)
  const init: RequestInit = { method, headers: { authorization: "Bearer x", "content-type": "application/json" } }
  if (json !== undefined) init.body = JSON.stringify(json)
  const res = await api(launchRoutes(deps())).handle(new Request(url, init), url)
  return { status: res.status, body: (await res.json()) as any }
}

beforeEach(() => {
  launches = new FakeLaunches()
  usable = []
  usableCalls = []
  consumed = []
  consumeError = undefined
  paused = false
  pauseOnConsume = false
  audited = []
  actor = user
})

describe("POST /api/agent/launches", () => {
  test("a user launches: 201 {launch} in the API view; the same key and body again is 200 with the same launch", async () => {
    const created = await call("POST", "/api/agent/launches", body())
    expect(created.status).toBe(201)
    expect(created.body.launch).toMatchObject({ id: "lch_1", state: "queued", reason: "Queued", by: "user", created: 1000, updated: 1000 })
    expect(created.body.launch.spec).toMatchObject({ key: "k1", workspace: { repo: REPO, branch: "feat/x", mode: "worktree" }, labels: { app: "brain" }, end: { when: "idle", timeout: "4h", cleanup: "keep" } })
    expect(created.body.launch.owner).toBeUndefined()
    const again = await call("POST", "/api/agent/launches", body())
    expect(again.status).toBe(200)
    expect(again.body.launch.id).toBe("lch_1")
    expect(launches.accepted).toBe(1)
    expect(audited.map((e) => [e.verb, e.target, e.decision, e.outcome])).toEqual([
      ["launch", { launchID: "lch_1" }, "allow", "ok"],
      ["launch", { launchID: "lch_1" }, "allow", "ok"],
    ])
    // users need no grant and no kill switch check
    expect(usableCalls).toEqual([])
  })

  test("a reused key with another body is 400 invalid with a hint; a malformed body is 400", async () => {
    await call("POST", "/api/agent/launches", body())
    const other = await call("POST", "/api/agent/launches", body({ prompt: "Other" }))
    expect(other.status).toBe(400)
    expect(other.body.error).toMatchObject({ code: "invalid", hint: expect.any(String) })
    expect((await call("POST", "/api/agent/launches", { workspace: { repo: "relative" } })).status).toBe(400)
    expect((await call("POST", "/api/agent/launches", [1])).status).toBe(400)
    expect((await call("POST", "/api/agent/launches", body({ grant: "grt_1" }))).status).toBe(400)
  })

  test("an app token needs scope sessions:launch (403 before anything else)", async () => {
    actor = app(["sessions:act"])
    expect((await call("POST", "/api/agent/launches", body())).status).toBe(403)
    expect(usableCalls).toEqual([])
    expect(audited).toEqual([])
  })

  test("an app with the scope but no launch grant on the repo is forbidden, audited, nothing launched", async () => {
    actor = app()
    const res = await call("POST", "/api/agent/launches", body())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("forbidden")
    expect(usableCalls).toEqual([{ actor, verb: "launch", target: { directory: REPO } }])
    expect(launches.accepted).toBe(0)
    expect(audited).toMatchObject([{ verb: "launch", actor: { kind: "app", tokenID: "tok_1" }, decision: "forbidden", outcome: "refused" }])
  })

  test("an app under a launch grant launches as app:<token>; the grant action is spent once, never for a repeat", async () => {
    actor = app()
    usable = [grant()]
    const res = await call("POST", "/api/agent/launches", body())
    expect(res.status).toBe(201)
    expect(res.body.launch.by).toBe("app:tok_1")
    expect(consumed).toEqual(["grt_1"])
    expect((await call("POST", "/api/agent/launches", body())).status).toBe(200)
    expect(consumed).toEqual(["grt_1"])
    expect(audited).toMatchObject([
      { verb: "launch", grant: "grt_1", decision: "allow", outcome: "ok", target: { launchID: "lch_1" } },
      { verb: "launch", grant: "grt_1", decision: "allow", outcome: "ok", target: { launchID: "lch_1" } },
    ])
  })

  test("the kill switch: paused before the grant (423), and again after the grant action (nothing launched)", async () => {
    actor = app()
    usable = [grant()]
    paused = true
    const before = await call("POST", "/api/agent/launches", body())
    expect(before.status).toBe(423)
    expect(usableCalls).toEqual([])
    paused = false
    pauseOnConsume = true
    const after = await call("POST", "/api/agent/launches", body())
    expect(after.status).toBe(423)
    expect(launches.accepted).toBe(0)
    expect(audited.map((e) => [e.decision, e.outcome])).toEqual([
      ["paused", "refused"],
      ["paused", "refused"],
    ])
  })

  test("the grant's hourly cap: 429 rate_limited with retryAfter, nothing launched", async () => {
    actor = app()
    usable = [grant()]
    consumeError = new AgentError("rate_limited", "The grant allows 30 actions an hour", { extra: { retryAfter: 60 } })
    const res = await call("POST", "/api/agent/launches", body())
    expect(res.status).toBe(429)
    expect(res.body.error.retryAfter).toBe(60)
    expect(launches.accepted).toBe(0)
    expect(audited).toMatchObject([{ decision: "rate_limited", outcome: "refused" }])
  })

  test("an app reusing a key another launcher used is 400 invalid (never another's launch); the user's own repeat still works", async () => {
    await call("POST", "/api/agent/launches", body())
    actor = app()
    usable = [grant()]
    const res = await call("POST", "/api/agent/launches", body())
    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: "invalid", hint: expect.any(String) })
    expect(res.body.launch).toBeUndefined()
    expect(consumed).toEqual([])
    actor = user
    expect((await call("POST", "/api/agent/launches", body())).status).toBe(200)
  })

  test("sessions launch only through their act token and a launch grant", async () => {
    actor = shellSession
    usable = [grant()]
    expect((await call("POST", "/api/agent/launches", body())).status).toBe(403)
    actor = actSession
    const res = await call("POST", "/api/agent/launches", body())
    expect(res.status).toBe(201)
    expect(res.body.launch.by).toBe("ses_1")
  })
})

describe("GET /api/agent/launches and /api/agent/launches/:id", () => {
  async function seed() {
    await call("POST", "/api/agent/launches", body())
    await call("POST", "/api/agent/launches", body({ key: "k2", labels: { app: "other" } }))
    launches.set("lch_2", { state: "running", sessionID: "ses_9", name: "api" })
  }

  test("the user lists every launch, filtered by state (comma list) and label k=v (all must match)", async () => {
    await seed()
    const all = await call("GET", "/api/agent/launches")
    expect(all.status).toBe(200)
    expect(all.body.launches.map((l: any) => l.id)).toEqual(["lch_1", "lch_2"])
    expect((await call("GET", "/api/agent/launches?state=running,ended")).body.launches.map((l: any) => l.id)).toEqual(["lch_2"])
    expect((await call("GET", "/api/agent/launches?label=app=brain")).body.launches.map((l: any) => l.id)).toEqual(["lch_1"])
    expect((await call("GET", "/api/agent/launches?label=app=brain&label=brain.task=t1")).body.launches.map((l: any) => l.id)).toEqual(["lch_1"])
    expect((await call("GET", "/api/agent/launches?label=app=brain&label=brain.task=t2")).body.launches).toEqual([])
    expect((await call("GET", "/api/agent/launches?state=bogus")).status).toBe(400)
    expect((await call("GET", "/api/agent/launches?label=nokey")).status).toBe(400)
  })

  test("one launch by id; unknown is 404 not_found", async () => {
    await seed()
    const one = await call("GET", "/api/agent/launches/lch_2")
    expect(one.status).toBe(200)
    expect(one.body.launch).toMatchObject({ id: "lch_2", state: "running", sessionID: "ses_9", name: "api" })
    const missing = await call("GET", "/api/agent/launches/lch_404")
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("not_found")
  })

  test("an app or session sees only the launches it started; others are not_found like unknown ones", async () => {
    await seed()
    actor = app()
    usable = [grant()]
    await call("POST", "/api/agent/launches", body({ key: "k3" }))
    expect((await call("GET", "/api/agent/launches")).body.launches.map((l: any) => l.id)).toEqual(["lch_3"])
    expect((await call("GET", "/api/agent/launches/lch_3")).status).toBe(200)
    expect((await call("GET", "/api/agent/launches/lch_1")).status).toBe(404)
    actor = app(["sessions:launch"], "tok_2")
    expect((await call("GET", "/api/agent/launches")).body.launches).toEqual([])
    expect((await call("GET", "/api/agent/launches/lch_3")).status).toBe(404)
    actor = app(["sessions:read"])
    expect((await call("GET", "/api/agent/launches")).status).toBe(403)
  })
})

describe("DELETE /api/agent/launches/:id", () => {
  test("the user stops a launch (200 {launch} ended stopped); again is 410 gone; unknown is 404", async () => {
    await call("POST", "/api/agent/launches", body())
    const stopped = await call("DELETE", "/api/agent/launches/lch_1")
    expect(stopped.status).toBe(200)
    expect(stopped.body.launch).toMatchObject({ id: "lch_1", state: "ended", outcome: "stopped" })
    expect((await call("DELETE", "/api/agent/launches/lch_1")).status).toBe(410)
    expect((await call("DELETE", "/api/agent/launches/lch_404")).status).toBe(404)
    // an unknown launch is not audited (no target)
    expect(audited.slice(-2)).toMatchObject([
      { verb: "launch.stop", target: { launchID: "lch_1" }, decision: "allow", outcome: "ok" },
      { verb: "launch.stop", target: { launchID: "lch_1" }, decision: "allow", outcome: "gone" },
    ])
  })

  test("an app stops only its own launches, under its launch grant and the kill switch", async () => {
    await call("POST", "/api/agent/launches", body())
    actor = app()
    usable = [grant()]
    await call("POST", "/api/agent/launches", body({ key: "k2" }))
    expect((await call("DELETE", "/api/agent/launches/lch_1")).status).toBe(404)
    expect(launches.launches[0]!.state).toBe("queued")
    paused = true
    expect((await call("DELETE", "/api/agent/launches/lch_2")).status).toBe(423)
    paused = false
    usable = []
    expect((await call("DELETE", "/api/agent/launches/lch_2")).status).toBe(403)
    usable = [grant()]
    consumed.length = 0
    expect((await call("DELETE", "/api/agent/launches/lch_2")).status).toBe(200)
    expect(consumed).toEqual(["grt_1"])
    expect(audited.at(-1)).toMatchObject({ verb: "launch.stop", grant: "grt_1", decision: "allow", outcome: "ok", target: { launchID: "lch_2" } })
  })
})

describe("launchInfo", () => {
  test("the API view: no owner; updated is the state's time; timeouts as durations; directory when known", () => {
    const spec = validateLaunchSpec({ workspace: { repo: REPO, branch: "b" }, end: { timeout: 5400 } })
    const launch: Launch = { id: "lch_1", owner: USER, spec, state: "running", reason: "Running", at: 7, created: 3, sessionID: "ses_1", history: [] }
    const info = launchInfo({ ...launch, directory: "/p/hub/.worktrees/b" })
    expect(info).toMatchObject({ id: "lch_1", state: "running", created: 3, updated: 7, sessionID: "ses_1", directory: "/p/hub/.worktrees/b" })
    expect(info.spec.end).toEqual({ when: "idle", timeout: "90m", cleanup: "keep" })
    expect("owner" in info).toBe(false)
  })
})
