// Local hub (public URL on loopback): every loopback name is the same origin for CSRF checks, cookies
// carry no Secure flag over http, and the very first machine enrolling from loopback is approved.
import { afterEach, describe, expect, test } from "bun:test"
import { localAutoApprove } from "../src/central/http"
import { harness, type Harness } from "./central-harness"

const running: Harness[] = []
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop()
})

/** A hub on 127.0.0.1 with its public URL on the same loopback origin. */
function local(): Harness {
  const h = harness({ env: { VOICE_HOST: "127.0.0.1", VOICE_PUBLIC_URL: "" } })
  running.push(h)
  return h
}

const port = (h: Harness) => new URL(h.url).port

describe("loopback origins", () => {
  test("a loopback public URL accepts localhost, 127.0.0.1 and [::1] on the same port", async () => {
    const h = local()
    expect(h.publicURL).toBe(`http://127.0.0.1:${port(h)}`)
    for (const origin of [`http://localhost:${port(h)}`, `http://127.0.0.1:${port(h)}`, `http://[::1]:${port(h)}`]) {
      const res = await h.api("/api/push/prefs", { method: "PUT", json: { finished: true }, origin })
      expect(res.status).toBe(200)
    }
  })

  test("other ports, schemes and hosts are still refused", async () => {
    const h = local()
    const other = String(Number(port(h)) + 1)
    for (const origin of [`http://localhost:${other}`, `https://localhost:${port(h)}`, "http://evil.example", "null"]) {
      const res = await h.api("/api/push/prefs", { method: "PUT", json: { finished: true }, origin })
      expect(res.status).toBe(403)
    }
  })

  test("a Referer on another loopback name counts when no Origin is sent", async () => {
    const h = local()
    const res = await h.api("/api/push/prefs", {
      method: "PUT",
      json: { finished: true },
      origin: null,
      headers: { referer: `http://localhost:${port(h)}/s/ses_1` },
    })
    expect(res.status).toBe(200)
  })

  test("a public (non-loopback) URL does not accept loopback origins", async () => {
    const h = harness()
    running.push(h)
    const res = await h.api("/api/push/prefs", { method: "PUT", json: { finished: true }, origin: `http://localhost:${port(h)}` })
    expect(res.status).toBe(403)
  })

  test("pairing on localhost sets a cookie without Secure that works on the next request", async () => {
    const h = local()
    const origin = `http://localhost:${port(h)}`
    const { code } = h.auth.issuePairCode()
    const res = await h.api("/api/pair", { method: "POST", json: { code, deviceName: "laptop" }, origin, cookie: null })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).not.toContain("Secure")
    const cookie = setCookie.split(";")[0]!
    const me = await h.api("/api/push/prefs", { method: "PUT", json: { say: false }, origin, cookie })
    expect(me.status).toBe(200)
  })
})

describe("first machine on a local hub", () => {
  const enroll = (h: Harness, headers: Record<string, string> = {}, base = h.url) =>
    fetch(`${base}/spoke/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ machineName: "laptop" }),
    }).then((r) => r.json() as Promise<Record<string, any>>)
  const poll = (h: Harness, deviceCode: string) =>
    fetch(`${h.url}/spoke/enroll/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    }).then((r) => r.json() as Promise<Record<string, any>>)
  const fresh = (env: Record<string, string> = {}) => {
    const h = harness({ noDevice: true, env: { VOICE_HOST: "127.0.0.1", VOICE_PUBLIC_URL: "", ...env } })
    running.push(h)
    return h
  }

  test("is approved at once when the hub binds to loopback, the request is from loopback, and nothing is enrolled or paired", async () => {
    const h = fresh()
    const start = await enroll(h)
    expect(start.autoApproved).toBe(true)
    const first = await poll(h, start.deviceCode)
    expect(first).toMatchObject({ status: "approved", machineID: expect.any(String), machineToken: expect.any(String) })
    expect(h.store.machines()).toHaveLength(1)
  })

  test("a second machine is not auto-approved, before or after the first one picked up its token", async () => {
    const h = fresh()
    const a = await enroll(h)
    const b = await enroll(h)
    expect(a.autoApproved).toBe(true)
    expect(b.autoApproved).toBeUndefined()
    expect((await poll(h, b.deviceCode)).status).toBe("pending")
    expect((await poll(h, a.deviceCode)).status).toBe("approved")
    const c = await enroll(h)
    expect(c.autoApproved).toBeUndefined()
    expect((await poll(h, c.deviceCode)).status).toBe("pending")
    expect(h.auth.pendingEnrollments().map((e) => e.userCode).sort()).toEqual([b.userCode, c.userCode].sort())
  })

  test("not when a device is already paired", async () => {
    const h = fresh()
    h.store.addDevice("phone")
    const start = await enroll(h)
    expect(start.autoApproved).toBeUndefined()
    expect((await poll(h, start.deviceCode)).status).toBe("pending")
  })

  test("not when the request was forwarded by a proxy", async () => {
    const h = fresh()
    const headers: Array<Record<string, string>> = [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }]
    for (const header of headers) {
      const start = await enroll(h, header)
      expect(start.autoApproved).toBeUndefined()
    }
    expect(h.store.machines()).toHaveLength(0)
  })

  test("not when the public URL is not loopback (a hub behind a reverse proxy)", async () => {
    const h = fresh({ VOICE_PUBLIC_URL: "https://voice.example.com" })
    const start = await enroll(h)
    expect(start.autoApproved).toBeUndefined()
    expect(start.approveURL).toStartWith("https://voice.example.com/approve?code=")
  })

  test("not when the hub listens on every interface", async () => {
    const h = fresh({ VOICE_HOST: "0.0.0.0", VOICE_PUBLIC_URL: "http://127.0.0.1:4999" })
    const start = await enroll(h, {}, `http://127.0.0.1:${port(h)}`)
    expect(start.autoApproved).toBeUndefined()
  })
})

describe("localAutoApprove", () => {
  const base = { host: "127.0.0.1", publicURL: "http://127.0.0.1:4097", peer: "127.0.0.1", forwarded: false, machines: 0, devices: 0, used: false }

  test("needs every condition", () => {
    expect(localAutoApprove(base)).toBe(true)
    expect(localAutoApprove({ ...base, host: "localhost", publicURL: "http://localhost:4097", peer: "::1" })).toBe(true)
    expect(localAutoApprove({ ...base, peer: "192.168.1.20" })).toBe(false)
    expect(localAutoApprove({ ...base, peer: undefined })).toBe(false)
    expect(localAutoApprove({ ...base, host: "0.0.0.0" })).toBe(false)
    expect(localAutoApprove({ ...base, publicURL: "https://voice.example.com" })).toBe(false)
    expect(localAutoApprove({ ...base, forwarded: true })).toBe(false)
    expect(localAutoApprove({ ...base, machines: 1 })).toBe(false)
    expect(localAutoApprove({ ...base, devices: 1 })).toBe(false)
    expect(localAutoApprove({ ...base, used: true })).toBe(false)
  })
})
