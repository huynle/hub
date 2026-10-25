// Leader loops end to end (design §9, decision vkxkqiuf §7): two startCentral pods on shared backends. The timed jobs
// (launch supervisor, decision deadlines, message re-wakes, webhook sender) run on the pod holding their leader
// lease; accept and stop work on any pod; the leader stopping hands its jobs to the other pod, which finishes them;
// pending messages reach a recipient once even when it reconnects to both pods at once. Shared memoryBackends() by
// default; with HUB_IT_CLUSTER=1 also real Postgres + Valkey (state, bus, kv, locks, catalog).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentActor } from "../src/central/agent/actor"
import { memoryBackends, type Backends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyCatalog } from "../src/central/backend/valkey-catalog"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { ValkeyLocks } from "../src/central/backend/valkey-locks"
import { leaderKey } from "../src/central/cluster/leader"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { connect, hello, session, webDir } from "./central-harness"

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

/** Short leases and loop ticks so failover and the loops run within a test. */
const TIMING = { leaderTtlMs: 900, loopTickMs: 40 }

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

/** Polls until the (sync or async) check holds. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(5)
  }
}

interface Push {
  readonly pod: string
  readonly kind: string
  readonly key?: string
}

async function pods(variant: Variant) {
  const { a: backendsA, b: backendsB, dispose } = await variant.make()
  cleanups.push(dispose)
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-leaders-"))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  // The hub's clock (deadlines, re-wakes) moves when the test says; the backends keep real time (leases).
  let offset = 0
  const now = () => Date.now() + offset
  const pushes: Push[] = []
  const start = (podID: string, backends: Backends): Central => {
    const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: podID, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({
      config,
      backends,
      webDir: webDir(),
      now,
      timing: TIMING,
      notifier: {
        notify: async (kind, _sessionID, _title, _body, _owner, extra) => {
          pushes.push({ pod: podID, kind, ...(extra?.key ? { key: extra.key } : {}) })
          return 1
        },
      },
    })
    let stopped = false
    const stop = central.stop.bind(central)
    central.stop = async () => {
      if (stopped) return
      stopped = true
      await stop()
    }
    cleanups.push(() => central.stop())
    return central
  }
  const a = start("pod-a", backendsA)
  // A leads every loop (it starts first); B follows.
  await waitFor(async () => (await backendsA.locks.holder(leaderKey("launches")))?.owner.startsWith("pod-a:") === true)
  const b = start("pod-b", backendsB)
  await Promise.all([a.store.ready(), b.store.ready(), a.spokes.ready(), b.spokes.ready()])
  const user = await a.store.upsertUser({ email: "alice@example.com", role: "user" })
  await waitFor(async () => (await b.store.recheck({ users: [user.id] }), b.store.user(user.id) !== undefined))
  /** Which pod holds a job's leader lease. */
  const leader = async (job: string) => (await backendsA.locks.holder(leaderKey(job)))?.owner.split(":")[0]
  return { a, b, userID: user.id, pushes, leader, advance: (ms: number) => void (offset += ms) }
}

/** Answers every request on the socket with reply(req) (a res body; undefined: never answers). */
function serve(client: { ws: WebSocket; send(frame: any): void }, reply: (req: any) => Record<string, unknown> | undefined) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const body = reply(frame.req)
    if (body) client.send({ t: "res", id: frame.id, ...body })
  })
  return seen
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

/** A node and a launch-capable service spoke of one machine, both on `central`. */
async function machineOn(central: Central, userID: string, options: { holdPrepare?: () => boolean } = {}) {
  const { machine, token } = await central.store.addMachine("mbp", userID)
  const node = await connect(central, token)
  node.send({ ...nodeHello })
  await node.next((f) => f.t === "welcome")
  const nodeOps = serve(node, (req) => {
    const directory = `/p/hub/.worktrees/${req.launchID}`
    if (req.op === "prepare") return options.holdPrepare?.() ? undefined : { ok: true, result: { workspace: { repo: "/p/hub", directory, mode: "worktree", branch: "feat/x", reused: false } } }
    if (req.op === "collect") return { ok: true, result: { artifacts: { commits: 1 } } }
    if (req.op === "cleanup") return { ok: true, result: { removed: false, reason: "cleanup policy is keep" } }
    return { ok: true, result: { cancelled: false } }
  })
  const service = await connect(central, token)
  service.send(hello("svc", { kind: "service", features: ["launch", "deliver"] }))
  await service.next((f) => f.t === "welcome")
  service.send({ t: "sessions", sessions: [] })
  const sessions: ReturnType<typeof session>[] = []
  let n = 0
  const spokeOps = serve(service, (req) => {
    if (req.op === "create") {
      const id = `ses_${++n}${String(req.launchID).replace(/[^a-z0-9]/gi, "")}`
      sessions.push(session(id, { owned: true, directory: req.directory }))
      service.send({ t: "sessions", sessions })
      return { ok: true, result: { sessionID: id } }
    }
    if (req.op === "deliver") return { ok: true, result: { delivered: "steer" } }
    if (req.op === "turn") return undefined
    if (req.op === "stop") return { ok: true, result: { stopped: [req.sessionID] } }
    return { ok: true, result: {} }
  })
  return { machineID: machine.id, nodeOps, spokeOps }
}

