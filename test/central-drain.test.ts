// Draining (design §10, decision vkxkqiuf §8), single process: central.drain() fails /readyz, refuses new /spoke/ws
// upgrades, says bye{reason:"draining", retryAfterMs} to spokes and nodes, ends SSE streams with a `retry:` hint and
// waits (bounded) for requests in flight, answering offline for the rest; stop() follows.
import { afterEach, describe, expect, test } from "bun:test"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"
import { connect, harness, session, spoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const nodeHello: NodeHello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: {},
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launches: [],
}

/** Answers every request on the socket with reply(req) (a res body; undefined: not now). */
function serve(client: FakeSpoke, reply: (req: any, id: string) => Record<string, unknown> | undefined): any[] {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push({ ...frame.req, id: frame.id })
    const body = reply(frame.req, frame.id)
    if (body) client.send({ t: "res", id: frame.id, ...body } as any)
  })
  return seen
}

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error)

describe("drain (single process)", () => {
  test("/readyz answers 200, then 503 once draining", async () => {
    h = await harness()
    const ready = await fetch(`${h.url}/readyz`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toMatchObject({ ok: true })
    const draining = h.drain({ timeoutMs: 1000 })
    const refused = await fetch(`${h.url}/readyz`)
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ ok: false, draining: true })
    // Liveness stays up while draining.
    expect((await fetch(`${h.url}/healthz`)).status).toBe(200)
    await draining
  })

  test("spokes and nodes get bye{reason:'draining', retryAfterMs} and new /spoke/ws upgrades are refused", async () => {
    h = await harness()
    const client = await spoke(h, { sessions: [session("ses_1")] })
    const { token } = await h.store.addMachine("box")
    const node = await connect(h, token)
    node.send({ ...nodeHello })
    await node.next((f) => f.t === "welcome")
    await h.drain({ timeoutMs: 1000, retryAfterMs: 3000 })
    expect(await client.next((f) => f.t === "bye")).toEqual({ t: "bye", reason: "draining", retryAfterMs: 3000 })
    expect(await node.next((f) => f.t === "bye")).toEqual({ t: "bye", reason: "draining", retryAfterMs: 3000 })
    expect((await client.closed).code).toBe(4006)
    await node.closed
    const upgrade = await fetch(`${h.url}/spoke/ws`, { headers: { authorization: `Bearer ${client.token}`, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })
    expect(upgrade.status).toBe(503)
    expect(upgrade.headers.get("retry-after")).toBe("3")
    expect(await upgrade.json()).toMatchObject({ code: "draining" })
  })

  test("a request in flight finishes before its spoke gets the bye; new requests are refused as offline", async () => {
    h = await harness()
    const { client, connID } = await spokeWithConn(h)
    const pending: string[] = []
    serve(client, (_req, id) => void pending.push(id))
    const inFlight = h.spokes.request(connID, { op: "summary", sessionID: "ses_1" })
    await waitFor(() => pending.length === 1)
    let drained = false
    const draining = h.drain({ timeoutMs: 5000 }).then(() => (drained = true))
    await Bun.sleep(50)
    // Still connected: the bye waits for the answer.
    expect(client.frames.some((f) => f.t === "bye")).toBe(false)
    expect(drained).toBe(false)
    expect(await errorOf(h.spokes.request(connID, { op: "summary", sessionID: "ses_1" }))).toMatchObject({ name: "SpokeError" })
    client.send({ t: "res", id: pending[0]!, ok: true, result: { summary: "done" } } as any)
    expect(await inFlight).toEqual({ summary: "done" } as any)
    await draining
    expect(await client.next((f) => f.t === "bye")).toMatchObject({ reason: "draining" })
  })

  test("requests still unanswered at the drain deadline fail as offline", async () => {
    h = await harness()
    const { client, connID } = await spokeWithConn(h)
    serve(client, () => undefined)
    const inFlight = errorOf(h.spokes.request(connID, { op: "summary", sessionID: "ses_1" }))
    const started = Date.now()
    await h.drain({ timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await inFlight).toMatchObject({ name: "SpokeError", message: "OpenCode process disconnected" })
    expect(await client.next((f) => f.t === "bye")).toMatchObject({ reason: "draining" })
  })

  test("SSE streams end with a retry: hint, and a new stream while draining gets the hint at once", async () => {
    h = await harness()
    const response = await h.api("/api/events")
    const text = readAll(response)
    await Bun.sleep(50)
    await h.drain({ timeoutMs: 1000 })
    const body = await text
    expect(body).toContain("retry: 2000\n\n")
    const late = await h.api("/api/events")
    expect(late.status).toBe(200)
    expect(await late.text()).toBe("retry: 2000\n\n")
  })

  test("agent watch streams end with the retry: hint too, and a new one while draining gets it at once", async () => {
    h = await harness()
    const response = await h.api("/api/agent/watch")
    expect(response.status).toBe(200)
    const text = readAll(response)
    await Bun.sleep(50)
    await h.drain({ timeoutMs: 1000 })
    const body = await text
    expect(body).toContain('"type":"ready"')
    expect(body.endsWith("retry: 2000\n\n")).toBe(true)
    expect(await (await h.api("/api/agent/watch")).text()).toBe("retry: 2000\n\n")
  })

  test("drain is idempotent and stop() after it is quick", async () => {
    h = await harness()
    await spoke(h, { sessions: [session("ses_1")] })
    await Promise.all([h.drain({ timeoutMs: 1000 }), h.drain({ timeoutMs: 1000 })])
    const started = Date.now()
    await h.stop()
    h = undefined
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

/** A spoke reporting ses_1, and its connection ID. */
async function spokeWithConn(central: Harness) {
  const { machine, token } = await central.store.addMachine("laptop")
  const client = await spoke(central, { machine: { token }, sessions: [session("ses_1")] })
  return { client, connID: central.registry.connectionsFor(machine.id)[0]! }
}

/** The whole body of a streamed response (until the server ends it). */
async function readAll(response: Response): Promise<string> {
  return await response.text()
}

