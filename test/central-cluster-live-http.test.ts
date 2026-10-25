// Live fan-out end to end (design §9, decision vkxkqiuf §6): two startCentral pods on shared backends. What happens
// on the pod holding a spoke (status, streamed text, agent messages, launches) reaches console streams
// (/api/events) and agent watches (/api/agent/watch) on the other pod; Last-Event-ID resumes on any pod; an ask's
// long-poll on one pod wakes on a reply made on the other. Shared memoryBackends() by default; with HUB_IT_CLUSTER=1
// also real Postgres + Valkey (state, bus, kv, catalog and event log).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BearerVerifier } from "../src/central/agent/actor"
import type { Launch } from "../src/central/agent/launch-store"
import { memoryBackends, type Backends } from "../src/central/backend"
import { PostgresStateStore } from "../src/central/backend/postgres-state"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { ValkeyCatalog } from "../src/central/backend/valkey-catalog"
import { ValkeyEventLog } from "../src/central/backend/valkey-events"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { connect, hello, session, sse, waitFor, webDir } from "./central-harness"

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
      const bundles: Array<{ bus: ValkeyBus; kv: ValkeyKv; catalog: ValkeyCatalog; events: ValkeyEventLog; state: PostgresStateStore }> = []
      const bundle = (pod: string): Backends => {
        const parts = {
          bus: new ValkeyBus(valkey, { instanceID: `${pod}-bus` }),
          kv: new ValkeyKv(valkey),
          catalog: new ValkeyCatalog(valkey),
          events: new ValkeyEventLog(valkey),
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
            x.events.close()
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

type Api = (pathname: string, init?: RequestInit & { json?: unknown; bearer?: string; cookie?: string }) => Promise<Response>
type Pod = Central & { api: Api }

/** Session tokens (fake, like the message route tests): their user is set per test. */
const TOKENS: Record<string, string> = { ses_1: "hst_fake_ses_1", ses_2: "hst_fake_ses_2" }
let tokenUser = ""
const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) => {
      const sessionID = Object.keys(TOKENS).find((id) => TOKENS[id] === token)
      return sessionID ? { kind: "session", userID: tokenUser, machineID: "mch_x", sessionID } : undefined
    },
  },
]

