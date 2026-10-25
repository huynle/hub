// Launch-bound spoke connections on /spoke/ws (phase 5, decision lk6gn3u7 #5/#6): a harness inside a sandbox
// connects with an hlt1 launch token instead of the machine token. The hub accepts it only while the launch is
// provisioning or running, only with a hello naming that launch, one connection per launch (a reconnect replaces
// the old one), closes it when the launch ends or the token expires, never treats it as a node or the machine's
// service, and gives it no pairing or login codes. Loopback is never trusted: the sandbox reaches a loopback hub
// through the host, so every such connection still needs a valid token.
// SpokeHub runs on its own Bun server with a real Store, TokenKeys, Registry and LaunchTokens; launches are a map.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Server } from "bun"
import { LaunchTokens, type LaunchView } from "../src/central/agent/launch-tokens"
import { Auth } from "../src/central/auth"
import { NodeRegistry } from "../src/central/nodes"
import { Registry } from "../src/central/registry"
import { SpokeHub, type SpokeSocketData } from "../src/central/spoke-ws"
import { Store } from "../src/central/store"
import { TokenKeys } from "../src/central/token-keys"
import { NODE_ROLE, PROTOCOL_VERSION } from "../src/protocol"
import { connect, hello, waitFor, type FakeSpoke } from "./central-harness"

const PUBLIC = "http://hub.test"

let store: Store
let keys: TokenKeys
let registry: Registry
let nodes: NodeRegistry
let hub: SpokeHub
let server: Server<SpokeSocketData>
let url: string
let machineID: string
let machineToken: string
let launches: Map<string, LaunchView>
let lifetimeMs: number | undefined
let tokens: LaunchTokens
const clients: FakeSpoke[] = []

const ownerOf = (id: string) => store.machines().find((m) => m.id === id)?.ownerID

function start(): void {
  tokens = new LaunchTokens({
    keys,
    store,
    launches: { launch: (userID, launchID) => launches.get(`${userID}/${launchID}`) },
    publicURL: PUBLIC,
    ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
  })
  hub = new SpokeHub({
    store,
    auth: new Auth({ store, publicURL: PUBLIC }),
    registry,
    nodes,
    publicURL: PUBLIC,
    notifier: { notify: async () => 0 },
    broadcast: () => {},
    turnTimeoutMs: 1000,
    launchTokens: tokens,
  })
  server = Bun.serve<SpokeSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, srv) => hub.upgrade(request, srv),
    websocket: hub.websocket,
  })
  url = `http://127.0.0.1:${server.port}`
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-spoke-launch-"))
  store = Store.open(dir)
  keys = TokenKeys.open(dir, { env: {} })
  registry = new Registry(Date.now, undefined, ownerOf)
  nodes = new NodeRegistry(ownerOf)
  const added = store.addMachine("laptop")
  machineID = added.machine.id
  machineToken = added.token
  launches = new Map([[`local/lch_1`, { state: "provisioning", machineID }]])
  lifetimeMs = undefined
})

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
  hub?.stop()
  server?.stop(true)
})

const mint = async (launchID = "lch_1") => (await tokens.mint(machineID, launchID))!.token

async function open(token: string | undefined): Promise<FakeSpoke> {
  const client = await connect({ url } as never, token)
  clients.push(client)
  return client
}

/** A launch-bound spoke that said hello for `launchID` (the token's launch unless given). */
async function boxed(options: { token?: string; launchID?: string | null; processID?: string } = {}) {
  const client = await open(options.token ?? (await mint()))
  const launchID = options.launchID === undefined ? "lch_1" : options.launchID
  client.send(hello(options.processID ?? "box1", { kind: "service", features: ["launch"], ...(launchID !== null ? { launchID } : {}) }))
  const first = await client.next((f) => f.t === "welcome" || f.t === "bye")
  return Object.assign(client, { first })
}

