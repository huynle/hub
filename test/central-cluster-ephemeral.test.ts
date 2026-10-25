// Ephemeral auth state across pods (P6-T8, decision vkxkqiuf): enrollment codes, the enrollment limiter, pending
// OIDC sign-ins, answered permissions and push cooldowns live in the Kv / Counters backends, so any pod finishes what
// another started. Two startCentral pods in cluster mode share one memoryBackends() bundle; with HUB_IT_CLUSTER=1
// (and docker) the same flows also run with each pod on its own Valkey Kv and Counters clients against a real
// Valkey (test/cluster-it.ts), the rest of the bundle shared in memory.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { memoryBackends, type Backends } from "../src/central/backend"
import { ValkeyCounters } from "../src/central/backend/valkey-counters"
import { ValkeyKv } from "../src/central/backend/valkey-kv"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { PUBLIC, session, spoke, waitFor, webDir, type FakeSpoke } from "./central-harness"
import { fakeProvider, oidcEnv, setCookie, type FakeProvider } from "./oidc-fake"

const CLUSTER_ENV = {
  HUB_DATABASE_URL: "postgres://hub:pw@db.invalid/hub",
  HUB_VALKEY_URL: "redis://valkey.invalid:6379",
  HUB_TOKEN_KEYS: JSON.stringify({ active: "k1", keys: [{ kid: "k1", secret: Buffer.alloc(32, 1).toString("base64"), created: 0 }] }),
  HUB_PORT: "0",
  HUB_PUBLIC_URL: PUBLIC,
}

interface Pods {
  readonly a: Central
  readonly b: Central
  readonly idp: FakeProvider
}

interface Variant {
  readonly name: string
  /** The bundle of each pod: the shared parts plus, for Valkey, the pod's own Kv / Counters clients. */
  bundles(): Promise<[Backends, Backends]>
}

