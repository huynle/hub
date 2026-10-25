import { afterEach, describe, expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "../../protocol/src/index.ts"
import { connectSpoke, fakeHub, fakeSpoke, helloFrame, sessionInfo, until, type FakeHub } from "../src/index.ts"

let hubs: FakeHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop()
})
const start = (options?: Parameters<typeof fakeHub>[0]) => {
  const h = fakeHub(options)
  hubs.push(h)
  return h
}

describe("frame builders", () => {
  test("helloFrame is an OpenCode v1 hello by default, with overrides", () => {
    expect(helloFrame("p1")).toEqual({
      t: "hello",
      v: PROTOCOL_VERSION,
      processID: "p1",
      kind: "standalone",
      directory: "/work",
      pid: 1,
      mode: "always",
      opencodeVersion: "2.0.0",
      pluginVersion: "0.0.1",
    })
    expect(helloFrame("p2", { harness: "claude-code", evidence: "hooks" })).toMatchObject({ processID: "p2", harness: "claude-code", evidence: "hooks" })
  })

  test("sessionInfo fills a title and directory", () => {
    expect(sessionInfo("ses_1")).toEqual({ id: "ses_1", title: "title ses_1", directory: "/work", updated: 1, owned: false })
    expect(sessionInfo("ses_2", { owned: true })).toMatchObject({ id: "ses_2", owned: true })
  })
})

describe("connectSpoke", () => {
  test("opens /spoke/ws with the bearer token and does not send hello", async () => {
    const hub = start()
    const spoke = await connectSpoke(hub.url, "tok")
    await until(() => hub.sockets.length === 1)
    expect(hub.auth).toEqual(["Bearer tok"])
    expect(hub.frames).toEqual([])
    spoke.close()
    expect(await spoke.closed).toMatchObject({ code: expect.any(Number) })
  })

  test("accepts ws:// and https-style bases", async () => {
    const hub = start()
    const spoke = await connectSpoke(hub.url.replace("http", "ws"))
    await until(() => hub.sockets.length === 1)
    expect(hub.auth).toEqual([null])
    spoke.close()
  })

  test("next() returns frames in order, filtered, each once; times out", async () => {
    const hub = start()
    const spoke = await connectSpoke(hub.url)
    await until(() => hub.sockets.length === 1)
    hub.send(JSON.stringify({ t: "req", id: "a", req: { op: "abort", sessionID: "s" } }))
    hub.send(JSON.stringify({ t: "req", id: "b", req: { op: "abort", sessionID: "s" } }))
    expect((await spoke.next()).id).toBe("a")
    expect((await spoke.next((f) => f.id === "b")).id).toBe("b")
    await expect(spoke.next(() => true, 30)).rejects.toThrow("timed out waiting for frame")
    expect(spoke.frames.length).toBe(2)
  })

  test("next() fails fast once the socket is closed", async () => {
    const hub = start()
    const spoke = await connectSpoke(hub.url)
    await until(() => hub.sockets.length === 1)
    hub.sockets[0]!.close(4001, "revoked")
    expect(await spoke.closed).toEqual({ code: 4001, reason: "revoked" })
    await expect(spoke.next()).rejects.toThrow("socket closed")
  })

  test("respond() answers a server request", async () => {
    const hub = start()
    const spoke = await connectSpoke(hub.url)
    await until(() => hub.sockets.length === 1)
    const pending = hub.request({ op: "abort", sessionID: "s" })
    const req = await spoke.next((f) => f.t === "req")
    spoke.respond(req.id, { ok: 1 })
    expect(await pending).toEqual({ t: "res", id: req.id, ok: true, result: { ok: 1 } })
    const failing = hub.request({ op: "abort", sessionID: "s" })
    const req2 = await spoke.next((f) => f.t === "req")
    spoke.fail(req2.id, "unsupported")
    expect(await failing).toEqual({ t: "res", id: req2.id, ok: false, error: "unsupported" })
  })

  test("refuses to open when nothing listens", async () => {
    await expect(connectSpoke("http://127.0.0.1:1")).rejects.toThrow("websocket error")
  })
})

describe("fakeSpoke", () => {
  test("connects, says hello, waits for welcome and reports sessions", async () => {
    const hub = start({ hubFeatures: ["harness"] })
    const spoke = await fakeSpoke(hub.url, { token: "t", processID: "px", hello: { harness: "codex", evidence: "rpc" }, sessions: [sessionInfo("ses_a")] })
    expect(spoke.welcome).toMatchObject({ t: "welcome", features: ["harness"] })
    await hub.next((f) => f.t === "sessions")
    expect(hub.frames.map((f) => f.t)).toEqual(["hello", "sessions"])
    expect(hub.frames[0]).toMatchObject({ processID: "px", harness: "codex" })
    expect(hub.frames[1]).toEqual({ t: "sessions", sessions: [sessionInfo("ses_a")] })
    spoke.close()
  })
})