async function pods(variant: Variant) {
  const { a: backendsA, b: backendsB, dispose } = await variant.make()
  cleanups.push(dispose)
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-live-"))
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
  let cookie = ""
  const start = (pod: string, backends: Backends): Pod => {
    const config = centralConfig({ ...CLUSTER_ENV, HUB_POD_ID: pod, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({ config, backends, webDir: webDir(), agent: { verifiers } } as any)
    let stopped = false
    const stop = central.stop.bind(central)
    central.stop = async () => {
      if (stopped) return
      stopped = true
      await stop()
    }
    cleanups.push(() => central.stop())
    const api: Api = (pathname, init = {}) => {
      const headers = new Headers(init.headers)
      if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`)
      else headers.set("cookie", init.cookie ?? cookie)
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
  tokenUser = user.id
  /** Another user with a device on B. */
  const other = async () => {
    const bob = await b.store.upsertUser({ email: "bob@example.com", role: "user" })
    const device = await b.store.addDevice("phone", bob.id)
    return { userID: bob.id, cookie: `voice_device=${device.token}` }
  }
  return { a, b, userID: user.id, other }
}

/** A spoke on `central` for a new machine of `userID`, reporting `sessions`; answers deliver requests. */
async function spokeOn(central: Central, userID: string, sessions: Array<{ id: string; title: string }>) {
  const { token } = await central.store.addMachine("laptop", userID)
  const client = await connect(central, token)
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    client.send({ t: "res", id: frame.id, ok: true, result: frame.req.op === "deliver" ? { delivered: frame.req.wake ? "turn" : "queued" } : {} } as any)
  })
  client.send(hello("p1", { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] } as any))
  await client.next((f) => f.t === "welcome")
  client.send({ t: "sessions", sessions: sessions.map((s) => session(s.id, { title: s.title, owned: true })) })
  await waitFor(() => sessions.every((s) => central.registry.hasSession(s.id)))
  return client
}

type Frame = { id?: string; event?: string; data?: any }
/** Reads SSE frames with their ids. */
function frames(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const all: Frame[] = []
  return {
    all,
    async next(predicate: (f: Frame) => boolean = () => true, timeoutMs = 3000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let index: number
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const frame: Frame = {}
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4)
            else if (line.startsWith("event: ")) frame.event = line.slice(7)
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6))
          }
          if (frame.data === undefined || frame.event) continue
          all.push(frame)
          if (predicate(frame)) return frame
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for SSE frame")
        const result = await Promise.race([reader.read(), Bun.sleep(left).then(() => ({ timeout: true }) as const)])
        if ("timeout" in result) continue
        if (result.done) throw new Error("SSE stream ended")
        buffer += decoder.decode(result.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

const ev = (type: string, data: Record<string, unknown>) => ({ t: "event", event: { type, data } }) as const
const isType = (type: string) => (f: Frame) => f.data?.type === type

const fakeLaunch = (owner: string, id: string): Launch =>
  ({ id, owner, state: "queued", reason: "accepted", spec: { end: {}, labels: { job: "x" } }, created: 0, at: 0, history: [] }) as unknown as Launch

for (const variant of variants) {
  describe(`cluster live fan-out (${variant.name})`, () => {
    test("a turn's streamed text and status on A reach a console stream on B", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, [{ id: "ses_1", title: "API refactor" }])
      await waitFor(() => b.registry.hasSession("ses_1"))
      const stream = frames(await b.api("/api/events"))
      await stream.next(isType("catalog"))
      client.send(ev("session.execution.started", { sessionID: "ses_1" }))
      client.send(ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "Hello" }))
      const status = await stream.next(isType("status"))
      expect(status.id).toBeDefined()
      const delta = await stream.next(isType("delta"))
      expect(delta.data.text).toBe("Hello")
      // Streamed text is broadcast only: no id to resume from.
      expect(delta.id).toBeUndefined()
      await stream.cancel()
    })

    test("Last-Event-ID from A resumes on B; an id the log cannot cover gets a resync", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, [{ id: "ses_1", title: "API refactor" }])
      const first = frames(await a.api("/api/events"))
      const catalog = await first.next(isType("catalog"))
      await first.cancel()
      client.send(ev("session.execution.started", { sessionID: "ses_1" }))
      await waitFor(() => a.registry.status("ses_1")?.[0]?.state === "working")
      await Bun.sleep(50)
      const again = frames(await b.api("/api/events", { headers: { "last-event-id": catalog.id! } }))
      const status = await again.next(isType("status"))
      expect(status.data.sessions[0].state).toBe("working")
      expect(status.id).toBeDefined()
      await again.next(isType("catalog"))
      expect(again.all.some((f) => f.data?.type === "resync")).toBe(false)
      await again.cancel()
      const stale = frames(await b.api("/api/events", { headers: { "last-event-id": "nonsense" } }))
      await stale.next(isType("catalog"))
      await stale.next(isType("resync"))
      await stale.cancel()
    })

    test("an agent message stored on A appears once on B's console stream and B's watch", async () => {
      const { a, b, userID } = await pods(variant)
      await spokeOn(a, userID, [
        { id: "ses_1", title: "API refactor" },
        { id: "ses_2", title: "Web work" },
      ])
      await waitFor(() => b.registry.hasSession("ses_2"))
      const console_ = frames(await b.api("/api/events"))
      await console_.next(isType("catalog"))
      const watch = sse(await b.api("/api/agent/watch"))
      await watch.next((m) => m.type === "ready")
      const sent = await a.api("/api/agent/msg", { bearer: TOKENS.ses_1, method: "POST", json: { to: "@web-work", text: "hello" } })
      expect(sent.status).toBe(201)
      const { message } = (await sent.json()) as any
      const live = await console_.next((f) => f.data?.type === "message" && f.data.message.id === message.id)
      expect(live.id).toBeDefined()
      expect(await watch.next((m) => m.type === "message")).toMatchObject({ id: message.id, sessionID: "ses_2", senderID: "ses_1" })
      // A later event as a marker: the message was not streamed twice.
      await a.launchFeed.publish(userID, fakeLaunch(userID, "lch_marker"))
      await console_.next(isType("launch"))
      expect(console_.all.filter((f) => f.data?.type === "message" && f.data.message.id === message.id)).toHaveLength(1)
      await console_.cancel()
      await watch.cancel()
    })

    test("B's watch sees state changes of a session on A", async () => {
      const { a, b, userID } = await pods(variant)
      const client = await spokeOn(a, userID, [{ id: "ses_1", title: "API refactor" }])
      await waitFor(() => b.registry.hasSession("ses_1"))
      const watch = sse(await b.api("/api/agent/watch"))
      await watch.next((m) => m.type === "ready")
      await Bun.sleep(50)
      client.send(ev("session.execution.started", { sessionID: "ses_1" }))
      expect(await watch.next((m) => m.type === "state")).toMatchObject({ sessionID: "ses_1", state: "working" })
      await watch.cancel()
    })

    test("an ask long-polling on B wakes on a reply made on A", async () => {
      const { a, b, userID } = await pods(variant)
      await spokeOn(a, userID, [
        { id: "ses_1", title: "API refactor" },
        { id: "ses_2", title: "Web work" },
      ])
      await waitFor(() => b.registry.hasSession("ses_2"))
      const asking = b.api("/api/agent/ask", { bearer: TOKENS.ses_1, method: "POST", json: { to: "@web-work", text: "ready?", wait: 10 } })
      let askID: string | undefined
      for (let i = 0; i < 200 && !askID; i++) {
        const inbox = (await (await a.api("/api/agent/inbox", { bearer: TOKENS.ses_2 })).json()) as any
        askID = inbox.asks?.[0]?.id
        if (!askID) await Bun.sleep(10)
      }
      expect(askID).toBeDefined()
      // The ask is waiting on B by now.
      await Bun.sleep(200)
      const replied = await a.api("/api/agent/reply", { bearer: TOKENS.ses_2, method: "POST", json: { replyTo: askID, text: "yes" } })
      expect(replied.status).toBe(201)
      const at = Date.now()
      const answered = (await (await asking).json()) as any
      // Woken by the reply (over the Bus), not by the waiter's periodic look (WAIT_POLL_MS).
      expect(Date.now() - at).toBeLessThan(600)
      expect(answered).toMatchObject({ message: { id: askID, state: "answered" }, answer: { text: "yes" } })
    })

    test("a launch change on A streams once on both pods; webhooks queue it only on A", async () => {
      const { a, b, userID } = await pods(variant)
      const queued: string[] = []
      a.webhooks.onLaunch = (async () => void queued.push("a")) as any
      b.webhooks.onLaunch = (async () => void queued.push("b")) as any
      const onA = frames(await a.api("/api/events"))
      const onB = frames(await b.api("/api/events"))
      await Promise.all([onA.next(isType("catalog")), onB.next(isType("catalog"))])
      const watch = sse(await b.api("/api/agent/watch"))
      await watch.next((m) => m.type === "ready")
      a.launchFeed.publish(userID, fakeLaunch(userID, "lch_1"))
      for (const stream of [onA, onB]) expect((await stream.next(isType("launch"))).data.launch).toMatchObject({ id: "lch_1", state: "queued" })
      expect(await watch.next((m) => m.type === "launch")).toMatchObject({ id: "lch_1", labels: { job: "x" } })
      a.launchFeed.publish(userID, fakeLaunch(userID, "lch_2"))
      for (const stream of [onA, onB]) await stream.next((f) => f.data?.launch?.id === "lch_2")
      for (const stream of [onA, onB]) expect(stream.all.filter((f) => f.data?.launch?.id === "lch_1")).toHaveLength(1)
      expect(queued).toEqual(["a", "a"])
      await Promise.all([onA.cancel(), onB.cancel(), watch.cancel()])
    })

    test("tenancy: another user's streams on B never get A's events of this user", async () => {
      const { a, b, userID, other } = await pods(variant)
      const bob = await other()
      const client = await spokeOn(a, userID, [{ id: "ses_1", title: "API refactor" }])
      const bobSpoke = await spokeOn(a, bob.userID, [{ id: "ses_9", title: "Bob's" }])
      await waitFor(() => b.registry.hasSession("ses_1") && b.registry.hasSession("ses_9"))
      const stream = frames(await b.api("/api/events", { cookie: bob.cookie }))
      await stream.next(isType("catalog"))
      const watch = sse(await b.api("/api/agent/watch", { cookie: bob.cookie }))
      await watch.next((m) => m.type === "ready")
      await Bun.sleep(50)
      client.send(ev("session.execution.started", { sessionID: "ses_1" }))
      client.send(ev("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "secret" }))
      a.launchFeed.publish(userID, fakeLaunch(userID, "lch_alice"))
      await waitFor(() => a.registry.status("ses_1")?.[0]?.state === "working")
      // Bob's own event as a marker.
      bobSpoke.send(ev("session.execution.started", { sessionID: "ses_9" }))
      await stream.next((f) => f.data?.type === "status" && f.data.sessionID === "ses_9")
      const watched = await watch.next((m) => m.type === "state")
      expect(watched.sessionID).toBe("ses_9")
      const text = JSON.stringify(stream.all)
      expect(text).not.toContain("ses_1")
      expect(text).not.toContain("secret")
      expect(text).not.toContain("lch_alice")
      await stream.cancel()
      await watch.cancel()
    })
  })
}
