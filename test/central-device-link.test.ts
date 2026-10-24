// App linking over HTTP: POST /api/devices/link (a signed-in user) issues a purpose-bound link code shown as a QR
// / hubapp:// deep link; POST /api/devices/redeem (public, called by a native app without cookie or Origin)
// trades it for a device token used as `Authorization: Bearer`.
import { afterEach, describe, expect, test } from "bun:test"
import { LINK_TTL_MS } from "../src/central/auth"
import { harness, PUBLIC, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const post = (json: unknown) => ({ method: "POST", json })
/** A native app: no cookie, no Origin. */
const app = (pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, cookie: null, origin: null })
const bearer = (pathname: string, token: string, init: RequestInit & { json?: unknown } = {}) =>
  app(pathname, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
const link = async () => (await json(await h.api("/api/devices/link", post({})))).code as string

describe("POST /api/devices/link", () => {
  test("issues a 5-minute link code with the hub URL and a hubapp:// deep link", async () => {
    let now = 5_000_000
    h = harness({ now: () => now })
    const res = await h.api("/api/devices/link", post({}))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await json(res)
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.expiresAt).toBe(now + LINK_TTL_MS)
    expect(body.hub).toBe(PUBLIC)
    expect(body.url).toBe(`hubapp://link?hub=${encodeURIComponent(PUBLIC)}&code=${body.code}`)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: "local", action: "device.link" })
  })

  test("needs a signed-in device: cookie (same-origin) or device token", async () => {
    h = harness()
    expect((await h.api("/api/devices/link", { ...post({}), cookie: null })).status).toBe(401)
    // Only redeem skips the same-origin check for credential-free requests.
    expect((await app("/api/devices/link", post({}))).status).toBe(403)
    expect((await h.api("/api/devices/link", { ...post({}), origin: "https://evil.example" })).status).toBe(403)
    const token = h.cookie.slice("voice_device=".length)
    expect((await bearer("/api/devices/link", token, post({}))).status).toBe(200)
  })
})

describe("POST /api/devices/redeem", () => {
  test("a native app (no cookie, no Origin) redeems a code for a device token; no cookie is set", async () => {
    h = harness()
    const code = await link()
    const res = await app("/api/devices/redeem", post({ code, deviceName: "Android (Pixel 9)" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await json(res)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.device).toMatchObject({ name: "Android (Pixel 9)" })
    expect(Object.keys(body.device).sort()).toEqual(["created", "id", "lastSeen", "name"])
    expect(h.store.findDevice(body.token)?.id).toBe(body.device.id)
    expect(h.store.auditLog()[0]).toMatchObject({ actor: "local", action: "device.pair", target: body.device.id, detail: "app link" })
  })

  test("the token works as a bearer on console and agent routes; revoking the device invalidates it", async () => {
    h = harness()
    const { token, device } = await json(await app("/api/devices/redeem", post({ code: await link(), deviceName: "phone" })))
    const me = await bearer("/api/me", token)
    expect(me.status).toBe(200)
    expect((await json(me)).device.id).toBe(device.id)
    const who = await bearer("/api/agent/whoami", token)
    expect(who.status).toBe(200)
    expect((await json(who)).actor).toEqual({ kind: "user", userID: "local", deviceID: device.id, via: "device-token" })
    expect((await h.api(`/api/devices/${device.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await bearer("/api/me", token)).status).toBe(401)
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
  })

  test("single use", async () => {
    h = harness()
    const code = await link()
    expect((await app("/api/devices/redeem", post({ code, deviceName: "a" }))).status).toBe(200)
    const again = await app("/api/devices/redeem", post({ code, deviceName: "b" }))
    expect(again.status).toBe(401)
    expect((await json(again)).error).toMatch(/invalid or expired link code/i)
  })

  test("expires after 5 minutes", async () => {
    let now = 5_000_000
    h = harness({ now: () => now })
    const code = await link()
    now += LINK_TTL_MS + 1
    expect((await app("/api/devices/redeem", post({ code, deviceName: "a" }))).status).toBe(401)
  })

  test("a disabled owner's code does not redeem", async () => {
    h = harness()
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${h.store.addDevice("bob laptop", bob.id).token}`
    const code = (await json(await h.api("/api/devices/link", { ...post({}), cookie }))).code
    h.store.setUser(bob.id, { disabled: true })
    expect((await app("/api/devices/redeem", post({ code, deviceName: "a" }))).status).toBe(401)
    expect(h.store.devices().filter((d) => d.ownerID === bob.id)).toHaveLength(1)
  })

  test("the device belongs to the user who issued the code", async () => {
    h = harness()
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${h.store.addDevice("bob laptop", bob.id).token}`
    const code = (await json(await h.api("/api/devices/link", { ...post({}), cookie }))).code
    const { device } = await json(await app("/api/devices/redeem", post({ code })))
    expect(h.store.devices().find((d) => d.id === device.id)?.ownerID).toBe(bob.id)
  })

  test("sanitises the device name and stores an optional public key", async () => {
    h = harness()
    const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(88)
    const noName = await json(await app("/api/devices/redeem", post({ code: await link() })))
    expect(noName.device.name).toBe("App")
    const long = await json(await app("/api/devices/redeem", post({ code: await link(), deviceName: ` ${"y".repeat(100)}\u0007`, publicKey: KEY })))
    expect(long.device.name).toBe("y".repeat(64))
    expect(h.store.devices().find((d) => d.id === long.device.id)?.publicKey).toBe(KEY)
    const bad = await app("/api/devices/redeem", post({ code: await link(), publicKey: "<script>" }))
    expect(bad.status).toBe(400)
  })

  test("a foreign Origin or a cross-origin cookie request is still refused", async () => {
    h = harness()
    const code = await link()
    expect((await h.api("/api/devices/redeem", { ...post({ code }), cookie: null, origin: "https://evil.example" })).status).toBe(403)
    expect((await h.api("/api/devices/redeem", { ...post({ code }), origin: null })).status).toBe(403)
    // The code survived both refusals.
    expect((await app("/api/devices/redeem", post({ code }))).status).toBe(200)
  })

  test("other public writes keep requiring same-origin", async () => {
    h = harness()
    const { code } = h.auth.issuePairCode()
    expect((await app("/api/pair", post({ code, deviceName: "p" }))).status).toBe(403)
  })
})

describe("link codes are purpose-bound", () => {
  test("not redeemable at /api/pair or /login", async () => {
    h = harness()
    const code = await link()
    expect((await h.api("/api/pair", { ...post({ code, deviceName: "p" }), cookie: null })).status).toBe(401)
    expect((await h.api(`/login?code=${code}`, { cookie: null })).status).toBe(401)
    // Neither attempt spent it.
    expect((await app("/api/devices/redeem", post({ code }))).status).toBe(200)
  })

  test("pairing and login codes are not redeemable as link codes", async () => {
    h = harness()
    expect((await app("/api/devices/redeem", post({ code: h.auth.issuePairCode().code }))).status).toBe(401)
    expect((await app("/api/devices/redeem", post({ code: h.auth.issueLoginCode().code }))).status).toBe(401)
  })
})
