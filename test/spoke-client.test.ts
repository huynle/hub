import { stopServer } from "./spoke-fake"
import { afterEach, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { encode, parseSpokeMessage, PROTOCOL_VERSION, type ServerMessage, type SpokeMessage } from "../src/protocol"
import { backoffDelay, SpokeConnection, type ConnectionOptions } from "../src/spoke/client"

// ---------- fake central server ----------

interface Fake {
  url: string
  frames: SpokeMessage[]
  raw: string[]
  auth: Array<string | null>
  sockets: Array<ServerWebSocket<unknown>>
  send(message: ServerMessage | string, index?: number): void
  stop(): void
}

const fakes: Fake[] = []
const conns: SpokeConnection[] = []
afterEach(() => {
  for (const c of conns.splice(0)) c.stop()
  for (const f of fakes.splice(0)) f.stop()
})

function fakeServer(options: { welcome?: boolean; reject?: boolean; onFrame?: (m: SpokeMessage, ws: ServerWebSocket<unknown>) => void } = {}): Fake {
  const fake: Fake = {
    url: "",
    frames: [],
    raw: [],
    auth: [],
    sockets: [],
    send(message, index) {
      const ws = fake.sockets[index ?? fake.sockets.length - 1]
      ws?.send(typeof message === "string" ? message : encode(message))
    },
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      fake.auth.push(req.headers.get("authorization"))
      if (options.reject) return new Response("unauthorized", { status: 401 })
      if (new URL(req.url).pathname !== "/spoke/ws") return new Response("not found", { status: 404 })
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws) {
        fake.sockets.push(ws)
      },
      message(ws, data) {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
        fake.raw.push(text)
        const m = parseSpokeMessage(text)
        if (!m) return
        fake.frames.push(m)
        if (m.t === "hello" && options.welcome !== false) {
          ws.send(encode({ t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://voice.example" }))
        }
        options.onFrame?.(m, ws)
      },
    },
  })
  fake.url = `http://127.0.0.1:${server.port}`
  fake.stop = () => stopServer(server)
  fakes.push(fake)
  return fake
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

const HELLO = {
  processID: "proc_1",
  kind: "standalone" as const,
  directory: "/work",
  pid: 123,
  mode: "always" as const,
  opencodeVersion: "2.0.25",
  pluginVersion: "0.0.1",
}

function connect(server: string, overrides: Partial<ConnectionOptions> = {}) {
  const conn = new SpokeConnection({
    server,
    token: "tok_secret",
    hello: () => HELLO,
    handle: async () => ({}),
    backoff: { minMs: 10, maxMs: 40 },
    ...overrides,
  })
  conns.push(conn)
  conn.start()
  return conn
}

// ---------- tests ----------

describe("backoffDelay", () => {
  test("doubles from min to max with jitter in [50%, 100%]", () => {
    const opts = { minMs: 1000, maxMs: 60_000 }
    expect(backoffDelay(0, { ...opts, random: () => 1 })).toBe(1000)
    expect(backoffDelay(3, { ...opts, random: () => 1 })).toBe(8000)
    expect(backoffDelay(20, { ...opts, random: () => 1 })).toBe(60_000)
    expect(backoffDelay(0, { ...opts, random: () => 0 })).toBe(500)
  })
})

describe("SpokeConnection", () => {
  test("sends hello with the bearer token and becomes connected on welcome", async () => {
    const fake = fakeServer()
    const states: string[] = []
    let welcomed = 0
    const conn = connect(fake.url, { onState: (s) => states.push(s), onWelcome: () => welcomed++ })
    await until(() => conn.state === "connected")
    expect(fake.auth).toEqual(["Bearer tok_secret"])
    expect(fake.frames[0]).toEqual({ t: "hello", v: PROTOCOL_VERSION, ...HELLO })
    expect(conn.publicURL).toBe("https://voice.example")
    expect(conn.machineID).toBe("m_1")
    expect(welcomed).toBe(1)
    expect(states).toEqual(["connecting", "connected"])
  })

  test("remembers the features the hub's welcome lists; an old hub's welcome lists none", async () => {
    const fake = fakeServer({ welcome: false })
    const conn = connect(fake.url)
    await until(() => fake.frames.length === 1)
    expect(conn.hubSupports("harness")).toBe(false)
    fake.send({ t: "welcome", v: 1, machineID: "m", publicURL: "https://x", features: ["harness", "future"] })
    await until(() => conn.state === "connected")
    expect(conn.hubSupports("harness")).toBe(true)
    expect(conn.hubSupports("future")).toBe(true)
    expect(conn.hubSupports("other")).toBe(false)
    // Reconnected to an older hub: its features are forgotten as soon as the socket closes.
    fake.sockets[0]!.close(1001, "restart")
    await until(() => conn.state !== "connected")
    expect(conn.hubSupports("harness")).toBe(false)
    await until(() => fake.frames.filter((f) => f.t === "hello").length === 2)
    fake.send({ t: "welcome", v: 1, machineID: "m", publicURL: "https://x" })
    await until(() => conn.state === "connected")
    expect(conn.hubSupports("harness")).toBe(false)
  })

  test("send() only delivers after welcome", async () => {
    const fake = fakeServer({ welcome: false })
    const conn = connect(fake.url)
    await until(() => fake.frames.length === 1)
    expect(conn.send({ t: "sessions", sessions: [] })).toBe(false)
    fake.send({ t: "welcome", v: 1, machineID: "m", publicURL: "https://x" })
    await until(() => conn.state === "connected")
    expect(conn.send({ t: "sessions", sessions: [] })).toBe(true)
    await until(() => fake.frames.length === 2)
    expect(fake.frames[1]).toEqual({ t: "sessions", sessions: [] })
  })

  test("answers server requests and ignores invalid frames", async () => {
    const fake = fakeServer()
    const seen: unknown[] = []
    const conn = connect(fake.url, {
      handle: async (req) => {
        seen.push(req)
        if (req.op === "context") throw new Error("boom")
        return { outcome: "succeeded", reply: "hi" }
      },
    })
    await until(() => conn.state === "connected")
    fake.send("not json")
    fake.send(JSON.stringify({ t: "req", id: "r0", req: { op: "rm -rf" } }))
    fake.send({ t: "req", id: "r1", req: { op: "turn", sessionID: "ses_a", text: "hello", voiceStyle: true } })
    fake.send({ t: "req", id: "r2", req: { op: "context", sessionID: "ses_a" } })
    await until(() => fake.frames.filter((f) => f.t === "res").length === 2)
    expect(seen).toEqual([
      { op: "turn", sessionID: "ses_a", text: "hello", voiceStyle: true },
      { op: "context", sessionID: "ses_a" },
    ])
    const res = fake.frames.filter((f) => f.t === "res")
    expect(res).toContainEqual({ t: "res", id: "r1", ok: true, result: { outcome: "succeeded", reply: "hi" } })
    expect(res).toContainEqual({ t: "res", id: "r2", ok: false, error: "boom" })
    expect(conn.state).toBe("connected")
  })

  test("a result too large for one frame is answered with an error instead of breaking the connection", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url, { handle: async () => ({ patch: '"'.repeat(600_000) }) })
    await until(() => conn.state === "connected")
    fake.send({ t: "req", id: "big", req: { op: "context", sessionID: "ses_a" } })
    await until(() => fake.frames.some((f) => f.t === "res"))
    const res = fake.frames.find((f) => f.t === "res")
    expect(res).toMatchObject({ t: "res", id: "big", ok: false })
    expect((res as { error?: string }).error).toContain("Result too large")
    expect(fake.raw.every((text) => text.length <= 1_000_000)).toBe(true)
    expect(conn.state).toBe("connected")
  })

  test("request() resolves with the server's result and rejects on errors", async () => {
    const fake = fakeServer({
      onFrame: (m, ws) => {
        if (m.t !== "req") return
        if (m.req.op === "pairCode") ws.send(encode({ t: "res", id: m.id, ok: true, result: { code: "123456", url: "https://v/p", expiresAt: 1 } }))
        if (m.req.op === "handoff") ws.send(encode({ t: "res", id: m.id, ok: false, error: "no devices" }))
      },
    })
    const conn = connect(fake.url)
    await until(() => conn.state === "connected")
    expect(await conn.request({ op: "pairCode" })).toEqual({ code: "123456", url: "https://v/p", expiresAt: 1 })
    await expect(conn.request({ op: "handoff", sessionID: "ses_a" })).rejects.toThrow("no devices")
  })

  test("request() rejects when not connected or on timeout", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url, { requestTimeoutMs: 30 })
    await expect(new SpokeConnection({ server: fake.url, token: "t", hello: () => HELLO, handle: async () => ({}) }).request({ op: "pairCode" })).rejects.toThrow(/not connected/i)
    await until(() => conn.state === "connected")
    await expect(conn.request({ op: "openLink", sessionID: "ses_a" })).rejects.toThrow(/timed out/i)
  })

  test("reconnects with backoff after the server drops the socket", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url)
    await until(() => conn.state === "connected")
    fake.sockets[0]!.close(1011, "restart")
    await until(() => fake.frames.filter((f) => f.t === "hello").length === 2)
    await until(() => conn.state === "connected")
  })

  test("keeps retrying an unreachable server and reports the error", async () => {
    const fake = fakeServer({ reject: true })
    const conn = connect(fake.url)
    await until(() => fake.auth.length >= 3)
    expect(["error", "connecting"]).toContain(conn.state)
    expect(conn.lastError).toBeTruthy()
  })

  test("retryNow() reconnects at once instead of waiting out the backoff", async () => {
    const options = { reject: true }
    const fake = fakeServer(options)
    const conn = connect(fake.url, { backoff: { minMs: 60_000, maxMs: 60_000 } })
    await until(() => conn.state === "error")
    options.reject = false
    conn.retryNow()
    await until(() => conn.state === "connected")
    expect(fake.auth).toHaveLength(2)
  })

  test("retryNow() does nothing while connected or after stop()", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url)
    await until(() => conn.state === "connected")
    conn.retryNow()
    await Bun.sleep(50)
    expect(fake.frames.filter((f) => f.t === "hello")).toHaveLength(1)
    conn.stop()
    conn.retryNow()
    await Bun.sleep(50)
    expect(conn.state).toBe("off")
    expect(fake.frames.filter((f) => f.t === "hello")).toHaveLength(1)
  })

  test("bye revoked stops without reconnecting", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url)
    await until(() => conn.state === "connected")
    fake.send({ t: "bye", reason: "revoked" })
    await until(() => conn.state === "revoked")
    await Bun.sleep(100)
    expect(fake.frames.filter((f) => f.t === "hello")).toHaveLength(1)
  })

  test("stop() closes the socket and does not reconnect", async () => {
    const fake = fakeServer()
    const conn = connect(fake.url)
    await until(() => conn.state === "connected")
    conn.stop()
    expect(conn.state).toBe("off")
    await Bun.sleep(100)
    expect(fake.frames.filter((f) => f.t === "hello")).toHaveLength(1)
  })
})
