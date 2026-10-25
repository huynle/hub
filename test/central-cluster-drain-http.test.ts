// Draining across pods (design §10, decision vkxkqiuf §8): two startCentral pods on shared backends. /readyz checks
// the database and Valkey and fails while draining; draining pod A says bye{reason:"draining", retryAfterMs} to its
// spoke, which (through a load-balancer stand-in that follows /readyz) reconnects to B within a few seconds; B leads
// the timed jobs afterwards; a request in flight on A finishes first. Shared memoryBackends() by default; with
// HUB_IT_CLUSTER=1 also real Postgres + Valkey.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { memoryBackends, type Backends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyCatalog } from "../src/central/backend/valkey-catalog"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { ValkeyLocks } from "../src/central/backend/valkey-locks"
import { leaderKey } from "../src/central/cluster/leader"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central, type CentralOptions } from "../src/central/http"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello, type ServerRequest } from "../src/protocol"
import { SpokeConnection, type SocketLike } from "../src/spoke/client"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { connect, session, webDir } from "./central-harness"

const CLUSTER_ENV = {
  HUB_AUTH: "oidc",
  HUB_OIDC_CLIENT_ID: "cid",
  HUB_OIDC_CLIENT_SECRET: "csecret",
  HUB_OIDC_ALLOWED: "@example.com",
  HUB_ADMIN_EMAILS: "admin@example.com",
  HUB_DATABASE_URL: "postgres://hub:s3cretDB@db.internal/hub",
  HUB_VALKEY_URL: "redis://:s3cretVK@valkey.internal:6379",
  HUB_TOKEN_KEYS: JSON.stringify({ active: "k1", keys: [{ kid: "k1", secret: Buffer.alloc(32, 1).toString("base64"), created: 0 }] }),
  HUB_PORT: "0",
  HUB_PUBLIC_URL: "https://hub.example.com",
}

/** Short leases, and drained spokes come back within 300 ms. */
const TIMING = { leaderTtlMs: 900, loopTickMs: 40, drainRetryAfterMs: 300, drainTimeoutMs: 5000 }

interface Variant {
  readonly name: string
  make(): Promise<{ a: Backends; b: Backends; dispose(): Promise<void> }>
}

const variants: Variant[] = [
  {
    name: "memory",
    async make() {
      const backends = memoryBackends()
      return { a: backends, b: backends, dispose: async () => {} }
    },
  },
]

let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await Promise.all([it.postgres(), it.valkey()])
  variants.push({
    name: "postgres+valkey",
    async make() {
      const db = await it.freshDatabase()
      const valkey = await it.freshValkey()
      const bundles: Array<{ bus: ValkeyBus; kv: ValkeyKv; catalog: ValkeyCatalog; locks: ValkeyLocks; state: PostgresStateStore }> = []
      const bundle = (pod: string): Backends => {
        const parts = {
          bus: new ValkeyBus(valkey, { instanceID: `${pod}-bus` }),
          kv: new ValkeyKv(valkey),
          catalog: new ValkeyCatalog(valkey),
          locks: new ValkeyLocks(valkey),
          state: new PostgresStateStore({ url: db, migrate: true }),
        }
        bundles.push(parts)
        return { ...memoryBackends(), ...parts }
      }
      return {
        a: bundle("pod-a"),
        b: bundle("pod-b"),
        dispose: async () => {
          for (const x of bundles) {
            x.bus.close()
            x.kv.close()
            x.catalog.close()
            await x.locks.close()
            await x.state.close()
          }
        },
      }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(10)
  }
}

/** Starts a pod; stop() is safe to call twice (the test may stop it, cleanup stops it again). */
function startPod(podID: string, backends: Backends, stateDir: string, extra: Partial<CentralOptions> = {}): Central {
  const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: podID, HUB_STATE_DIR: stateDir }, "/home/me")
  const central = startCentral({ config, backends, webDir: webDir(), timing: TIMING, ...extra })
  let stopped: Promise<void> | undefined
  const stop = central.stop.bind(central)
  central.stop = () => (stopped ??= stop())
  cleanups.push(() => central.stop())
  return central
}

async function pods(variant: Variant) {
  const { a: backendsA, b: backendsB, dispose } = await variant.make()
  cleanups.push(dispose)
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-drain-"))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  const a = startPod("pod-a", backendsA, stateDir)
  // A leads every loop (it starts first); B follows.
  await waitFor(async () => (await backendsA.locks.holder(leaderKey("launches")))?.owner.startsWith("pod-a:") === true)
  const b = startPod("pod-b", backendsB, stateDir)
  await Promise.all([a.store.ready(), b.store.ready(), a.spokes.ready(), b.spokes.ready()])
  const user = await a.store.upsertUser({ email: "alice@example.com", role: "user" })
  await waitFor(async () => (await b.store.recheck({ users: [user.id] }), b.store.user(user.id) !== undefined))
  const leader = async (job: string) => (await backendsA.locks.holder(leaderKey(job)))?.owner.split(":")[0]
  return { a, b, backendsA, userID: user.id, leader }
}

/**
 * A load-balancer stand-in: sends each new WebSocket to the first pod whose /readyz answers 200 (as k8s takes a
 * pod out of the Service endpoints when its readiness fails). Counts the connections per pod.
 */