const status = async (token?: string) =>
  (await fetch(`${url}/spoke/ws`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status

describe("accepting launch tokens", () => {
  test("a valid token and a hello naming its launch: welcome, bound to the launch, never the machine's service", async () => {
    start()
    const client = await boxed()
    expect(client.first).toMatchObject({ t: "welcome", v: PROTOCOL_VERSION, machineID, publicURL: PUBLIC })
    await waitFor(() => registry.launchConn("lch_1") !== undefined)
    const connID = registry.launchConn("lch_1")!
    expect(registry.launchOf(connID)).toBe("lch_1")
    expect(registry.connMachine(connID)).toBe(machineID)
    expect(registry.serviceFor(machineID)).toBeUndefined()
  })

  test("also while the launch is running", async () => {
    launches.set("local/lch_1", { state: "running", machineID })
    start()
    expect((await boxed()).first.t).toBe("welcome")
  })

  test("a hello without the launch's ID, or with another launch's, is turned away", async () => {
    start()
    for (const launchID of [null, "lch_2"]) {
      const client = await boxed({ launchID })
      expect(client.first).toMatchObject({ t: "bye", reason: expect.stringContaining("launch") })
      await client.closed
    }
    expect(registry.connections()).toBe(0)
  })

  test("a launch token cannot say hello as a node", async () => {
    start()
    const client = await open(await mint())
    client.send({ t: "hello", v: PROTOCOL_VERSION, role: NODE_ROLE, instanceID: "i", nodeVersion: "1", runtimes: [], labels: {}, capacity: { slots: 1 }, used: { slots: 0 }, workspaceRoots: [], draining: false, launches: [] })
    expect((await client.next((f) => f.t === "bye")).reason).toBe("protocol error")
    await client.closed
    expect(nodes.count()).toBe(0)
    expect(registry.connections()).toBe(0)
  })

  test("a machine-token spoke whose hello names a launch is an ordinary connection", async () => {
    start()
    const client = await open(machineToken)
    client.send(hello("p1", { kind: "service", launchID: "lch_1" }))
    expect((await client.next((f) => f.t === "welcome")).t).toBe("welcome")
    await waitFor(() => registry.connections() === 1)
    expect(registry.launchConn("lch_1")).toBeUndefined()
    expect(registry.serviceFor(machineID)).toBeDefined()
  })
})

describe("refusing launch tokens (loopback is never trusted)", () => {
  test("from loopback: no token, a malformed or forged hlt1 token are 401", async () => {
    start()
    const good = await mint()
    expect(await status()).toBe(401)
    expect(await status("hlt1.x.y")).toBe(401)
    expect(await status(`${good.slice(0, -2)}AA`)).toBe(401)
    // The genuine one passes authentication (426: not a WebSocket upgrade).
    expect(await status(good)).toBe(426)
  })

  test("401 for a launch that ended, is placed elsewhere, or belongs to a revoked machine", async () => {
    start()
    const token = await mint()
    launches.set("local/lch_1", { state: "ended", machineID })
    expect(await status(token)).toBe(401)
    launches.set("local/lch_1", { state: "running", machineID: "mch_other" })
    expect(await status(token)).toBe(401)
    launches.set("local/lch_1", { state: "running", machineID })
    expect(await status(token)).toBe(426)
    store.revokeMachine(machineID)
    expect(await status(token)).toBe(401)
  })

  test("401 for an expired token", async () => {
    lifetimeMs = 30
    start()
    const token = await mint()
    await Bun.sleep(60)
    expect(await status(token)).toBe(401)
  })
})

describe("one connection per launch, closed when the launch ends", () => {
  test("a second connection for the launch replaces the first", async () => {
    start()
    const first = await boxed({ processID: "box1" })
    const second = await boxed({ processID: "box2" })
    expect(second.first.t).toBe("welcome")
    expect((await first.next((f) => f.t === "bye")).reason).toContain("replaced")
    await first.closed
    await waitFor(() => registry.connections() === 1)
    expect(registry.catalog()[0]!.processes.map((p) => p.id)).toEqual(["box2"])
  })

  test("closeLaunch closes the launch's connection and only it", async () => {
    launches.set("local/lch_2", { state: "running", machineID })
    start()
    const one = await boxed()
    const two = await boxed({ token: await mint("lch_2"), launchID: "lch_2", processID: "box2" })
    expect(two.first.t).toBe("welcome")
    hub.closeLaunch("lch_1", "launch ended")
    expect((await one.next((f) => f.t === "bye")).reason).toBe("launch ended")
    await one.closed
    await waitFor(() => registry.connections() === 1)
    expect(registry.launchConn("lch_2")).toBeDefined()
    expect(two.ws.readyState).toBe(WebSocket.OPEN)
  })

  test("the connection is closed when its token expires", async () => {
    lifetimeMs = 400
    start()
    const client = await boxed()
    expect(client.first.t).toBe("welcome")
    const closed = await client.closed
    expect(closed.reason).toContain("expired")
    await waitFor(() => registry.connections() === 0)
  })
})

describe("spoke requests from a launch-bound connection", () => {
  test("no pairing or login codes", async () => {
    start()
    const client = await boxed()
    client.send({ t: "req", id: "r1", req: { op: "pairCode" } })
    client.send({ t: "req", id: "r2", req: { op: "openLink" } })
    const r1 = await client.next((f) => f.t === "res" && f.id === "r1")
    const r2 = await client.next((f) => f.t === "res" && f.id === "r2")
    expect(r1).toMatchObject({ ok: false })
    expect(r2).toMatchObject({ ok: false })
  })
})
