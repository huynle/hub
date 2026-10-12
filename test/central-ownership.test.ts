// Ownership (multi-user hub): who owns machines and devices created by enrollment, pairing codes and
// login links, and what a disabled user can still do.
import { afterEach, describe, expect, test } from "bun:test"
import { LOCAL_USER } from "../src/central/store"
import { connect, harness, hello, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, signIn, type FakeProvider } from "./oidc-fake"

let h: Harness | undefined
let idp: FakeProvider | undefined
afterEach(async () => {
  await h?.stop()
  idp?.stop()
  h = idp = undefined
})

function oidcHub(env: Record<string, string> = {}): Harness {
  idp = fakeProvider()
  h = harness({ env: oidcEnv(idp, env), noDevice: true })
  return h
}

const post = (json: unknown) => ({ method: "POST", json })
const userOf = async (hub: Harness, cookie: string) => ((await (await hub.api("/api/me", { cookie })).json()) as any).user

async function enroll(hub: Harness, name = "laptop") {
  const start = (await (await hub.api("/spoke/enroll", { ...post({ machineName: name }), cookie: null, origin: null })).json()) as any
  const poll = () => hub.api("/spoke/enroll/poll", { ...post({ deviceCode: start.deviceCode }), cookie: null, origin: null }).then((r) => r.json() as any)
  return { start, poll }
}

describe("enrollment", () => {
  test("the approving user owns the machine; approve and deny are audited", async () => {
    const hub = oidcHub()
    const alice = await signIn(hub.url, idp!, "alice@example.com")
    const aliceID = (await userOf(hub, alice.cookie!)).id
    const { start, poll } = await enroll(hub)
    expect((await hub.api(`/api/enrollments/${start.userCode}/approve`, { method: "POST", cookie: alice.cookie })).status).toBe(204)
    const approved = await poll()
    expect(hub.store.machines().find((m) => m.id === approved.machineID)?.ownerID).toBe(aliceID)
    expect(hub.store.auditLog()[0]).toMatchObject({ actor: aliceID, action: "machine.approve", detail: "laptop" })
    const second = await enroll(hub, "desk")
    expect((await hub.api(`/api/enrollments/${second.start.userCode}/deny`, { method: "POST", cookie: alice.cookie })).status).toBe(204)
    expect(hub.store.auditLog()[0]).toMatchObject({ actor: aliceID, action: "machine.deny", detail: "desk" })
    expect(JSON.stringify(hub.store.auditLog())).not.toContain(start.userCode)
  })

  test("pairing mode: the local owner owns approved machines", async () => {
    h = harness()
    const { start, poll } = await enroll(h)
    await h.api(`/api/enrollments/${start.userCode}/approve`, { method: "POST" })
    const approved = await poll()
    expect(h.store.machines().find((m) => m.id === approved.machineID)?.ownerID).toBe(LOCAL_USER)
  })

  test("oidc mode: no loopback auto-approve and no bootstrap pairing code", async () => {
    idp = fakeProvider()
    h = harness({ env: oidcEnv(idp, { VOICE_HOST: "127.0.0.1", VOICE_PUBLIC_URL: "" }), noDevice: true })
    const { start, poll } = await enroll(h)
    expect(start.autoApproved).toBeUndefined()
    expect(await poll()).toEqual({ status: "pending" })
    expect(h.auth.bootstrapCode()).toBeUndefined()
  })

  test("pairing mode keeps loopback auto-approve and the bootstrap code", async () => {
    h = harness({ env: { VOICE_HOST: "127.0.0.1", VOICE_PUBLIC_URL: "" }, noDevice: true })
    expect(h.auth.bootstrapCode()).toBeDefined()
    const { start } = await enroll(h)
    expect(start.autoApproved).toBe(true)
  })
})

