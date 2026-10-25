import { afterEach, describe, expect, test } from "bun:test"
import { HUB_FEATURES, MAX_FRAME } from "../../protocol/src/index.ts"
import { recordingHub, type RecordingHub } from "../src/hub.ts"

const hubs: RecordingHub[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  for (const h of hubs.splice(0)) await h.stop()
})

const hello = { t: "hello", v: 1, processID: "p1", kind: "service", directory: "/w", pid: 1, mode: "always", pluginVersion: "1", harness: "fake", harnessVersion: "1", evidence: "hooks", features: [] }

async function connect(hub: RecordingHub, token = "tok") {
  const received: string[] = []
  const ws = new (WebSocket as any)(hub.url.replace(/^http/, "ws") + "/spoke/ws", { headers: { Authorization: `Bearer ${token}` } }) as WebSocket
  sockets.push(ws)
  ws.onmessage = (ev) => received.push(String(ev.data))
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
  return { ws, received }
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

describe("recording hub", () => {
  test("records every frame raw (size, connection, parsed when valid) and the bearer of each connection", async () => {
    const hub = recordingHub()
    hubs.push(hub)
    const { ws, received } = await connect(hub, "machine")
    ws.send(JSON.stringify(hello))
    ws.send("not json")
    await until(() => hub.frames.length === 2)
    expect(hub.connections).toHaveLength(1)
    expect(hub.connections[0]!.auth).toBe("Bearer machine")
    expect(hub.frames[0]).toMatchObject({ conn: 0, t: "hello", size: JSON.stringify(hello).length })
    expect(hub.frames[0]!.parsed).toBeDefined()
    expect(hub.frames[1]).toMatchObject({ conn: 0, raw: "not json", size: 8 })
    expect(hub.frames[1]!.parsed).toBeUndefined()
    await until(() => received.length > 0)
    expect(JSON.parse(received[0]!)).toMatchObject({ t: "welcome", features: [...HUB_FEATURES] })
  })

  test("request() resolves with the spoke's res, or undefined after the timeout", async () => {
    const hub = recordingHub()
    hubs.push(hub)
    const { ws, received } = await connect(hub)
    ws.send(JSON.stringify(hello))
    await until(() => received.length > 0)
    const pending = hub.request({ op: "interrupt", sessionID: "ses_1" }, 2000)
    await until(() => received.length > 1)
    const req = JSON.parse(received[1]!)
    expect(req).toMatchObject({ t: "req", req: { op: "interrupt", sessionID: "ses_1" } })
    ws.send(JSON.stringify({ t: "res", id: req.id, ok: false, error: "nope" }))
    expect(await pending).toMatchObject({ ok: false, error: "nope" })
    expect(await hub.request({ op: "interrupt", sessionID: "ses_1" }, 50)).toBeUndefined()
  })

  test("waitFor() finds a past or future frame from an index on", async () => {
    const hub = recordingHub()
    hubs.push(hub)
    const { ws } = await connect(hub)
    ws.send(JSON.stringify(hello))
    expect(await hub.waitFor((f) => f.t === "hello", 1000)).toMatchObject({ t: "hello" })
    expect(await hub.waitFor((f) => f.t === "hello", 30, 1)).toBeUndefined()
    setTimeout(() => ws.send(JSON.stringify({ t: "sessions", sessions: [] })), 20)
    expect(await hub.waitFor((f) => f.t === "sessions", 1000, 1)).toMatchObject({ t: "sessions" })
  })

  test("bye() sends a bye with retryAfterMs and closes the connection; sendRaw() sends any text", async () => {
    const hub = recordingHub()
    hubs.push(hub)
    const { ws, received } = await connect(hub)
    ws.send(JSON.stringify(hello))
    await until(() => received.length > 0)
    hub.sendRaw("x".repeat(MAX_FRAME + 1))
    await until(() => received.length > 1)
    expect(received[1]!.length).toBe(MAX_FRAME + 1)
    let closed = false
    ws.onclose = () => (closed = true)
    hub.bye("draining", 250)
    await until(() => closed)
    expect(JSON.parse(received[2]!)).toEqual({ t: "bye", reason: "draining", retryAfterMs: 250 })
    expect(hub.connections[0]!.closedAt).toBeNumber()
  })
})
