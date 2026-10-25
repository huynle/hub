// Spokes of several harnesses on one machine (phase 7, decision fx04e42c #1/#3), end to end over /spoke/ws: an
// OpenCode service spoke and a Claude Code service spoke connect from the same machine. OpenCode launches still go
// to the OpenCode service; core ops the Claude Code spoke did not announce are refused as unsupported (console: 409
// code unsupported; agent API: 422 {code: unsupported, feature, harness}) without reaching it; its events are
// checked against the harness event subset, and an invalid one is dropped (logged), never fatal.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { NODE_ROLE, PROTOCOL_VERSION, type Hello, type NodeHello } from "../src/protocol"
import { connect, harness, session, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any

const nodeHello: NodeHello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode", "claude-code"] }],
  labels: {},
  capacity: { slots: 2 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launches: [],
}

/** A Claude Code hooks spoke's hello: it serves permission only among the core ops. */
const claudeHello: Partial<Hello> = {
  kind: "service",
  harness: "claude-code",
  harnessVersion: "2.1.296",
  evidence: "hooks",
  features: ["launch", "deliver"],
}

/** Answers every request on the socket with reply(req) (a res body) and records it. */
function serve(client: { ws: WebSocket; send(frame: any): void }, reply: (req: any) => Record<string, unknown> | undefined = () => ({ ok: true, result: {} })) {
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

describe("an OpenCode and a Claude Code service spoke on one machine", () => {
  test("an OpenCode launch still goes to the OpenCode service spoke", async () => {
    h = await harness()
    const { token } = await h.store.addMachine("mbp")
    const node = await connect(h, token)
    node.send({ ...nodeHello })
    await node.next((f) => f.t === "welcome")
    const directory = "/p/hub/.worktrees/feat/x"
    serve(node, (req) => {
      if (req.op === "prepare") return { ok: true, result: { workspace: { repo: "/p/hub", directory, mode: "worktree", branch: "feat/x", reused: false } } }
      if (req.op === "collect") return { ok: true, result: { artifacts: { branch: "feat/x", commits: 1 } } }
      if (req.op === "cleanup") return { ok: true, result: { removed: false, reason: "cleanup policy is keep" } }
      return { ok: true, result: { cancelled: false } }
    })
    const opencode = await spoke(h, { machine: { token }, processID: "svc", hello: { kind: "service", features: ["launch", "deliver"] }, sessions: [] })
    const opencodeOps = serve(opencode, (req) => {
      if (req.op === "create") {
        opencode.send({ t: "sessions", sessions: [{ id: "ses_l1", title: req.title ?? "", directory, updated: 2, owned: true }] })
        return { ok: true, result: { sessionID: "ses_l1" } }
      }
      if (req.op === "turn") return undefined
      return { ok: true, result: {} }
    })
    // Connected later: the most recent service of the machine, but of another harness.
    const claude = await spoke(h, { machine: { token }, processID: "cc", hello: claudeHello, sessions: [] })
    const claudeOps = serve(claude)
    const machineID = (await h.store.findMachine(token))!.id
    await waitFor(() => h.nodes.count() === 1 && h.registry.serviceHarnesses(machineID).length === 2)

    const { launch } = await h.launches.accept("local", { workspace: { repo: "/p/hub", branch: "feat/x" }, prompt: "Go" }, { by: "user" })
    let current = launch
    await waitFor(() => {
      void h.launches.store.get("local", launch.id).then((l) => (current = l!))
      return current.state === "running" || current.state === "ended"
    }, 4000)
    expect(current).toMatchObject({ state: "running", sessionID: "ses_l1" })
    expect(opencodeOps.find((r) => r.op === "create")).toMatchObject({ directory, launchID: launch.id })
    expect(claudeOps.filter((r) => r.op === "create")).toEqual([])
  })
})

async function claudeSession() {
  h = await harness()
  const client = await spoke(h, { hello: claudeHello, sessions: [session("ses_cc1", { owned: true })] })
  const ops = serve(client)
  return { client, ops }
}

describe("core ops a Claude Code spoke did not announce", () => {
  test("console stop, turn, interrupt and utterance: 409 unsupported, nothing sent", async () => {
    const { ops } = await claudeSession()
    for (const [verb, body] of [["stop", {}], ["turn", { text: "hi" }], ["interrupt", {}], ["utterance", { text: "hi" }]] as const) {
      const res = await h.api(`/api/sessions/ses_cc1/${verb}`, { method: "POST", json: body })
      expect([verb, res.status]).toEqual([verb, 409])
      expect(await json(res)).toMatchObject({ code: "unsupported", error: expect.stringContaining("claude-code") })
    }
    expect(ops).toEqual([])
  })

  test("agent API stop and prompt: 422 unsupported {feature, harness}", async () => {
    const { ops } = await claudeSession()
    const stop = await h.api("/api/agent/sessions/ses_cc1/stop", { method: "POST", json: {} })
    expect(stop.status).toBe(422)
    expect((await json(stop)).error).toMatchObject({ code: "unsupported", feature: "stop", harness: "claude-code" })
    const prompt = await h.api("/api/agent/sessions/ses_cc1/prompt", { method: "POST", json: { text: "hi" } })
    expect(prompt.status).toBe(422)
    expect((await json(prompt)).error).toMatchObject({ code: "unsupported", feature: "turn", harness: "claude-code" })
    expect(ops).toEqual([])
  })

  test("a permission request it reported but cannot be answered through: console 409 unsupported", async () => {
    const { client, ops } = await claudeSession()
    client.send({ t: "event", event: { type: "permission.asked", data: { sessionID: "ses_cc1", id: "per_1", action: "shell", resources: ["ls"] } } })
    await waitFor(() => h.registry.permissionTargets("ses_cc1", "per_1").length === 1)
    const res = await h.api("/api/sessions/ses_cc1/permission", { method: "POST", json: { requestID: "per_1", decision: "once" } })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: "unsupported" })
    expect(ops).toEqual([])
  })
})

describe("harness events", () => {
  test("an invalid event of a non-OpenCode spoke is dropped and logged; the connection stays", async () => {
    const logged: string[] = []
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")))
    try {
      const { client } = await claudeSession()
      client.send({ t: "sessions", sessions: [session("ses_cc1", { owned: true }), session("ses_cc2", { owned: true })] })
      await waitFor(() => h.registry.hasSession("ses_cc2"))
      // turnID with a space is not an ID (harness event subset); OpenCode spokes are not checked this way.
      client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_cc1", turnID: "not an id" } } })
      client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_cc2" } } })
      await waitFor(() => h.registry.running("ses_cc2"))
      expect(h.registry.running("ses_cc1")).toBe(false)
      expect(client.ws.readyState).toBe(WebSocket.OPEN)
      expect(logged.some((line) => line.includes("session.execution.started") && line.includes("turnID"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test("an OpenCode spoke's events are not checked against the harness subset", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_oc1", { owned: true })] })
    client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_oc1", turnID: "not an id" } } })
    await waitFor(() => h.registry.running("ses_oc1"))
  })
})