const disposers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function pods(variant: Variant): Promise<Pods> {
  const idp = fakeProvider()
  disposers.push(() => idp.stop())
  const stateDir = mkdtempSync(path.join(tmpdir(), "hub-cluster-ephemeral-"))
  disposers.push(() => rmSync(stateDir, { recursive: true, force: true }))
  const bundles = await variant.bundles()
  const started = bundles.map((backends, index) => {
    const config = centralConfig({ ...oidcEnv(idp), ...CLUSTER_ENV, HUB_POD_ID: `pod-${index}`, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({ config, backends, webDir: webDir() })
    disposers.push(() => central.stop())
    return central
  })
  const [a, b] = started as [Central, Central]
  await Promise.all([a.store.ready(), b.store.ready()])
  return { a, b, idp }
}

const post = (pod: Central, pathname: string, json: unknown, cookie?: string) =>
  fetch(`${pod.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(json),
    redirect: "manual",
  })

/** A signed-in browser of a new user (admin when the email is an admin's). */
async function browser(pod: Central, email: string, role: "admin" | "user" = "user"): Promise<{ userID: string; cookie: string }> {
  const user = await pod.store.upsertUser({ email, role })
  const { token } = await pod.store.addDevice("phone", user.id)
  return { userID: user.id, cookie: `voice_device=${token}` }
}

/** Answers every request frame with `reply`; records what was asked. */
function answer(client: FakeSpoke, reply: () => unknown): unknown[] {
  const seen: unknown[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    client.send({ t: "res", id: frame.id, ok: true, result: reply() })
  })
  return seen
}

const memoryVariant: Variant = {
  name: "memory",
  async bundles() {
    const shared = memoryBackends()
    return [shared, shared]
  },
}

const variants: Variant[] = [memoryVariant]
let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await it.valkey()
  variants.push({
    name: "valkey kv+counters",
    async bundles() {
      const url = await it.freshValkey()
      const shared = memoryBackends()
      const own = (): Backends => {
        const kv = new ValkeyKv(url)
        const counters = new ValkeyCounters(url)
        disposers.push(async () => {
          await kv.close()
          await counters.close()
        })
        return { ...shared, kv, counters }
      }
      return [own(), own()]
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

for (const variant of variants) {
  describe(`ephemeral auth state across pods (${variant.name})`, () => {
    test("an enrollment started on A is listed, approved and polled on B; the token is delivered once", async () => {
      const { a, b } = await pods(variant)
      const admin = await browser(a, "admin@example.com", "admin")
      const start = (await (await post(a, "/spoke/enroll", { machineName: "laptop" })).json()) as { userCode: string; deviceCode: string }
      expect(await (await post(b, "/spoke/enroll/poll", { deviceCode: start.deviceCode })).json()).toEqual({ status: "pending" })
      const listed = (await (await fetch(`${b.url}/api/enrollments`, { headers: { cookie: admin.cookie } })).json()) as { enrollments: { userCode: string }[] }
      expect(listed.enrollments.map((e) => e.userCode)).toEqual([start.userCode])
      expect((await post(b, `/api/enrollments/${start.userCode}/approve`, {}, admin.cookie)).status).toBe(204)
      const poll = (await (await post(a, "/spoke/enroll/poll", { deviceCode: start.deviceCode })).json()) as { status: string; machineID?: string }
      expect(poll.status).toBe("approved")
      expect(await (await post(b, "/spoke/enroll/poll", { deviceCode: start.deviceCode })).json()).toEqual({ status: "expired" })
      expect(b.store.machines().find((m) => m.id === poll.machineID)?.ownerID).toBe(admin.userID)
    })

    test("the enrollment limit counts both pods", async () => {
      const { a, b } = await pods(variant)
      for (let i = 0; i < 3; i++) expect((await post(a, "/spoke/enroll", { machineName: `a${i}` })).status).toBe(200)
      for (let i = 0; i < 2; i++) expect((await post(b, "/spoke/enroll", { machineName: `b${i}` })).status).toBe(200)
      expect((await post(a, "/spoke/enroll", { machineName: "a3" })).status).toBe(429)
    })

    test("an OIDC sign-in started on A finishes on B, once", async () => {
      const { a, b, idp } = await pods(variant)
      const login = await fetch(`${a.url}/auth/login?next=/s/ses_1`, { redirect: "manual" })
      expect(login.status).toBe(302)
      const oidcCookie = `voice_oidc=${setCookie(login, "voice_oidc")}`
      const { code, state } = idp.authorize(login.headers.get("location")!, { claims: { email: "alice@example.com", name: "Alice" } })
      const callback = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
      const done = await fetch(`${b.url}${callback}`, { redirect: "manual", headers: { cookie: oidcCookie } })
      expect(done.status).toBe(302)
      expect(done.headers.get("location")).toStartWith("/s/ses_1")
      expect(setCookie(done, "voice_device")).toBeTruthy()
      expect(a.store.userByEmail("alice@example.com")).toBeDefined()
      expect((await fetch(`${a.url}${callback}`, { redirect: "manual", headers: { cookie: oidcCookie } })).status).toBe(400)
    })

    test("a permission answered on A is gone on B (B asks no spoke)", async () => {
      const { a, b } = await pods(variant)
      const alice = await browser(a, "alice@example.com")
      const machine = await a.store.addMachine("laptop", alice.userID)
      const onA = await spoke(a, { machine, processID: "a", hello: { kind: "service" }, sessions: [session("ses_1")] })
      const onB = await spoke(b, { machine, processID: "b", sessions: [session("ses_1", { owned: true })] })
      const seenA = answer(onA, () => ({}))
      const seenB = answer(onB, () => ({}))
      const asked = { t: "event", event: { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash" } } } as const
      onA.send(asked)
      onB.send(asked)
      await waitFor(() => a.registry.permissionTarget("ses_1", "per_1") !== undefined && b.registry.permissionTarget("ses_1", "per_1") !== undefined)
      const body = { requestID: "per_1", decision: "once" }
      expect((await post(a, "/api/sessions/ses_1/permission", body, alice.cookie)).status).toBe(204)
      expect((await post(b, "/api/sessions/ses_1/permission", body, alice.cookie)).status).toBe(409)
      expect(seenA).toEqual([{ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" }])
      expect(seenB).toEqual([])
    })
  })
}
