// The CLI login over HTTP: POST /cli/login and /cli/login/poll (no credential: the device code is the poller's
// secret), and the approval routes for a signed-in user's device (GET /api/cli-logins/:code, POST …/approve with the
// scopes they chose, POST …/deny). An approved login is an app token of the approver, with those scopes, handed out
// once; it is never logged.
import { afterEach, describe, expect, test } from "bun:test"
import { harness, type Harness } from "./central-harness"

let h: Harness | undefined
afterEach(() => {
  h?.stop()
  h = undefined
})

const post = (json: unknown) => ({ method: "POST", json, cookie: null, origin: null })

async function start(central: Harness, body: unknown = { clientName: "laptop" }) {
  const res = await central.api("/cli/login", post(body))
  expect(res.status).toBe(200)
  return (await res.json()) as { userCode: string; deviceCode: string; approveURL: string; intervalMs: number; expiresAt: number; scopes: string[] }
}

const poll = async (central: Harness, deviceCode: string) => {
  const res = await central.api("/cli/login/poll", post({ deviceCode }))
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as any }
}

describe("CLI login over HTTP", () => {
  test("start → the approval page reads it → approve with chosen scopes → an app token of the approver, once", async () => {
    h = await harness()
    const logs: string[] = []
    const keep = { log: console.log, error: console.error, warn: console.warn }
    console.log = console.error = console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "))
    try {
      const login = await start(h, { clientName: "laptop", scopes: ["sessions:launch"] })
      expect(login.approveURL).toBe(`http://voice.test/approve?code=${login.userCode}`)
      expect(login.scopes).toEqual(["sessions:read", "messages:send", "messages:read", "sessions:launch"])
      expect((await poll(h, login.deviceCode)).body).toEqual({ status: "pending" })

      const view = await h.api(`/api/cli-logins/${login.userCode}`)
      expect(view.status).toBe(200)
      expect(await view.json()).toEqual({ login: { userCode: login.userCode, clientName: "laptop", scopes: login.scopes, created: expect.any(Number), expiresAt: login.expiresAt } })

      expect((await h.api(`/api/cli-logins/${login.userCode}/approve`, { method: "POST", json: { scopes: ["sessions:read", "sessions:launch"] } })).status).toBe(204)
      const approved = await poll(h, login.deviceCode)
      expect(approved.status).toBe(200)
      expect(approved.cache).toBe("no-store")
      expect(approved.body).toEqual({ status: "approved", token: expect.stringMatching(/^hat_[0-9a-f]{16}_/), tokenID: expect.stringMatching(/^[0-9a-f]{16}$/), scopes: ["sessions:read", "sessions:launch"] })
      expect((await poll(h, login.deviceCode)).body).toEqual({ status: "expired" })

      const who = await fetch(`${h.url}/api/agent/whoami`, { headers: { authorization: `Bearer ${approved.body.token}` } })
      expect(await who.json()).toMatchObject({ actor: { kind: "app", userID: "local", tokenID: approved.body.tokenID, scopes: ["sessions:read", "sessions:launch"], label: "CLI login: laptop" } })
      const actions = h.store.auditLog().map((e) => e.action)
      expect(actions).toContain("cli-login.approve")
      expect(actions).toContain("app-token.create")
      expect(logs.join("\n")).not.toContain(approved.body.token)
      expect(JSON.stringify(h.store.auditLog())).not.toContain(approved.body.token)
    } finally {
      Object.assign(console, keep)
    }
  })

  test("deny: the poll says denied once, no token is made", async () => {
    h = await harness()
    const login = await start(h)
    expect((await h.api(`/api/cli-logins/${login.userCode}/deny`, { method: "POST", json: {} })).status).toBe(204)
    expect((await poll(h, login.deviceCode)).body).toEqual({ status: "denied" })
    expect((await poll(h, login.deviceCode)).body).toEqual({ status: "expired" })
    expect(h.store.agentData("local").appTokens ?? []).toEqual([])
  })

  test("approval is for a signed-in user's device only: no credential, an app token, a cross-origin cookie", async () => {
    h = await harness()
    const login = await start(h)
    const url = `/api/cli-logins/${login.userCode}/approve`
    expect((await h.api(url, { method: "POST", json: { scopes: ["sessions:read"] }, cookie: null })).status).toBe(401)
    expect((await h.api(url, { method: "POST", json: { scopes: ["sessions:read"] }, origin: "https://evil.example" })).status).toBe(403)
    const app = (await (await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:read"] } })).json()) as { token: string }
    const asApp = await fetch(`${h.url}${url}`, { method: "POST", headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: ["sessions:read"] }) })
    expect(asApp.status).toBe(403)
    const readAsApp = await fetch(`${h.url}/api/cli-logins/${login.userCode}`, { headers: { authorization: `Bearer ${app.token}` } })
    expect(readAsApp.status).toBe(403)
    expect((await poll(h, login.deviceCode)).body).toEqual({ status: "pending" })
  })

  test("another user approves: the token is theirs", async () => {
    h = await harness()
    const user = await h.store.upsertUser({ email: "b@example.com", role: "user" })
    const cookie = `voice_device=${(await h.store.addDevice("b phone", user.id)).token}`
    const login = await start(h)
    expect((await h.api(`/api/cli-logins/${login.userCode}/approve`, { method: "POST", json: { scopes: ["sessions:read"] }, cookie })).status).toBe(204)
    const approved = (await poll(h, login.deviceCode)).body
    const who = (await (await fetch(`${h.url}/api/agent/whoami`, { headers: { authorization: `Bearer ${approved.token}` } })).json()) as any
    expect(who.actor).toMatchObject({ kind: "app", userID: user.id })
  })

  test("an approver disabled before the poll gets no token", async () => {
    h = await harness()
    const user = await h.store.upsertUser({ email: "c@example.com", role: "user" })
    const cookie = `voice_device=${(await h.store.addDevice("c phone", user.id)).token}`
    const login = await start(h)
    expect((await h.api(`/api/cli-logins/${login.userCode}/approve`, { method: "POST", json: { scopes: ["sessions:read"] }, cookie })).status).toBe(204)
    await h.store.setUser(user.id, { disabled: true })
    expect((await poll(h, login.deviceCode)).body).toEqual({ status: "denied" })
    expect(h.store.agentData(user.id).appTokens ?? []).toEqual([])
  })

  test("bad input and unknown codes", async () => {
    h = await harness()
    expect((await h.api("/cli/login", post({ clientName: "" }))).status).toBe(400)
    expect((await h.api("/cli/login", post({ clientName: "x", scopes: ["root"] }))).status).toBe(400)
    expect((await h.api("/cli/login", { method: "POST", body: "{bad", cookie: null, origin: null })).status).toBe(400)
    expect((await poll(h, "nope")).body).toEqual({ status: "expired" })
    expect((await h.api("/api/cli-logins/BBBB-BBBB")).status).toBe(404)
    expect((await h.api("/api/cli-logins/BBBB-BBBB/approve", { method: "POST", json: { scopes: ["sessions:read"] } })).status).toBe(404)
    expect((await h.api("/api/cli-logins/BBBB-BBBB/deny", { method: "POST", json: {} })).status).toBe(404)
    const login = await start(h)
    expect((await h.api(`/api/cli-logins/${login.userCode}/approve`, { method: "POST", json: { scopes: [] } })).status).toBe(400)
    expect((await h.api(`/api/cli-logins/${login.userCode}/approve`, { method: "POST", json: { scopes: ["root"] } })).status).toBe(400)
    // A machine enrollment's code is not a CLI login.
    const enroll = (await (await h.api("/spoke/enroll", post({ machineName: "m" }))).json()) as { userCode: string }
    expect((await h.api(`/api/cli-logins/${enroll.userCode}`)).status).toBe(404)
  })

  test("start is rate limited", async () => {
    h = await harness()
    for (let i = 0; i < 5; i++) await start(h, { clientName: `m${i}` })
    expect((await h.api("/cli/login", post({ clientName: "m" }))).status).toBe(429)
  })
})
