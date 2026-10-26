// The Codex spoke end to end against a fake hub and the fake app-server (fixtures/fake-app-server.ts): it attaches
// to the shared daemon's threads (a "TUI" client starts them), starts its own app-server over stdio for creates, and
// serves the hub's ops there. Every process is stopped after each test.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fakeHub, stubModel, until, type FakeHub } from "../../testkit/src/index.ts"
import { codexSessionID } from "../src/ids.ts"
import { JsonRpcPeer } from "../src/jsonrpc.ts"
import { startCodexSpoke, type CodexSpoke, type CodexSpokeOptions } from "../src/spoke.ts"
import { connectUnixWebSocket } from "../src/websocket.ts"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-app-server.ts")
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function daemon(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cx-d-"))
  const socket = path.join(dir, "d.sock")
  let child: ChildProcess | undefined
  const start = async () => {
    child = spawn(process.execPath, [FAKE, "app-server", "--listen", `unix://${socket}`], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] })
    await new Promise<void>((resolve) => child!.stdout!.once("data", () => resolve()))
  }
  const kill = async () => {
    if (!child || child.exitCode !== null) return
    const gone = new Promise((r) => child!.once("exit", r))
    child.kill("SIGTERM")
    await gone
  }
  await start()
  cleanup.push(async () => {
    await kill()
    rmSync(dir, { recursive: true, force: true })
  })
  return { socket, dir, kill, start }
}

/** Another client of the daemon (as the TUI is): starts threads and turns, answers approvals. */
async function tui(socket: string) {
  const channel = await connectUnixWebSocket(socket)
  const approvals: { id: number | string; params: any }[] = []
  const notes: { method: string; params: any }[] = []
  const peer = new JsonRpcPeer(channel, { onRequest: (id, _m, params) => approvals.push({ id, params }), onNotification: (method, params) => notes.push({ method, params }) })
  await peer.request("initialize", { clientInfo: { name: "tui", version: "0" }, capabilities: { experimentalApi: true } })
  peer.notify("initialized")
  cleanup.push(() => peer.close())
  return { peer, approvals, notes }
}

function start(hub: FakeHub, options: Partial<CodexSpokeOptions> = {}): CodexSpoke {
  const spoke = startCodexSpoke({
    server: hub.url,
    token: "hmt1.MACHINE-SECRET",
    harnessVersion: "0.160.0",
    pluginVersion: "0.6.1",
    directory: "/w",
    codexBin: process.execPath,
    codexBinArgs: [FAKE],
    env: { ...process.env },
    pollMs: 50,
    threadDefaults: { approvalPolicy: "untrusted" },
    backoff: { minMs: 20, maxMs: 50 },
    ...options,
  } as CodexSpokeOptions)
  cleanup.push(() => spoke.stop())
  return spoke
}

const events = (hub: FakeHub, sessionID: string) =>
  hub.frames.flatMap((f) => (f.t === "event" && (f.event.data as any)?.sessionID === sessionID ? [f.event as { type: string; data: any }] : []))
const reported = (hub: FakeHub, sessionID: string) => hub.frames.filter((f) => f.t === "sessions").at(-1)?.t === "sessions" && (hub.frames.filter((f) => f.t === "sessions").at(-1) as any).sessions.some((s: any) => s.id === sessionID)

function newHub() {
  const hub = fakeHub({ hubFeatures: ["harness", "messaging", "launches"] })
  cleanup.push(() => hub.stop())
  return hub
}

