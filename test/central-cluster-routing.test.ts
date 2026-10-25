// Cross-pod routing (design §9, decision vkxkqiuf §5): two startCentral pods on shared backends. A connection is
// held by the pod its socket reached; the other pod's SpokeHub.request / requestNode find it in the directory and
// run the op there over pod RPC (same per-op timeouts, errors mapped back, tenant re-checked on the owning pod).
// closeMachine / closeLaunch reach every pod; session-token and act-token pushes never cross the Bus. Shared
// memoryBackends() by default; with HUB_IT_CLUSTER=1 also real Postgres + Valkey (one bus and kv per pod).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { validateLaunchSpec } from "../src/central/agent/launch-spec"
import { memoryBackends, type Backends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { NodeError, RequestTimeoutError, SpokeError } from "../src/central/spoke-ws"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { connect, hello, session, waitFor, webDir, type FakeSpoke } from "./central-harness"

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
}

interface Variant {
  readonly name: string
  /** One bundle per pod (they share what a cluster shares) and a settle() that drains the Bus. */
  make(): Promise<{ a: Backends; b: Backends; settle(): Promise<void>; dispose(): Promise<void> }>
}

const variants: Variant[] = [
  {
    name: "memory",
    async make() {
      const backends = memoryBackends()
      return { a: backends, b: backends, settle: async () => {}, dispose: async () => {} }
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
      const bundle = (pod: string): Backends & { busImpl: ValkeyBus; kvImpl: ValkeyKv; stateImpl: PostgresStateStore } => {
        const bus = new ValkeyBus(valkey, { instanceID: `${pod}-bus` })
        const kv = new ValkeyKv(valkey)
        const state = new PostgresStateStore({ url: db, migrate: true })
        return { ...memoryBackends(), state, bus, kv, busImpl: bus, kvImpl: kv, stateImpl: state }
      }
      const a = bundle("pod-a")
      const b = bundle("pod-b")
      return {
        a,
        b,
        settle: async () => {
          await a.busImpl.sync()
          await b.busImpl.sync()
        },
        dispose: async () => {
          for (const x of [a, b]) {
            x.busImpl.close()
            x.kvImpl.close()
            await x.stateImpl.close()
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

interface Pods {
  readonly a: Central
  readonly b: Central
  readonly backends: { a: Backends; b: Backends }
  readonly userID: string
  settle(): Promise<void>
}

async function pods(variant: Variant, timing: { requestTimeoutMs?: number; nodeTimeoutsMs?: Record<string, number> } = {}): Promise<Pods> {
  const { a: backendsA, b: backendsB, settle, dispose } = await variant.make()
  cleanups.push(dispose)
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-routing-"))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  const start = (pod: string, backends: Backends) => {
    const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: pod, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({ config, backends, webDir: webDir(), timing })
    cleanups.push(() => central.stop())
    return central
  }
  const a = start("pod-a", backendsA)
  const b = start("pod-b", backendsB)
  await Promise.all([a.store.ready(), b.store.ready(), a.spokes.ready(), b.spokes.ready()])
  const user = await a.store.upsertUser({ email: "alice@example.com", role: "user" })
  return { a, b, backends: { a: backendsA, b: backendsB }, userID: user.id, settle }
}

/** A spoke on `central` for a new machine of `userID`, reporting `sessionIDs`; answers requests with `reply`. */
async function spokeOn(central: Central, userID: string, sessionIDs: string[], reply: (req: any) => Record<string, unknown> | undefined) {
  const { machine, token } = await central.store.addMachine("laptop", userID)
  const client = await connect(central, token)
  client.send(hello("p1"))
  await client.next((f) => f.t === "welcome")
  client.send({ t: "sessions", sessions: sessionIDs.map((id) => session(id)) })
  await waitFor(() => sessionIDs.every((id) => central.registry.hasSession(id)))
  const seen = answer(client, reply)
  const connID = central.registry.connectionsFor(machine.id)[0]!
  return Object.assign(client, { machineID: machine.id, connID, seen })
}

function answer(client: FakeSpoke, reply: (req: any) => Record<string, unknown> | undefined): any[] {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const body = reply(frame.req)
    if (body) client.send({ t: "res", id: frame.id, ...body } as any)
  })
  return seen
}

const nodeHello = (): NodeHello => ({
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: {},
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/Users/u/projects"],
  draining: false,
  launches: [],
})
const prepared = { repo: "/Users/u/projects/a", directory: "/Users/u/projects/a/.worktrees/x", mode: "worktree", branch: "x", reused: false } as const
const prepareReq = { op: "prepare", launchID: "lch_1", runtime: { kind: "host" }, harness: "opencode", workspace: { repo: "/Users/u/projects/a", mode: "worktree", branch: "x" } } as const

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error)

for (const variant of variants) {
  describe(`cross-pod routing (${variant.name})`, () => {
    test("a console permission answer and a prompt on B reach the spoke on A", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], (req) => ({ ok: true, result: req.op === "permission" ? {} : { inboxID: "in_1" } }))
      expect(b.registry.connectionsFor(client.machineID)).toEqual([])
      await b.spokes.request(client.connID, { op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" })
      expect(await b.spokes.request(client.connID, { op: "steer", sessionID: "ses_1", text: "hello from B" })).toEqual({ inboxID: "in_1" })
      expect(client.seen).toEqual([
        { op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" },
        { op: "steer", sessionID: "ses_1", text: "hello from B" },
      ])
    })

    test("the spoke's error and the op's timeout come back to B as on A", async () => {
      const { a, b, userID } = await pods(variant, { requestTimeoutMs: 200 })
      const client = await spokeOn(a, userID, ["ses_1"], (req) => (req.op === "interrupt" ? { ok: false, error: "nothing to interrupt" } : undefined))
      const failed = await errorOf(b.spokes.request(client.connID, { op: "interrupt", sessionID: "ses_1" }))
      expect(failed).toBeInstanceOf(SpokeError)
      expect(failed!.message).toBe("nothing to interrupt")
      const late = await errorOf(b.spokes.request(client.connID, { op: "summary", sessionID: "ses_1" }))
      expect(late).toBeInstanceOf(RequestTimeoutError)
      expect(late!.message).toBe(new RequestTimeoutError("summary").message)
    })

    test("the owning pod re-checks the tenant: another user's op, or another user's session, is refused", async () => {
      const { a, b, userID } = await pods(variant)
      const other = await a.store.upsertUser({ email: "bob@example.com", role: "user" })
      const client = await spokeOn(a, userID, ["ses_1"], () => ({ ok: true, result: {} }))
      const wrongUser = await errorOf(b.spokes.request(client.connID, { op: "interrupt", sessionID: "ses_1" }, { tenant: other.id }))
      expect(wrongUser).toBeInstanceOf(SpokeError)
      // Bob's own spoke on A reports ses_bob; Alice's tenant cannot reach it through Bob's connection.
      const bob = await spokeOn(a, other.id, ["ses_bob"], () => ({ ok: true, result: {} }))
      const wrongSession = await errorOf(b.spokes.request(bob.connID, { op: "interrupt", sessionID: "ses_1" }))
      expect(wrongSession).toBeInstanceOf(SpokeError)
      expect(client.seen).toEqual([])
      expect(bob.seen).toEqual([])
    })

    test("session-token and act-token pushes never cross the Bus", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], () => ({ ok: true, result: { accepted: 0 } }))
      await Bun.sleep(50)
      const before = client.seen.length
      expect(await errorOf(b.spokes.request(client.connID, { op: "sessionTokens", tokens: [] } as never))).toBeInstanceOf(SpokeError)
      expect(await errorOf(b.spokes.request(client.connID, { op: "actTokens", tokens: [] } as never))).toBeInstanceOf(SpokeError)
      await Bun.sleep(50)
      expect(client.seen.slice(before).filter((req) => req.op === "sessionTokens" || req.op === "actTokens")).toEqual([])
    })

    test("a node on A gets a launch prepare from B; its errors come back as NodeErrors", async () => {
      const { a, b, userID } = await pods(variant)
      const { machine, token } = await a.store.addMachine("mbp", userID)
      const client = await connect(a, token)
      client.send({ ...nodeHello() })
      await client.next((f) => f.t === "welcome")
      await waitFor(() => a.nodes.forMachine(machine.id) !== undefined)
      const connID = a.nodes.forMachine(machine.id)!.connID
      let fail = false
      const seen = answer(client, () => (fail ? { ok: false, error: "disk full" } : { ok: true, result: { workspace: prepared } }))
      expect(await b.spokes.requestNode(connID, prepareReq)).toEqual({ workspace: prepared })
      expect(seen).toEqual([prepareReq])
      fail = true
      const error = await errorOf(b.spokes.requestNode(connID, prepareReq))
      expect(error).toBeInstanceOf(NodeError)
      expect(error!.message).toBe("disk full")
    })

    test("owning pod gone: the connection is offline and its directory entry is swept", async () => {
      const { a, b, userID, backends } = await pods(variant)
      await backends.b.kv.set("dir:conn_ghost", JSON.stringify({ pod: "pod-dead", machineID: "mch_x" }), { px: 45_000 })
      const ghost = await errorOf(b.spokes.request("conn_ghost", { op: "interrupt", sessionID: "ses_1" }))
      expect(ghost).toBeInstanceOf(SpokeError)
      expect(ghost!.message).toBe("OpenCode process disconnected")
      expect(await backends.b.kv.get("dir:conn_ghost")).toBeUndefined()
      expect(await errorOf(b.spokes.requestNode("conn_ghost", { op: "cancel", launchID: "lch_1" }))).toBeInstanceOf(NodeError)

      const client = await spokeOn(a, userID, ["ses_1"], () => ({ ok: true, result: {} }))
      await a.stop()
      const offline = await errorOf(b.spokes.request(client.connID, { op: "interrupt", sessionID: "ses_1" }))
      expect(offline).toBeInstanceOf(SpokeError)
      expect(offline!.message).toBe("OpenCode process disconnected")
    })

    test("a socket that closes leaves the directory", async () => {
      const { a, b, userID, backends } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], () => ({ ok: true, result: {} }))
      expect(await backends.b.kv.get(`dir:${client.connID}`)).toBeDefined()
      client.close()
      await client.closed
      await waitFor(() => a.registry.connections() === 0)
      for (let i = 0; i < 50 && (await backends.b.kv.get(`dir:${client.connID}`)) !== undefined; i++) await Bun.sleep(10)
      expect(await backends.b.kv.get(`dir:${client.connID}`)).toBeUndefined()
      expect(await errorOf(b.spokes.request(client.connID, { op: "interrupt", sessionID: "ses_1" }))).toBeInstanceOf(SpokeError)
    })

    test("revoking the machine on B closes its sockets on A", async () => {
      const { a, b, userID, settle } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], () => ({ ok: true, result: {} }))
      b.spokes.closeMachine(client.machineID, "revoked")
      await settle()
      expect((await client.next((f) => f.t === "bye")).reason).toBe("revoked")
      expect((await client.closed).code).toBe(4001)
    })

    test("a launch ending on B closes its launch-bound connection on A and is refused there from then on", async () => {
      const { a, b, userID, settle } = await pods(variant)
      const { machine } = await a.store.addMachine("box-host", userID)
      const { launch } = await a.launches.store.create(userID, validateLaunchSpec({ workspace: { repo: "/p/hub", branch: "feat/x" } }))
      await a.launches.store.transition(userID, launch.id, "placing", { reason: "Placing" })
      await a.launches.store.transition(userID, launch.id, "provisioning", { reason: "Placed", machineID: machine.id })
      const minted = await a.launchTokens.mint(machine.id, launch.id)
      const boxed = await connect(a, minted!.token)
      boxed.send(hello("box1", { kind: "service", features: ["launch"], launchID: launch.id }))
      expect((await boxed.next((f) => f.t === "welcome" || f.t === "bye")).t).toBe("welcome")
      b.spokes.closeLaunch(launch.id)
      await settle()
      expect((await boxed.next((f) => f.t === "bye")).reason).toContain("ended")
      expect((await boxed.closed).code).toBe(4004)
      // A reconnect with the still-valid token is turned away on A.
      const again = await connect(a, minted!.token)
      again.send(hello("box1", { kind: "service", features: ["launch"], launchID: launch.id }))
      expect((await again.next((f) => f.t === "bye")).reason).toContain("ended")
    })
  })
}
