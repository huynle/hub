// The launch engine wired into the hub (P4-T8): Central.launches over the real NodeRegistry, SpokeHub, Registry,
// directory, delivery and actions. A raw node client prepares and cleans up; a fake service spoke announcing
// "launch" creates the session and runs its turn.
import { afterEach, expect, test } from "bun:test"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"
import { connect, harness, hello, PUBLIC, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const nodeHello: NodeHello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 2 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launches: [],
}

/** Answers every request on the socket with reply(req) (a res body). */
function serve(client: { ws: WebSocket; send(frame: any): void }, reply: (req: any) => Record<string, unknown> | undefined) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const body = reply(frame.req)
    if (body) client.send({ t: "res", id: frame.id, ...body })
  })
  return seen
}

test("Central.launches places a launch on the node, creates and prompts its session, and stops it with cleanup", async () => {
  h = harness()
  const { token } = h.store.addMachine("mbp")
  const node = await connect(h, token)
  node.send({ ...nodeHello })
  await node.next((f) => f.t === "welcome")
  const directory = "/p/hub/.worktrees/feat/x"
  const nodeOps = serve(node, (req) => {
    if (req.op === "prepare") return { ok: true, result: { workspace: { repo: "/p/hub", directory, mode: "worktree", branch: "feat/x", reused: false } } }
    if (req.op === "collect") return { ok: true, result: { artifacts: { branch: "feat/x", commits: 1 } } }
    if (req.op === "cleanup") return { ok: true, result: { removed: false, reason: "cleanup policy is keep" } }
    return { ok: true, result: { cancelled: false } }
  })
  const service = await spoke(h, { machine: { token }, processID: "svc", hello: { kind: "service", features: ["launch", "deliver"] }, sessions: [] })
  const spokeOps = serve(service, (req) => {
    if (req.op === "create") {
      service.send({ t: "sessions", sessions: [{ id: "ses_l1", title: req.title ?? "", directory, updated: 2, owned: true }] })
      return { ok: true, result: { sessionID: "ses_l1" } }
    }
    if (req.op === "deliver") return { ok: true, result: { delivery: "steer" } }
    if (req.op === "turn") return undefined
    if (req.op === "stop") return { ok: true, result: { stopped: [req.sessionID] } }
    return { ok: true, result: {} }
  })
  await waitFor(() => h.nodes.count() === 1 && h.registry.serviceFor(h.store.findMachine(token)!.id) !== undefined)

  const { launch } = await h.launches.accept("local", { name: "api", workspace: { repo: "/p/hub", branch: "feat/x" }, prompt: "Go", labels: { app: "brain" } }, { by: "user" })
  let current = launch
  await waitFor(() => {
    void h.launches.store.get("local", launch.id).then((l) => (current = l!))
    return current.state === "running" || current.state === "ended"
  }, 4000)
  expect(current).toMatchObject({ state: "running", sessionID: "ses_l1", name: "api" })
  expect(nodeOps[0]).toMatchObject({ op: "prepare", launchID: launch.id })
  expect(spokeOps.map((r) => r.op)).toContain("create")
  expect(spokeOps.find((r) => r.op === "create")).toMatchObject({ directory, launchID: launch.id, title: "api" })
  expect(spokeOps.find((r) => r.op === "turn")).toMatchObject({ sessionID: "ses_l1", text: "Go" })
  expect(await h.launches.labelsFor("local", "ses_l1")).toEqual({ app: "brain" })

  const stopped = await h.launches.stop("local", launch.id)
  expect(stopped).toMatchObject({ state: "ended", outcome: "stopped", artifacts: { commits: 1 } })
  expect(nodeOps.map((r) => r.op)).toEqual(["prepare", "collect", "cleanup"])
})

test("an openshell launch: the node starts the harness with the hub's URL and an hlt1 token; the launch-bound spoke creates the session", async () => {
  h = harness()
  const { token } = h.store.addMachine("box")
  const node = await connect(h, token)
  node.send({ ...nodeHello, features: ["sandbox"], runtimes: [{ kind: "openshell", harnesses: ["opencode"] }] })
  await node.next((f) => f.t === "welcome")
  const workspace = { repo: "/p/hub", directory: "/sandbox/work", mode: "clone", branch: "feat/x", reused: false, runtime: { kind: "openshell", sandbox: "hub-0123456789abcdef0123" } }
  let boxed: Awaited<ReturnType<typeof connect>> | undefined
  const boxedOps: any[] = []
  const nodeOps = serve(node, (req) => {
    if (req.op === "prepare") return { ok: true, result: { workspace } }
    if (req.op === "start") {
      // The sandbox's harness connects back with the launch token, bound to the launch.
      void (async () => {
        boxed = await connect(h, req.hub.token)
        boxed.send(hello("box1", { kind: "service", features: ["launch", "deliver"], launchID: req.launchID }))
        const seen = serve(boxed, (r) => {
          if (r.op === "create") {
            boxed!.send({ t: "sessions", sessions: [{ id: "ses_b1", title: r.title ?? "", directory: "/sandbox/work", updated: 2, owned: true }] })
            return { ok: true, result: { sessionID: "ses_b1" } }
          }
          if (r.op === "deliver") return { ok: true, result: { delivery: "steer" } }
          if (r.op === "turn") return undefined
          if (r.op === "stop") return { ok: true, result: { stopped: [r.sessionID] } }
          return { ok: true, result: {} }
        })
        boxedOps.push(seen)
      })()
      return { ok: true, result: { started: true } }
    }
    if (req.op === "stop") return { ok: true, result: { stopped: true } }
    if (req.op === "collect") return { ok: true, result: { artifacts: { branch: "feat/x", commits: 1 } } }
    if (req.op === "cleanup") return { ok: true, result: { removed: true } }
    return { ok: true, result: { cancelled: false } }
  })
  await waitFor(() => h.nodes.count() === 1)

  const body = { workspace: { repo: "/p/hub", mode: "clone", remote: "https://github.com/a/b", branch: "feat/x" }, runtime: { kind: "openshell" }, prompt: "Go" }
  const { launch } = await h.launches.accept("local", body, { by: "user" })
  let current = launch
  await waitFor(() => {
    void h.launches.store.get("local", launch.id).then((l) => (current = l!))
    return current.state === "running" || current.state === "ended"
  }, 4000)
  expect(current).toMatchObject({ state: "running", sessionID: "ses_b1" })
  const start = nodeOps.find((r) => r.op === "start")
  expect(start).toMatchObject({ launchID: launch.id, harness: "opencode", workspace, hub: { url: PUBLIC } })
  expect(start.hub.token).toStartWith("hlt1.")
  expect(h.registry.launchConn(launch.id)).toBeDefined()
  const created = (boxedOps[0] as any[]).find((r) => r.op === "create")
  expect(created).toMatchObject({ directory: "/sandbox/work", launchID: launch.id })

  const stopped = await h.launches.stop("local", launch.id)
  expect(stopped).toMatchObject({ state: "ended", outcome: "stopped", artifacts: { commits: 1 } })
  expect(nodeOps.map((r) => r.op)).toEqual(["prepare", "start", "stop", "collect", "cleanup"])
  await waitFor(() => h.registry.launchConn(launch.id) === undefined)
})
