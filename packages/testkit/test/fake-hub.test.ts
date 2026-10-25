import { afterEach, describe, expect, test } from "bun:test"
import { encode, PROTOCOL_VERSION, type Hello } from "../../protocol/src/index.ts"
import { EventQueue, fakeHub, freePort, stopServer, until, type FakeHub } from "../src/index.ts"

const hello: Hello = { t: "hello", v: PROTOCOL_VERSION, processID: "p1", kind: "standalone", directory: "/w", pid: 1, mode: "always", opencodeVersion: "2.0.0", pluginVersion: "0" }

let hubs: FakeHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop()
})
const start = (options?: Parameters<typeof fakeHub>[0]) => {
  const h = fakeHub(options)
  hubs.push(h)
  return h
}

/** A raw WebSocket client that collects parsed frames. */
async function client(url: string, token?: string) {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/spoke/ws`, { headers: token ? { authorization: `Bearer ${token}` } : {} } as any)
  const frames: any[] = []
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))))
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })
  return { ws, frames }
}

describe("fakeHub", () => {
  test("serves enrollment: start, then poll replies in order with the last one repeating", async () => {
    const hub = start({ enrollExtra: { intervalMs: 5 } })
    const enroll = await (await fetch(`${hub.url}/spoke/enroll`, { method: "POST", body: "{}" })).json()
    expect(enroll).toMatchObject({ userCode: "ABCD-EFGH", deviceCode: "dev_1", approveURL: `${hub.url}/approve`, intervalMs: 5 })
    hub.pollReplies = [{ status: "pending" }, { status: "approved", token: "tok_1", machineID: "m_1" } as any]
    const poll = async () => (await fetch(`${hub.url}/spoke/enroll/poll`, { method: "POST", body: "{}" })).json()
    expect(await poll()).toEqual({ status: "pending" })
    expect(await poll()).toMatchObject({ status: "approved", token: "tok_1" })
    expect(await poll()).toMatchObject({ status: "approved", token: "tok_1" })
  })

  test("answers other paths with the http option, else 404", async () => {
    const hub = start({ http: (req) => (new URL(req.url).pathname === "/api/x" ? Response.json({ ok: true }) : undefined) })
    expect(await (await fetch(`${hub.url}/api/x`)).json()).toEqual({ ok: true })
    expect((await fetch(`${hub.url}/api/y`)).status).toBe(404)
  })

  test("records auth and frames, welcomes a hello with the hub features, and counts closes", async () => {
    const hub = start({ hubFeatures: ["harness", "messaging"] })
    const c = await client(hub.url, "tok")
    c.ws.send(encode(hello))
    await until(() => c.frames.length > 0)
    expect(c.frames[0]).toEqual({ t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://voice.example", features: ["harness", "messaging"] })
    expect(hub.auth).toEqual(["Bearer tok"])
    expect(hub.frames).toEqual([hello])
    expect(hub.sockets.length).toBe(1)
    c.ws.close()
    await until(() => hub.closed === 1)
  })

  test("a welcome lists no features unless asked (a hub that predates them)", async () => {
    const hub = start()
    const c = await client(hub.url)
    c.ws.send(encode(hello))
    await until(() => c.frames.length > 0)
    expect("features" in c.frames[0]).toBe(false)
    expect(hub.auth).toEqual([null])
  })

  test("ignores unparseable frames and calls onFrame for each parsed one", async () => {
    const seen: string[] = []
    const hub = start({ onFrame: (m) => seen.push(m.t) })
    const c = await client(hub.url)
    c.ws.send("not json")
    c.ws.send(encode(hello))
    await until(() => seen.length === 1)
    expect(hub.frames.length).toBe(1)
  })

  test("request() sends a server req and resolves with the spoke's res", async () => {
    const hub = start()
    const c = await client(hub.url)
    c.ws.send(encode(hello))
    await until(() => c.frames.length === 1)
    const pending = hub.request({ op: "abort", sessionID: "ses_1" })
    await until(() => c.frames.length === 2)
    const req = c.frames[1]
    expect(req).toMatchObject({ t: "req", id: "srv1", req: { op: "abort", sessionID: "ses_1" } })
    c.ws.send(JSON.stringify({ t: "res", id: req.id, ok: true, result: { done: 1 } }))
    expect(await pending).toEqual({ t: "res", id: "srv1", ok: true, result: { done: 1 } } as any)
  })

  test("next() waits for a recorded frame that matches", async () => {
    const hub = start()
    const c = await client(hub.url)
    const waiting = hub.next((f) => f.t === "sessions")
    c.ws.send(encode(hello))
    c.ws.send(encode({ t: "sessions", sessions: [] }))
    expect(await waiting).toEqual({ t: "sessions", sessions: [] })
    await expect(hub.next((f) => f.t === "bye", 30)).rejects.toThrow("timed out")
  })

  test("send() writes to the latest socket; listens on a chosen port", async () => {
    const port = freePort()
    const hub = start({ port })
    expect(hub.url).toBe(`http://127.0.0.1:${port}`)
    const c = await client(hub.url)
    hub.send({ t: "bye", reason: "draining", retryAfterMs: 10 } as any)
    await until(() => c.frames.length === 1)
    expect(c.frames[0]).toMatchObject({ t: "bye", retryAfterMs: 10 })
  })
})

describe("helpers", () => {
  test("stopServer does not hang and until times out", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    await stopServer(server)
    await expect(until(() => false, 20)).rejects.toThrow("timed out")
  })

  test("EventQueue yields pushed items until aborted", async () => {
    const q = new EventQueue<number>()
    const abort = new AbortController()
    const got: number[] = []
    const done = (async () => {
      for await (const n of q.iterate(abort.signal)) got.push(n)
    })()
    q.push(1)
    q.push(2)
    await until(() => got.length === 2)
    abort.abort()
    await done
    expect(got).toEqual([1, 2])
  })
})