describe("codex spoke", () => {
  test("hello: harness codex, evidence rpc, the core ops, deliver, create (launch) and turnEvents", async () => {
    const hub = newHub()
    start(hub)
    const hello = await hub.next((f) => f.t === "hello", 5000)
    if (hello.t !== "hello") throw new Error("no hello")
    expect(hello.harness).toBe("codex")
    expect(hello.harnessVersion).toBe("0.160.0")
    expect(hello.evidence).toBe("rpc")
    expect([...hello.features!].sort()).toEqual(["actTokens", "create", "deliver", "hubPrompt", "interrupt", "launch", "permission", "sessionTokens", "steer", "stop", "turn", "turnEvents"].sort())
  })

  test("attaches to the daemon's threads: a TUI thread is reported, its turn reaches the hub, the hub's turn runs in it", async () => {
    const hub = newHub()
    const d = await daemon()
    const client = await tui(d.socket)
    const started = await client.peer.request("thread/start", { cwd: d.dir, approvalPolicy: "never" })
    const sessionID = codexSessionID(started.thread.id)
    start(hub, { daemonSocket: d.socket })
    await until(() => reported(hub, sessionID), 5000)
    await client.peer.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "hi", text_elements: [] }] })
    await until(() => events(hub, sessionID).some((e) => e.type === "session.execution.succeeded"), 5000)
    expect(events(hub, sessionID).map((e) => e.type)).toContain("session.inbox.delivered")
    expect(events(hub, sessionID).find((e) => e.type === "session.inbox.delivered")!.data.origin).toBe("user")
    const res = await hub.request({ op: "turn", sessionID, text: "from the hub", voiceStyle: false })
    expect(res).toMatchObject({ ok: true, result: { outcome: "succeeded", reply: "ack" } })
    // The TUI sees the hub's turn too.
    expect(client.notes.filter((n) => n.method === "turn/completed")).toHaveLength(2)
  })

  test("a thread the TUI starts after the spoke attached is found (thread/loaded/list polling)", async () => {
    const hub = newHub()
    const d = await daemon()
    const spoke = start(hub, { daemonSocket: d.socket })
    await until(() => spoke.daemonConnected, 5000)
    const client = await tui(d.socket)
    const started = await client.peer.request("thread/start", { cwd: d.dir })
    await until(() => reported(hub, codexSessionID(started.thread.id)), 5000)
  })

  test("approvals race the TUI: the TUI answering first makes the hub's answer gone", async () => {
    const hub = newHub()
    const stub = stubModel()
    cleanup.push(() => stub.stop())
    const d = await daemon({ FAKE_CODEX_MODEL_URL: stub.openaiBaseURL })
    const client = await tui(d.socket)
    const started = await client.peer.request("thread/start", { cwd: d.dir, approvalPolicy: "untrusted" })
    const sessionID = codexSessionID(started.thread.id)
    start(hub, { daemonSocket: d.socket })
    await until(() => reported(hub, sessionID), 5000)
    stub.queue({ toolCalls: [{ name: "exec_command", input: { cmd: "touch x" }, id: "call_race" }] }, { text: "done" })
    await client.peer.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] })
    await until(() => events(hub, sessionID).some((e) => e.type === "permission.asked") && client.approvals.length === 1, 5000)
    const asked = events(hub, sessionID).find((e) => e.type === "permission.asked")!
    expect(asked.data).toMatchObject({ action: "shell", resources: ["/bin/bash -lc 'touch x'"], source: { id: "call_race" } })
    client.peer.respond(client.approvals[0]!.id, { decision: "accept" })
    await until(() => events(hub, sessionID).some((e) => e.type === "permission.replied"), 5000)
    expect(events(hub, sessionID).find((e) => e.type === "permission.replied")!.data.reply).toBeUndefined()
    const res = await hub.request({ op: "permission", sessionID, requestID: asked.data.id, decision: "reject" })
    expect(res).toMatchObject({ ok: true, result: { gone: true } })
    await until(() => events(hub, sessionID).some((e) => e.type === "session.execution.succeeded"), 5000)
    expect(events(hub, sessionID).some((e) => e.type === "session.tool.success")).toBe(true)
  })

  test("create starts a thread on the spoke's own app-server (stdio); the hub's ops work there", async () => {
    const hub = newHub()
    const dir = mkdtempSync(path.join(tmpdir(), "cx-w-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    start(hub)
    await hub.next((f) => f.t === "hello", 5000)
    const created = await hub.request({ op: "create", directory: dir, title: "Hub work" })
    expect(created).toMatchObject({ ok: true })
    const sessionID = (created as any).result.sessionID as string
    expect(sessionID).toMatch(/^ses_cx[0-9a-f]{32}$/)
    await until(() => reported(hub, sessionID), 5000)
    const turn = await hub.request({ op: "turn", sessionID, text: "hello", voiceStyle: false })
    expect(turn).toMatchObject({ ok: true, result: { outcome: "succeeded", reply: "ack" } })
    const delivered = await hub.request({ op: "deliver", sessionID, messageID: "msg_1", text: "a message", wake: false, meta: { kind: "msg", from: "@a", to: "@b" } })
    expect(delivered).toMatchObject({ ok: true, result: { delivered: "queued" } })
    const again = await hub.request({ op: "deliver", sessionID, messageID: "msg_1", text: "a message", wake: false, meta: { kind: "msg", from: "@a", to: "@b" } })
    expect((again as any).result).toEqual((delivered as any).result)
    const slow = hub.request({ op: "turn", sessionID, text: "SLOW:5000", voiceStyle: false })
    await until(() => events(hub, sessionID).filter((e) => e.type === "session.execution.started").length === 2, 5000)
    expect(await hub.request({ op: "stop", sessionID })).toMatchObject({ ok: true, result: { stopped: [sessionID] } })
    expect(await slow).toMatchObject({ ok: true, result: { outcome: "interrupted" } })
    expect(events(hub, sessionID).at(-1)!.type).toBe("session.execution.interrupted")
  })

  test("the daemon going away ends its sessions; when it is back the spoke attaches again", async () => {
    const hub = newHub()
    const d = await daemon()
    const client = await tui(d.socket)
    const started = await client.peer.request("thread/start", { cwd: d.dir })
    const sessionID = codexSessionID(started.thread.id)
    const spoke = start(hub, { daemonSocket: d.socket })
    await until(() => reported(hub, sessionID), 5000)
    await d.kill()
    await until(() => !spoke.daemonConnected && !reported(hub, sessionID), 5000)
    await d.start()
    const again = await tui(d.socket)
    const next = await again.peer.request("thread/start", { cwd: d.dir })
    await until(() => reported(hub, codexSessionID(next.thread.id)), 5000)
  })
})
