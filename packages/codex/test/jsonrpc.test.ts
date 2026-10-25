// JsonRpcPeer: Codex app-server's JSON-RPC (no "jsonrpc" member, as the app-server speaks it) over any channel of
// text messages: requests correlated by id, server notifications and server requests dispatched, responses to
// server requests, and every pending request failed when the channel closes.
import { describe, expect, test } from "bun:test"
import { JsonRpcPeer, RpcError, memoryChannelPair } from "../src/jsonrpc.ts"

function setup(handlers: ConstructorParameters<typeof JsonRpcPeer>[1] = {}) {
  const [a, b] = memoryChannelPair()
  const sent: any[] = []
  b.onMessage((text) => sent.push(JSON.parse(text)))
  const peer = new JsonRpcPeer(a, handlers)
  const reply = (message: unknown) => b.send(JSON.stringify(message))
  return { peer, sent, reply, server: b }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("JsonRpcPeer", () => {
  test("a request resolves with the result of the response with its id", async () => {
    const { peer, sent, reply } = setup()
    const p = peer.request("thread/start", { cwd: "/w" })
    await tick()
    expect(sent).toEqual([{ id: 1, method: "thread/start", params: { cwd: "/w" } }])
    reply({ id: 1, result: { thread: { id: "t1" } } })
    expect(await p).toEqual({ thread: { id: "t1" } })
  })

  test("an error response rejects with an RpcError carrying code and message", async () => {
    const { peer, reply } = setup()
    const p = peer.request("turn/steer", {})
    reply({ id: 1, error: { code: -32600, message: "no active turn to steer" } })
    const error = await p.catch((e) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error.code).toBe(-32600)
    expect(error.message).toContain("no active turn to steer")
  })

  test("notifications and server requests reach their handlers; respond answers a server request", async () => {
    const notes: unknown[] = []
    const requests: unknown[] = []
    const { peer, sent, reply } = setup({ onNotification: (m, p) => notes.push([m, p]), onRequest: (id, m, p) => requests.push([id, m, p]) })
    reply({ method: "turn/started", params: { threadId: "t1" } })
    reply({ id: 0, method: "item/commandExecution/requestApproval", params: { itemId: "c1" } })
    expect(notes).toEqual([["turn/started", { threadId: "t1" }]])
    expect(requests).toEqual([[0, "item/commandExecution/requestApproval", { itemId: "c1" }]])
    peer.respond(0, { decision: "accept" })
    peer.notify("initialized")
    await tick()
    expect(sent).toEqual([{ id: 0, result: { decision: "accept" } }, { method: "initialized" }])
  })

  test("lines that are not JSON objects are ignored", () => {
    const notes: unknown[] = []
    const { reply, server } = setup({ onNotification: (m) => notes.push(m) })
    server.send("not json")
    server.send("[1,2]")
    reply({ method: "ok" })
    expect(notes).toEqual(["ok"])
  })

  test("a request times out", async () => {
    const { peer } = setup()
    const error = await peer.request("slow", {}, { timeoutMs: 10 }).catch((e) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error.message).toMatch(/slow.*did not answer/)
  })

  test("closing the channel rejects pending requests, refuses new ones and resolves closed", async () => {
    const { peer, server } = setup()
    const p = peer.request("thread/start", {})
    server.close()
    expect((await p.catch((e) => e)).message).toMatch(/closed/)
    expect((await peer.request("x", {}).catch((e) => e)).message).toMatch(/closed/)
    expect(await peer.closed).toBeDefined()
    expect(peer.isClosed).toBe(true)
  })
})