describe("spoke pairing codes and login links", () => {
  test("pairCode from a spoke pairs a device for the machine's owner (audited)", async () => {
    const hub = oidcHub()
    const bob = hub.store.upsertUser({ email: "bob@example.com", role: "user" })
    const { token } = hub.store.addMachine("bob laptop", bob.id)
    const client = await connect(hub, token)
    client.send(hello("p1"))
    await client.next((f) => f.t === "welcome")
    client.send({ t: "req", id: "r1", req: { op: "pairCode" } })
    const { result } = await client.next((f) => f.t === "res" && f.id === "r1")
    const res = await hub.api("/api/pair", { ...post({ code: result.code, deviceName: "bob phone" }), cookie: null })
    expect(res.status).toBe(200)
    const device = hub.store.devices().find((d) => d.name === "bob phone")!
    expect(device.ownerID).toBe(bob.id)
    expect(hub.store.auditLog()[0]).toMatchObject({ actor: bob.id, action: "device.pair", target: device.id })
    client.close()
  })

  test("openLink signs a browser in as the machine's owner, replacing another user's cookie", async () => {
    const hub = oidcHub()
    const alice = await signIn(hub.url, idp!, "alice@example.com")
    const bob = hub.store.upsertUser({ email: "bob@example.com", role: "user" })
    const { token } = hub.store.addMachine("bob laptop", bob.id)
    const client = await connect(hub, token)
    client.send(hello("p1"))
    await client.next((f) => f.t === "welcome")
    client.send({ t: "req", id: "r2", req: { op: "openLink" } })
    const { result } = await client.next((f) => f.t === "res" && f.id === "r2")
    const link = new URL(result.url)
    // A browser already signed in as alice follows bob's link: it becomes bob's device.
    const res = await hub.api(`${link.pathname}${link.search}`, { cookie: alice.cookie })
    expect(res.status).toBe(302)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!
    expect((await userOf(hub, cookie)).id).toBe(bob.id)
    // alice's own device is untouched
    expect((await userOf(hub, alice.cookie!)).email).toBe("alice@example.com")
    client.close()
  })

  test("openLink with a cookie of the same owner keeps the device", async () => {
    h = harness()
    const client = await connect(h, h.store.addMachine("m").token)
    client.send(hello("p1"))
    await client.next((f) => f.t === "welcome")
    client.send({ t: "req", id: "r3", req: { op: "openLink" } })
    const { result } = await client.next((f) => f.t === "res" && f.id === "r3")
    const link = new URL(result.url)
    const res = await h.api(`${link.pathname}${link.search}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("set-cookie")).toBeNull()
    client.close()
  })
})

describe("disabled users", () => {
  test("their devices get 401 and their machines cannot connect", async () => {
    const hub = oidcHub()
    const alice = await signIn(hub.url, idp!, "alice@example.com")
    const aliceID = (await userOf(hub, alice.cookie!)).id
    const { token } = hub.store.addMachine("alice laptop", aliceID)
    hub.store.setUser(aliceID, { disabled: true })
    expect((await hub.api("/api/me", { cookie: alice.cookie })).status).toBe(401)
    expect((await hub.api("/api/machines", { cookie: alice.cookie })).status).toBe(401)
    await expect(connect(hub, token)).rejects.toThrow()
    const res = await fetch(`${hub.url}/spoke/ws`, { headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } })
    expect(res.status).toBe(401)
  })

  test("pairing codes and login links issued for a disabled owner are refused", async () => {
    const hub = oidcHub()
    const bob = hub.store.upsertUser({ email: "bob@example.com", role: "user" })
    const pair = hub.auth.issuePairCode(bob.id)
    const login = hub.auth.issueLoginCode(bob.id)
    hub.store.setUser(bob.id, { disabled: true })
    expect((await hub.api("/api/pair", { ...post({ code: pair.code, deviceName: "x" }), cookie: null })).status).toBe(401)
    expect((await hub.api(`/login?code=${login.code}&next=/`, { cookie: null })).status).toBe(401)
    expect(hub.store.devices().length).toBe(0)
  })
})