/** Two pods, spokes and nodes per test: more than bun's default 5 s. */
const TEST_TIMEOUT_MS = 20_000

const count = <T,>(list: readonly T[], match: (item: T) => boolean) => list.filter(match).length

async function launchState(central: Central, userID: string, id: string) {
  return (await central.launches.store.get(userID, id))?.state
}

for (const variant of variants) {
  describe(`leader loops (${variant.name})`, () => {
    test("each launch is provisioned, prompted and ended exactly once, accepted and stopped on either pod", async () => {
      const { a, b, userID, leader } = await pods(variant)
      expect(await leader("launches")).toBe("pod-a")
      const m = await machineOn(b, userID)
      await waitFor(() => a.nodes.list(userID).length === 1 && a.registry.serviceFor(m.machineID) !== undefined)
      const onA = (await a.launches.accept(userID, { workspace: { repo: "/p/hub", branch: "feat/a" }, prompt: "Go A" }, { by: "user" })).launch
      const onB = (await b.launches.accept(userID, { workspace: { repo: "/p/hub", branch: "feat/b" }, prompt: "Go B" }, { by: "user" })).launch
      for (const launch of [onA, onB]) await waitFor(async () => (await launchState(a, userID, launch.id)) === "running", 6000)
      // The prompt's turn crosses to B's spoke over pod RPC: it may arrive just after the launch reads running.
      await waitFor(() => count(m.spokeOps, (r) => r.op === "turn") >= 2)
      await Bun.sleep(100)
      for (const launch of [onA, onB]) {
        expect(count(m.nodeOps, (r) => r.op === "prepare" && r.launchID === launch.id)).toBe(1)
        expect(count(m.spokeOps, (r) => r.op === "create" && r.launchID === launch.id)).toBe(1)
        const sessionID = (await a.launches.store.get(userID, launch.id))!.sessionID
        expect(count(m.spokeOps, (r) => r.op === "turn" && r.sessionID === sessionID)).toBe(1)
      }
      // B is not the leader: its stop goes to A, where the launch's watch lives.
      expect(await b.launches.stop(userID, onA.id)).toMatchObject({ state: "ended", outcome: "stopped", artifacts: { commits: 1 } })
      expect(await a.launches.stop(userID, onB.id)).toMatchObject({ state: "ended", outcome: "stopped" })
      await Bun.sleep(200)
      for (const launch of [onA, onB]) {
        expect(count(m.nodeOps, (r) => r.op === "collect" && r.launchID === launch.id)).toBe(1)
        expect(count(m.nodeOps, (r) => r.op === "cleanup" && r.launchID === launch.id)).toBe(1)
      }
    }, TEST_TIMEOUT_MS)

    test("the leader stopping mid-launch: the other pod takes over within the lease and finishes it once", async () => {
      const { a, b, userID, leader } = await pods(variant)
      let hold = true
      const m = await machineOn(b, userID, { holdPrepare: () => hold })
      await waitFor(() => a.nodes.list(userID).length === 1 && a.registry.serviceFor(m.machineID) !== undefined)
      const { launch } = await b.launches.accept(userID, { workspace: { repo: "/p/hub", branch: "feat/x" }, prompt: "Go" }, { by: "user" })
      await waitFor(() => m.nodeOps.some((r) => r.op === "prepare"), 4000)
      hold = false
      const stoppedAt = Date.now()
      await a.stop()
      await waitFor(async () => (await leader("launches")) === "pod-b", TIMING.leaderTtlMs * 2)
      expect(Date.now() - stoppedAt).toBeLessThan(TIMING.leaderTtlMs * 2)
      await waitFor(async () => (await launchState(b, userID, launch.id)) === "running", 6000)
      await waitFor(() => count(m.spokeOps, (r) => r.op === "turn") >= 1)
      await Bun.sleep(100)
      expect(count(m.spokeOps, (r) => r.op === "create")).toBe(1)
      expect(count(m.spokeOps, (r) => r.op === "turn")).toBe(1)
      expect(await b.launches.stop(userID, launch.id)).toMatchObject({ state: "ended", outcome: "stopped" })
      expect(count(m.nodeOps, (r) => r.op === "cleanup")).toBe(1)
    }, TEST_TIMEOUT_MS)

    test("a pending message is delivered once when its recipient reconnects to both pods at once", async () => {
      const { a, b, userID } = await pods(variant)
      const { token } = await a.store.addMachine("laptop", userID)
      const first = await connect(a, token)
      first.send(hello("p1", { features: ["deliver"] }))
      await first.next((f) => f.t === "welcome")
      first.send({ t: "sessions", sessions: [session("ses_r", { owned: true })] })
      await waitFor(() => b.registry.hasSession("ses_r"))
      await waitFor(async () => (await a.store.recheck({ users: [userID] }), a.store.agentData(userID).sessions?.some((s) => s.sessionID === "ses_r") === true))
      first.ws.close()
      await waitFor(() => !a.registry.hasSession("ses_r") && !b.registry.hasSession("ses_r"))
      const actor: AgentActor = { kind: "user", userID, deviceID: "d1", via: "cookie" }
      const sent = await a.delivery.send(userID, actor, "ses_r", "msg", "while you were away")
      expect(sent.delivery).toBe("pending")
      // The harness comes back through two processes, one on each pod.
      const delivered: string[] = []
      const back = async (central: Central, processID: string) => {
        const client = await connect(central, token)
        serve(client, (req) => {
          if (req.op !== "deliver") return { ok: true, result: {} }
          delivered.push(req.messageID)
          return { ok: true, result: { delivered: "turn" } }
        })
        client.send(hello(processID, { features: ["deliver"] }))
        await client.next((f) => f.t === "welcome")
        return client
      }
      const [onA, onB] = await Promise.all([back(a, "p2"), back(b, "p3")])
      onA.send({ t: "sessions", sessions: [session("ses_r", { owned: true })] })
      onB.send({ t: "sessions", sessions: [session("ses_r", { owned: true })] })
      await waitFor(async () => (await a.delivery.messages.get(userID, sent.message.id))?.delivery === "turn", 4000)
      // Later sessions frames on either pod deliver nothing more.
      onA.send({ t: "sessions", sessions: [session("ses_r", { owned: true })] })
      onB.send({ t: "sessions", sessions: [session("ses_r", { owned: true })] })
      await Bun.sleep(300)
      expect(count(delivered, (id) => id === sent.message.id)).toBe(1)
    }, TEST_TIMEOUT_MS)

    test("each decision deadline and message re-wake fires once, on the leader", async () => {
      const { a, b, userID, pushes, advance } = await pods(variant)
      const { token } = await b.store.addMachine("laptop", userID)
      const spoke = await connect(b, token)
      const reminders: string[] = []
      serve(spoke, (req) => {
        if (req.op === "deliver" && String(req.text).includes("reminder")) reminders.push(req.messageID)
        return { ok: true, result: req.op === "deliver" ? { delivered: "steer" } : {} }
      })
      spoke.send(hello("p1", { features: ["deliver"] }))
      await spoke.next((f) => f.t === "welcome")
      spoke.send({ t: "sessions", sessions: [session("ses_a", { owned: true }), session("ses_b", { owned: true })] })
      await waitFor(() => a.registry.idle("ses_b") && b.registry.idle("ses_b"))
      await waitFor(async () => (await b.store.recheck({ users: [userID] }), b.store.agentData(userID).sessions?.some((s) => s.sessionID === "ses_b") === true))
      const asker: AgentActor = { kind: "session", userID, machineID: "m", sessionID: "ses_a" }
      // An ask to an idle session (re-woken after 5 minutes) and a Decision with a 1 minute deadline (escalated).
      const ask = await b.delivery.send(userID, asker, "ses_b", "ask", "q?")
      expect(ask.delivery).toBe("steer")
      const { decision } = await b.decisions.ask(userID, asker, { question: "ok?", options: [{ id: "yes", label: "Yes" }], deadlineMs: 60_000 })
      advance(6 * 60_000)
      await waitFor(() => reminders.length >= 1 && pushes.some((p) => p.key === `${decision.id}:escalated`), 4000)
      await Bun.sleep(TIMING.loopTickMs * 10)
      expect(reminders).toHaveLength(1)
      expect(pushes.filter((p) => p.key === `${decision.id}:escalated`)).toEqual([{ pod: "pod-a", kind: "decision", key: `${decision.id}:escalated` }])
    }, TEST_TIMEOUT_MS)
  })
}