function loadBalancer(targets: Central[]) {
  const connections = new Map<string, number>()
  let ready: Central[] = [...targets]
  let polling = true
  const poll = async () => {
    while (polling) {
      const states = await Promise.all(targets.map((t) => fetch(`${t.url}/readyz`).then((r) => r.ok, () => false)))
      ready = targets.filter((_, i) => states[i])
      await Bun.sleep(20)
    }
  }
  void poll()
  cleanups.push(() => void (polling = false))
  const socket = (_url: string, headers: Record<string, string>): SocketLike => {
    const target = ready[0] ?? targets[0]!
    connections.set(target.url, (connections.get(target.url) ?? 0) + 1)
    return new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike)(`${target.url.replace(/^http/, "ws")}/spoke/ws`, { headers })
  }
  return { socket, connections }
}

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

/** A real SpokeConnection (the plugin's client) reporting ses_1, through `lb`; answers with handle(req). */
function spokeClient(token: string, lb: ReturnType<typeof loadBalancer>, handle: (req: ServerRequest) => Promise<unknown>) {
  let conn: SpokeConnection
  conn = new SpokeConnection({
    server: "http://lb.invalid",
    token,
    hello: () => ({ processID: "proc_1", kind: "standalone", directory: "/work", pid: 1, mode: "always", opencodeVersion: "2.0.0", pluginVersion: "0.0.1" }),
    handle,
    // The usual backoff is long: only the bye's retryAfterMs brings it back quickly.
    backoff: { minMs: 30_000, maxMs: 60_000 },
    socket: lb.socket,
    onWelcome: () => void conn.send({ t: "sessions", sessions: [session("ses_1")] }),
  })
  conn.start()
  cleanups.push(() => conn.stop())
  return conn
}

const TEST_TIMEOUT_MS = 20_000

/** `target` with a ping() (readiness) added; its own methods stay bound to it (they use private fields). */
function withPing<T extends object>(target: T, ping: () => Promise<void>): T {
  return new Proxy(target, {
    get: (t, key) => (key === "ping" ? ping : typeof (t as any)[key] === "function" ? (t as any)[key].bind(t) : (t as any)[key]),
  })
}

describe("readiness (cluster mode)", () => {
  test("/readyz is 503 when the database does not answer", async () => {
    const backends = memoryBackends()
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-drain-"))
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
    let down = false
    const state = withPing(backends.state, async () => {
      if (down) throw new Error("connection refused")
    })
    const pod = startPod("pod-a", { ...backends, state }, stateDir)
    expect((await fetch(`${pod.url}/readyz`)).status).toBe(200)
    down = true
    const refused = await fetch(`${pod.url}/readyz`)
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ ok: false })
  })

  test("/readyz is 503 when Valkey does not answer", async () => {
    const backends = memoryBackends()
    const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-drain-"))
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
    const kv = withPing(backends.kv, () => Promise.reject(new Error("Connection closed")))
    const pod = startPod("pod-a", { ...backends, kv }, stateDir)
    expect((await fetch(`${pod.url}/readyz`)).status).toBe(503)
  })
})

for (const variant of variants) {
  describe(`draining across pods (${variant.name})`, () => {
    test(
      "draining A: readyz 503, its spoke reconnects to B within seconds, B leads, the request in flight finishes",
      async () => {
        const { a, b, userID, leader, backendsA } = await pods(variant)
        expect((await fetch(`${a.url}/readyz`)).status).toBe(200)
        expect((await fetch(`${b.url}/readyz`)).status).toBe(200)
        const lb = loadBalancer([a, b])
        const { machine, token } = await a.store.addMachine("laptop", userID)
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        const conn = spokeClient(token, lb, async (req) => {
          if (req.op === "summary") {
            await held
            return { summary: "finished on A" }
          }
          return {}
        })
        await waitFor(() => a.registry.connectionsFor(machine.id).length === 1 && a.registry.hasSession("ses_1"))
        const connOnA = a.registry.connectionsFor(machine.id)[0]!
        // A node on A as well: it gets the draining bye too.
        const node = await connect(a, (await a.store.addMachine("box", userID)).token)
        node.send({ ...nodeHello })
        await node.next((f) => f.t === "welcome")
        expect(await leader("launches")).toBe("pod-a")

        // A request in flight on A's spoke (sent from B, over pod RPC) when the drain starts.
        const inFlight = b.spokes.request(connOnA, { op: "summary", sessionID: "ses_1" }, { tenant: userID })
        await Bun.sleep(100)
        const draining = a.drain()
        await waitFor(async () => (await fetch(`${a.url}/readyz`)).status === 503)
        expect((await fetch(`${b.url}/readyz`)).status).toBe(200)
        // The node (no request in flight) is sent away at once.
        expect(await node.next((f) => f.t === "bye")).toEqual({ t: "bye", reason: "draining", retryAfterMs: 300 })
        // A gives its leases up: B leads.
        await waitFor(async () => (await leader("launches")) === "pod-b")
        await Bun.sleep(100)
        // The spoke stays until its answer is in.
        expect(conn.state).toBe("connected")
        expect(lb.connections.get(b.url) ?? 0).toBe(0)
        release()
        expect(await inFlight).toEqual({ summary: "finished on A" } as any)
        await draining
        // Then it reconnects, through the load balancer, to B within a few seconds (not its 30 s backoff).
        const moved = Date.now()
        await waitFor(() => b.registry.connectionsFor(machine.id).some((id) => id !== connOnA) && lb.connections.get(b.url) === 1, 4000)
        expect(Date.now() - moved).toBeLessThan(4000)
        await waitFor(() => b.registry.hasSession("ses_1"))
        // A's directory entry and view slice are gone; B's are what remains.
        expect(await backendsA.kv.get(`dir:${connOnA}`)).toBeUndefined()
        await a.stop()
        expect(await leader("decisions")).toBe("pod-b")
        expect(conn.state).toBe("connected")
      },
      TEST_TIMEOUT_MS,
    )
  })
}
