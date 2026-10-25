// The SDK's launches (design §6.1; decision znbg8xa5 #1): hub.launches.create/list/get/stop send the requests the
// hub's /api/agent/launches routes expect (launch-routes.ts) and answer the hub's body; create says whether the
// launch is new (201) or an idempotent repeat of the same key (200).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, HubError, type LaunchView } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
const seen = () => hub.seen.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) }))

const launch: LaunchView = {
  id: "lch_1",
  state: "queued",
  reason: "waiting for a node",
  spec: { key: "k1", workspace: { repo: "/p/hub", mode: "worktree", branch: "feat/x" }, labels: { app: "brain" } },
  created: 1,
  updated: 1,
  by: "app:tok_1",
  history: [{ state: "queued", reason: "waiting for a node", at: 1 }],
}

describe("launches", () => {
  test("create: POST /api/agent/launches with the spec; 201 is new, 200 the same key again", async () => {
    let status = 201
    hub.routes["POST /api/agent/launches"] = () => Response.json({ launch }, { status })
    const spec = { key: "k1", workspace: { repo: "/p/hub", mode: "worktree" as const, branch: "feat/x" }, labels: { app: "brain" }, end: { when: "idle" as const, timeout: "4h" } }
    expect(await client().launches.create(spec)).toEqual({ launch, created: true })
    status = 200
    expect(await client().launches.create(spec)).toEqual({ launch, created: false })
    expect(seen()).toEqual([
      { method: "POST", path: "/api/agent/launches", body: spec },
      { method: "POST", path: "/api/agent/launches", body: spec },
    ])
    expect(hub.seen[0]!.headers.authorization).toBe("Bearer tok")
  })

  test("list: ?state comma-separated and repeated ?label", async () => {
    hub.routes["GET /api/agent/launches"] = () => Response.json({ launches: [launch] })
    expect(await client().launches.list()).toEqual({ launches: [launch] })
    await client().launches.list({ state: ["queued", "running"], label: ["app=brain", "brain.task=abc"] })
    await client().launches.list({ state: "ended" })
    expect(seen().map((s) => s.path)).toEqual([
      "/api/agent/launches",
      "/api/agent/launches?state=queued%2Crunning&label=app%3Dbrain&label=brain.task%3Dabc",
      "/api/agent/launches?state=ended",
    ])
  })

  test("get and stop: GET and DELETE /api/agent/launches/:id; a stopped launch that already ended is gone", async () => {
    hub.routes["GET /api/agent/launches/lch_1"] = () => Response.json({ launch })
    hub.routes["DELETE /api/agent/launches/lch_1"] = () => Response.json({ launch: { ...launch, state: "ended", outcome: "stopped" } })
    hub.routes["DELETE /api/agent/launches/lch_2"] = () => Response.json({ error: { code: "gone", message: "Launch lch_2 already ended" } }, { status: 410 })
    expect(await client().launches.get("lch_1")).toEqual({ launch })
    expect((await client().launches.stop("lch_1")).launch.outcome).toBe("stopped")
    const error = await client().launches.stop("lch_2").catch((e) => e)
    expect(error).toBeInstanceOf(HubError)
    expect(error.code).toBe("gone")
    expect(seen().map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/agent/launches/lch_1", "DELETE /api/agent/launches/lch_1", "DELETE /api/agent/launches/lch_2"])
  })
})

describe("the SDK's launch types follow packages/protocol", () => {
  test("a protocol LaunchSpec and LaunchInfo fit the SDK's (checked by tsc), and the enums match", async () => {
    const protocol = await import("../../protocol/src/launch.ts")
    const spec: import("../../protocol/src/launch.ts").LaunchSpec = { workspace: { repo: "/p", mode: "clone", remote: "https://h/r" }, runtime: { kind: "openshell" }, end: { when: "asked", cleanup: "remove" } }
    const asSdk: import("../src/index.ts").LaunchSpec = spec
    const info = { ...launch, spec: asSdk } satisfies LaunchView
    const fromProtocol: Omit<LaunchView, "history"> = { ...(info as unknown as import("../../protocol/src/launch.ts").LaunchInfo) }
    expect(fromProtocol.id).toBe("lch_1")
    const states: readonly import("../src/index.ts").LaunchState[] = protocol.LAUNCH_STATES
    const outcomes: readonly import("../src/index.ts").LaunchOutcome[] = protocol.LAUNCH_OUTCOMES
    expect(states.length + outcomes.length).toBe(11)
  })
})
