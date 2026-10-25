// The cluster view end to end (design §9, decision vkxkqiuf §5): two startCentral pods on shared backends. A spoke
// or node held by pod A is seen by pod B's routes (console and agent API) through B's mirror of A's slices, and the
// ops those routes send reach it over pod RPC. Shared memoryBackends() by default; with HUB_IT_CLUSTER=1 also real
// Postgres + Valkey (state, bus, kv and catalog per pod).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { memoryBackends, type Backends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyCatalog } from "../src/central/backend/valkey-catalog"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { NODE_ROLE, PROTOCOL_VERSION, type Hello, type NodeHello } from "../src/protocol"
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
  // One public URL for the cluster (session tokens are minted for it).
  HUB_PUBLIC_URL: "https://hub.example.com",
}

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
      const bundles: Array<{ bus: ValkeyBus; kv: ValkeyKv; catalog: ValkeyCatalog; state: PostgresStateStore }> = []
      const bundle = (pod: string): Backends => {
        const parts = { bus: new ValkeyBus(valkey, { instanceID: `${pod}-bus` }), kv: new ValkeyKv(valkey), catalog: new ValkeyCatalog(valkey), state: new PostgresStateStore({ url: db, migrate: true }) }
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

type Pod = Central & { api(pathname: string, init?: RequestInit & { json?: unknown; bearer?: string }): Promise<Response> }

async function pods(variant: Variant, timing: Record<string, number> = {}) {
  const { a: backendsA, b: backendsB, dispose } = await variant.make()
  cleanups.push(dispose)
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-view-"))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  let cookie = ""
  const start = (pod: string, backends: Backends): Pod => {
    const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: pod, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({ config, backends, webDir: webDir(), timing })
    let stopped = false
    const stop = central.stop.bind(central)
    central.stop = async () => {
      if (stopped) return
      stopped = true
      await stop()
    }
    cleanups.push(() => central.stop())
    const api: Pod["api"] = (pathname, init = {}) => {
      const headers = new Headers(init.headers)
      if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`)
      else headers.set("cookie", cookie)
      headers.set("origin", central.publicURL)
      let body = init.body
      if (init.json !== undefined) {
        headers.set("content-type", "application/json")
        body = JSON.stringify(init.json)
      }
      return fetch(`${central.url}${pathname}`, { ...init, headers, body, redirect: "manual" })
    }
    return Object.assign(central, { api })
  }
  const a = start("pod-a", backendsA)
  const b = start("pod-b", backendsB)
  await Promise.all([a.store.ready(), b.store.ready(), a.spokes.ready(), b.spokes.ready()])
  const user = await a.store.upsertUser({ email: "alice@example.com", role: "user" })
  const { token } = await a.store.addDevice("phone", user.id)
  cookie = `voice_device=${token}`
  return { a, b, userID: user.id }
}

/** A spoke on `central` for a new machine of `userID`, reporting `sessionIDs`; answers requests with `reply`. */
async function spokeOn(central: Central, userID: string, sessionIDs: string[], reply: (req: any) => unknown, extra: Partial<Hello> = {}) {
  const { machine, token } = await central.store.addMachine("laptop", userID)
  const client = await connect(central, token)
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const result = reply(frame.req)
    if (result !== undefined) client.send({ t: "res", id: frame.id, ok: true, result } as any)
  })
  client.send(hello("p1", extra))
  await client.next((f) => f.t === "welcome")
  client.send({ t: "sessions", sessions: sessionIDs.map((id) => session(id, { owned: true })) })
  await waitFor(() => sessionIDs.every((id) => central.registry.hasSession(id)))
  return Object.assign(client, { machineID: machine.id, seen }) as FakeSpoke & { machineID: string; seen: any[] }
}

const ev = (type: string, data: Record<string, unknown>) => ({ t: "event", event: { type, data } }) as const

for (const variant of variants) {
  describe(`cluster view (${variant.name})`, () => {
    test("a spoke on A is visible on B: machines, session, agent who/status/sessions/show", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], () => ({}))
      await waitFor(() => b.registry.hasSession("ses_1"))
      const machines = (await (await b.api("/api/machines")).json()).machines
      expect(machines.find((m: any) => m.id === client.machineID)).toMatchObject({ online: true, processes: [{ id: "p1" }] })
      expect(await (await b.api("/api/sessions/ses_1")).json()).toMatchObject({ id: "ses_1", state: "idle" })
      await waitFor(() => b.registry.catalog().length === 1)
      const who = await (await b.api("/api/agent/who")).json()
      expect(who.sessions.find((s: any) => s.sessionID === "ses_1")).toMatchObject({ online: true })
      const status = await b.api("/api/agent/status")
      expect(status.status).toBe(200)
      expect(JSON.stringify(await status.json())).toContain("ses_1")
      const sessions = await (await b.api("/api/agent/sessions")).json()
      expect(sessions.sessions.map((s: any) => s.id ?? s.sessionID)).toContain("ses_1")
      expect((await b.api("/api/agent/sessions/ses_1")).status).toBe(200)
    })

    test("a console permission answer, a turn and a steer from B reach the spoke on A", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], (req) => (req.op === "turn" ? { text: "done on A" } : req.op === "steer" ? { inboxID: "in_1" } : {}))
      client.send(ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] }))
      await waitFor(() => b.registry.permissionTargets("ses_1", "per_1").length === 1)
      const answered = await b.api("/api/sessions/ses_1/permission", { method: "POST", json: { requestID: "per_1", decision: "once" } })
      expect(answered.status).toBe(204)
      expect(client.seen).toContainEqual(expect.objectContaining({ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" }))
      client.send(ev("permission.replied", { sessionID: "ses_1", requestID: "per_1" }))
      await waitFor(() => b.registry.permissionTargets("ses_1", "per_1").length === 0)

      const turn = await b.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "hello from B" } })
      expect(turn.status).toBe(200)
      expect(await turn.json()).toEqual({ text: "done on A" })
      expect(client.seen).toContainEqual(expect.objectContaining({ op: "turn", sessionID: "ses_1", text: "hello from B" }))

      client.send(ev("session.execution.started", { sessionID: "ses_1" }))
      await waitFor(() => b.registry.running("ses_1"))
      const steer = await b.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "steer from B" } })
      expect(steer.status).toBe(202)
      expect(await steer.json()).toEqual({ mode: "steer", inboxID: "in_1" })
    })

    test("a session token minted on A is valid on B", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], (req) => (req.op === "sessionTokens" ? { applied: req.tokens.map((t: any) => t.sessionID), skipped: [] } : {}), {
        harness: "opencode",
        harnessVersion: "2.0.0",
        features: ["sessionTokens"],
      })
      await waitFor(() => client.seen.some((req) => req.op === "sessionTokens"))
      const token = client.seen.find((req) => req.op === "sessionTokens").tokens.find((t: any) => t.sessionID === "ses_1").token
      await waitFor(() => b.registry.hasSession("ses_1"))
      const status = await b.api("/api/agent/status", { bearer: token })
      expect(status.status).toBe(200)
    })

    test("B's directory keeps A's sessions online and their roles", async () => {
      const { a, b, userID } = await pods(variant)
      await spokeOn(a, userID, ["ses_1"], () => ({}))
      await waitFor(() => b.registry.hasSession("ses_1"))
      const claimed = await b.api("/api/agent/roles/claim", { method: "POST", json: { role: "reviewer", exclusive: true, session: "ses_1" } })
      expect(claimed.status).toBe(200)
      // A catalog change on B (its own spoke) syncs the directory there: A's session must stay online.
      await spokeOn(b, userID, ["ses_2"], () => ({}))
      await waitFor(() => a.registry.hasSession("ses_2"))
      for (const pod of [a, b]) {
        const who = await (await pod.api("/api/agent/who")).json()
        expect(who.sessions.find((s: any) => s.sessionID === "ses_1")).toMatchObject({ online: true, roles: [{ role: "reviewer", exclusive: true }] })
      }
      const record = (await b.store.recheck({ users: [userID] }), b.store.agentData(userID).sessions?.find((s) => s.sessionID === "ses_1"))
      expect(record).toBeDefined()
    })

    test("a node on A is a placement candidate on B", async () => {
      const { a, b, userID } = await pods(variant)
      const { machine, token } = await a.store.addMachine("mbp", userID)
      const client = await connect(a, token)
      const node: NodeHello = {
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
      }
      client.send({ ...node })
      await client.next((f) => f.t === "welcome")
      await waitFor(() => b.nodes.list(userID).length === 1)
      expect(b.nodes.forMachine(machine.id)).toMatchObject({ ownerID: userID, free: { slots: 4 } })
      expect(b.nodes.count()).toBe(0)
    })

    test("a pod that stops takes its reports with it", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, ["ses_1"], () => ({}))
      await waitFor(() => b.registry.hasSession("ses_1"))
      await a.stop()
      await waitFor(() => !b.registry.hasSession("ses_1"))
      const machines = (await (await b.api("/api/machines")).json()).machines
      expect(machines.find((m: any) => m.id === client.machineID)).toMatchObject({ online: false })
    })

    test("a machine revoked on B without a close notice is disconnected by A's periodic check", async () => {
      const { a, b, userID } = await pods(variant, { recheckMs: 50 })
      const client = await spokeOn(a, userID, ["ses_1"], () => ({}))
      await b.store.revokeMachine(client.machineID)
      expect((await client.closed).code).toBe(4001)
      await waitFor(() => !b.registry.hasSession("ses_1"))
    })

    test("a disabled owner's spokes are disconnected by the periodic check", async () => {
      const { a, b, userID } = await pods(variant, { recheckMs: 50 })
      const client = await spokeOn(a, userID, ["ses_1"], () => ({}))
      await b.store.setUser(userID, { disabled: true })
      expect((await client.closed).code).toBe(4001)
    })
  })
}
