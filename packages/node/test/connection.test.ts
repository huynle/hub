// The node's connection to the hub: /spoke/ws with the machine token, a node hello, the hub's ops answered, short
// backoff after failures and a long one for a hub without nodes (an old hub rejects the node hello).
import { afterEach, describe, expect, test } from "bun:test"
import { PROTOCOL_VERSION, type NodeRequest } from "../../protocol/src/index.ts"
import { NodeConnection, type NodeConnectionOptions, type SocketLike } from "../src/connection.ts"

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: unknown[] = []
  closed?: { code?: number; reason?: string }
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.readyState = 3
  }
  // test side
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met")
    await sleep(5)
  }
}

const welcome = (features: string[] = ["harness", "messaging", "nodes"]) => ({ t: "welcome", v: 1, machineID: "m1", publicURL: "https://hub.example.com", features })
const hello = () => ({
  instanceID: "i1",
  nodeVersion: "0.6.1",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/w"],
  draining: false,
  launches: [],
})

let connections: NodeConnection[] = []
afterEach(() => {
  for (const c of connections) c.stop()
  connections = []
})

function setup(overrides: Partial<NodeConnectionOptions> = {}) {
  const sockets: FakeSocket[] = []
  const states: string[] = []
  const handled: NodeRequest[] = []
  const conn = new NodeConnection({
    server: "https://hub.example.com/",
    token: "mt_secret",
    hello,
    handle: async (req) => {
      handled.push(req)
      if (req.op === "cancel") throw new Error("nothing to cancel")
      return { cancelled: false }
    },
    onState: (s) => states.push(s),
    backoff: { minMs: 5, maxMs: 20, random: () => 1 },
    unsupportedRetryMs: 300,
    socket: (url, headers) => {
      const s = new FakeSocket(url, headers)
      sockets.push(s)
      return s
    },
    ...overrides,
  })
  connections.push(conn)
  return { conn, sockets, states, handled }
}

describe("NodeConnection", () => {
  test("connects to /spoke/ws with the machine token and sends a node hello", async () => {
    const { conn, sockets } = setup()
    conn.start()
    expect(sockets.length).toBe(1)
    expect(sockets[0]!.url).toBe("wss://hub.example.com/spoke/ws")
    expect(sockets[0]!.headers).toEqual({ Authorization: "Bearer mt_secret" })
    sockets[0]!.open()
    expect(sockets[0]!.sent[0]).toEqual({ t: "hello", v: PROTOCOL_VERSION, role: "node", ...hello() })
  })

  test("a welcome announcing nodes connects", async () => {
    const { conn, sockets, states } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive(welcome())
    expect(conn.state).toBe("connected")
    expect(conn.machineID).toBe("m1")
    expect(states).toContain("connected")
  })

  test("a welcome without nodes is an old hub: disconnect and retry only after the long backoff", async () => {
    const { conn, sockets } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive(welcome(["harness", "messaging"]))
    expect(conn.state).toBe("unsupported")
    expect(sockets[0]!.closed).toBeDefined()
    await sleep(80)
    expect(sockets.length).toBe(1)
    await until(() => sockets.length === 2)
  })

  test("a bye before the welcome (an old hub rejecting the node hello) also waits the long backoff", async () => {
    const { conn, sockets } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive({ t: "bye", reason: "protocol error" })
    sockets[0]!.drop(4000, "protocol error")
    expect(conn.state).toBe("unsupported")
    await sleep(80)
    expect(sockets.length).toBe(1)
  })

  test("a failed connection retries with the short backoff, and again after a drop", async () => {
    const { conn, sockets } = setup()
    conn.start()
    sockets[0]!.drop()
    expect(conn.state).toBe("error")
    await until(() => sockets.length === 2)
    sockets[1]!.open()
    sockets[1]!.receive(welcome())
    sockets[1]!.drop(1006, "gone")
    await until(() => sockets.length === 3)
  })

  test("a revoked machine stops for good", async () => {
    const { conn, sockets } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive(welcome())
    sockets[0]!.receive({ t: "bye", reason: "revoked" })
    sockets[0]!.drop(4001, "revoked")
    expect(conn.state).toBe("revoked")
    await sleep(60)
    expect(sockets.length).toBe(1)
  })

  test("stop closes and never reconnects", async () => {
    const { conn, sockets } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive(welcome())
    conn.stop()
    expect(conn.state).toBe("off")
    expect(sockets[0]!.closed).toBeDefined()
    await sleep(60)
    expect(sockets.length).toBe(1)
  })

  test("answers the hub's requests: result, error, and invalid request", async () => {
    const { conn, sockets, handled } = setup()
    conn.start()
    const s = sockets[0]!
    s.open()
    s.receive(welcome())
    s.receive({ t: "req", id: "h1", req: { op: "cancel", launchID: "l1" } })
    s.receive({ t: "req", id: "h2", req: { op: "collect", launchID: "l1", workspace: { repo: "/w/r", directory: "/w/r", mode: "clone", reused: false } } })
    s.receive({ t: "req", id: "h3", req: { op: "exec", cmd: "rm -rf /" } })
    await until(() => s.sent.length >= 4)
    expect(handled.map((r) => r.op)).toEqual(["cancel", "collect"])
    expect(s.sent.slice(1)).toContainEqual({ t: "res", id: "h1", ok: false, error: "nothing to cancel" })
    expect(s.sent.slice(1)).toContainEqual({ t: "res", id: "h2", ok: true, result: { cancelled: false } })
    expect(s.sent.slice(1)).toContainEqual({ t: "res", id: "h3", ok: false, error: "invalid request" })
  })

  test("requests before the welcome are ignored", async () => {
    const { conn, sockets, handled } = setup()
    conn.start()
    sockets[0]!.open()
    sockets[0]!.receive({ t: "req", id: "h1", req: { op: "cancel", launchID: "l1" } })
    await sleep(20)
    expect(handled).toEqual([])
  })

  test("send delivers capacity and progress frames only while connected", () => {
    const { conn, sockets } = setup()
    conn.start()
    const frame = { t: "progress", launchID: "l1", phase: "preparing", message: "cloning" } as const
    expect(conn.send(frame)).toBe(false)
    sockets[0]!.open()
    sockets[0]!.receive(welcome())
    expect(conn.send(frame)).toBe(true)
    expect(sockets[0]!.sent.at(-1)).toEqual(frame)
  })

  test("the default socket sends the Authorization header to a real hub endpoint", async () => {
    let auth: string | null = null
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        auth = req.headers.get("authorization")
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 })
      },
      websocket: {
        message(ws, msg) {
          if (JSON.parse(String(msg)).role === "node") ws.send(JSON.stringify(welcome()))
        },
      },
    })
    try {
      const conn = new NodeConnection({ server: `http://127.0.0.1:${server.port}`, token: "mt_real", hello, handle: async () => ({}) })
      connections.push(conn)
      conn.start()
      await until(() => conn.state === "connected")
      expect(String(auth)).toBe("Bearer mt_real")
    } finally {
      server.stop(true)
    }
  })
})
