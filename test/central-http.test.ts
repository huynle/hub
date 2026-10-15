import { afterEach, describe, expect, test } from "bun:test"
import { OpenRouterError } from "../src/openrouter"
import { connect, harness, hello, PUBLIC, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const post = (json: unknown) => ({ method: "POST", json })

describe("health and auth", () => {
  test("healthz needs no auth", async () => {
    h = harness()
    const res = await h.api("/healthz", { cookie: null })
    expect(await res.json()).toEqual({ ok: true, version: "9.9.9", spokes: 0 })
  })

  test("/api/* requires the device cookie even from 127.0.0.1", async () => {
    h = harness()
    for (const path of ["/api/me", "/api/machines", "/api/events", "/api/devices", "/api/enrollments"]) {
      const res = await h.api(path, { cookie: null })
      expect(res.status).toBe(401)
      expect(((await res.json()) as any).error).toBeTruthy()
    }
    expect((await h.api("/api/me", { cookie: "voice_device=forged" })).status).toBe(401)
    expect((await h.api("/api/sessions/ses_1/turn", { ...post({ text: "x" }), cookie: null })).status).toBe(401)
    const me = (await (await h.api("/api/me")).json()) as any
    expect(me.device).toMatchObject({ name: "test phone" })
    expect(me.device.tokenHash).toBeUndefined()
  })

  test("cookie POST/DELETE needs a same-origin Origin or Referer", async () => {
    h = harness()
    const start = (await (await h.api("/spoke/enroll", { ...post({ machineName: "m" }), cookie: null, origin: null })).json()) as any
    const url = `/api/enrollments/${start.userCode}/approve`
    expect((await h.api(url, { method: "POST", origin: null })).status).toBe(403)
    expect((await h.api(url, { method: "POST", origin: "http://evil.test" })).status).toBe(403)
    expect((await h.api(url, { method: "POST", origin: null, headers: { referer: "http://evil.test/approve" } })).status).toBe(403)
    expect((await h.api(url, { method: "POST", origin: null, headers: { referer: `${PUBLIC}/approve?code=x` } })).status).toBe(204)
  })
})

describe("machine enrollment over HTTP", () => {
  test("start → pending → owner approves → token once → token works on the WebSocket", async () => {
    h = harness()
    const events = await h.api("/api/events")
    const startRes = await h.api("/spoke/enroll", { ...post({ machineName: "laptop" }), cookie: null, origin: null })
    expect(startRes.status).toBe(200)
    const start = (await startRes.json()) as any
    expect(start.approveURL).toBe(`${PUBLIC}/approve?code=${start.userCode}`)
    const poll = () => h.api("/spoke/enroll/poll", { ...post({ deviceCode: start.deviceCode }), cookie: null, origin: null }).then((r) => r.json() as any)
    expect(await poll()).toEqual({ status: "pending" })
    const list = (await (await h.api("/api/enrollments")).json()) as any
    expect(list.enrollments).toEqual([{ userCode: start.userCode, machineName: "laptop", created: expect.any(Number), expiresAt: start.expiresAt }])
    expect((await h.api(`/api/enrollments/${start.userCode}/approve`, { method: "POST" })).status).toBe(204)
    const approved = await poll()
    const { machineID, machineToken } = approved
    expect(approved.status).toBe("approved")
    expect(machineID).toMatch(/^mch_/)
    expect(await poll()).toEqual({ status: "expired" })
    const client = await connect(h, machineToken)
    client.send(hello("p1"))
    expect((await client.next()).machineID).toBe(machineID)
    client.close()
    await events.body?.cancel()
  })

  test("deny, unknown code 404, invalid name 400", async () => {
    h = harness()
    const start = (await (await h.api("/spoke/enroll", { ...post({ machineName: "laptop" }), cookie: null })).json()) as any
    expect((await h.api(`/api/enrollments/${start.userCode}/deny`, { method: "POST" })).status).toBe(204)
    const poll = await h.api("/spoke/enroll/poll", { ...post({ deviceCode: start.deviceCode }), cookie: null })
    expect(await poll.json()).toEqual({ status: "denied" })
    expect((await h.api(`/api/enrollments/BBBB-BBBB/approve`, { method: "POST" })).status).toBe(404)
    expect((await h.api("/spoke/enroll", { ...post({ machineName: "" }), cookie: null })).status).toBe(400)
    expect((await h.api("/spoke/enroll", { method: "POST", body: "{bad", cookie: null })).status).toBe(400)
  })

  test("enroll start is rate limited", async () => {
    h = harness()
    for (let i = 0; i < 5; i++) await h.api("/spoke/enroll", { ...post({ machineName: `m${i}` }), cookie: null })
    expect((await h.api("/spoke/enroll", { ...post({ machineName: "m" }), cookie: null })).status).toBe(429)
  })
})

describe("devices", () => {
  test("pair rejects bad codes and rate limits failed attempts", async () => {
    h = harness()
    for (let i = 0; i < 10; i++) {
      expect((await h.api("/api/pair", { ...post({ code: "999999x", deviceName: "p" }), cookie: null })).status).toBe(401)
    }
    const { code } = h.auth.issuePairCode()
    expect((await h.api("/api/pair", { ...post({ code, deviceName: "p" }), cookie: null })).status).toBe(429)
  })

  test("pair cookie is Secure when the public URL is https", async () => {
    h = harness({ env: { HUB_PUBLIC_URL: "https://voice.example.com" } })
    const { code } = h.auth.issuePairCode()
    const res = await h.api("/api/pair", { ...post({ code, deviceName: "p" }), cookie: null, origin: "https://voice.example.com" })
    expect(res.headers.get("set-cookie")).toContain("; Secure")
  })

  test("list, delete, logout", async () => {
    h = harness()
    const other = h.store.addDevice("tablet")
    const list = (await (await h.api("/api/devices")).json()) as any
    expect(list.devices.map((d: any) => [d.name, d.current])).toEqual([
      ["test phone", true],
      ["tablet", false],
    ])
    expect(list.devices[0].tokenHash).toBeUndefined()
    expect((await h.api(`/api/devices/${other.device.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await h.api(`/api/devices/${other.device.id}`, { method: "DELETE" })).status).toBe(404)
    const logout = await h.api("/api/logout", { method: "POST" })
    expect(logout.status).toBe(204)
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await h.api("/api/me")).status).toBe(401)
  })

  test("machines list includes offline enrolled machines; unknown revoke is 404", async () => {
    h = harness()
    h.store.addMachine("offline box")
    const body = (await (await h.api("/api/machines")).json()) as any
    expect(body.machines).toEqual([expect.objectContaining({ name: "offline box", online: false, processes: [] })])
    expect((await h.api("/api/machines/mch_nope", { method: "DELETE" })).status).toBe(404)
  })
})

describe("login links", () => {
  test("rejects off-site or odd next targets", async () => {
    h = harness()
    for (const next of ["//evil.test/s/x", "https://evil.test/", "/api/me", "/\\evil.test", "s/x"]) {
      const { code } = h.auth.issueLoginCode()
      const res = await h.api(`/login?code=${code}&next=${encodeURIComponent(next)}`, { cookie: null, origin: null })
      expect(res.status).toBe(400)
      expect(res.headers.get("set-cookie")).toBeNull()
    }
    const { code } = h.auth.issueLoginCode()
    const ok = await h.api(`/login?code=${code}&next=/`, { cookie: null, origin: null })
    expect(ok.status).toBe(302)
    expect(ok.headers.get("location")).toBe("/#speech") // this hub has no speech key yet
  })
})

describe("static files", () => {
  test("app routes serve index.html; sw.js headers; traversal and missing files are 404", async () => {
    h = harness()
    for (const path of ["/", "/s/ses_1", "/pair", "/approve"]) {
      const res = await h.api(path, { cookie: null })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(await res.text()).toContain("<title>voice</title>")
    }
    const sw = await h.api("/sw.js", { cookie: null })
    expect(sw.headers.get("cache-control")).toBe("no-cache")
    expect(sw.headers.get("service-worker-allowed")).toBe("/")
    expect(sw.headers.get("content-type")).toContain("javascript")
    expect((await h.api("/manifest.webmanifest", { cookie: null })).headers.get("content-type")).toContain("manifest+json")
    expect((await h.api("/app.js", { cookie: null })).status).toBe(200)
    for (const path of ["/missing.js", "/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/.%2e/src/central/store.ts", "/foo/../../package.json"]) {
      expect((await fetch(`${h.url}${path}`)).status).toBe(404)
    }
  })
})

describe("speech", () => {
  test("transcribe maps content type, enforces size and type", async () => {
    h = harness({ env: { HUB_MAX_AUDIO_BYTES: "100" } })
    const audio = (type: string, size: number) => h.api("/api/transcribe", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(size) })
    const ok = await audio("audio/webm;codecs=opus", 10)
    expect(await ok.json()).toEqual({ text: "heard 10 webm" })
    expect((await audio("text/plain", 10)).status).toBe(415)
    expect((await audio("audio/webm", 101)).status).toBe(413)
    expect((await audio("audio/webm", 0)).status).toBe(400)
  })

  test("speak makes the text speakable and capped; OpenRouter errors are 502", async () => {
    h = harness({ env: { HUB_MAX_SPEECH_CHARS: "20" } })
    const res = await h.api("/api/speak", post({ text: "**Hello** there, this is a long reply" }))
    expect(res.headers.get("content-type")).toBe("audio/mpeg")
    expect(await res.text()).toBe("mp3:Hello there, this…")
    expect((await h.api("/api/speak", post({ text: "```x```" }))).status).toBe(200)
    expect((await h.api("/api/speak", post({ text: "" }))).status).toBe(400)
    await h.stop()
    h = harness({
      speech: {
        transcribe: async () => "",
        speak: async () => {
          throw new OpenRouterError("OpenRouter speech failed (500): nope", 500)
        },
      },
    })
    expect((await h.api("/api/speak", post({ text: "hi" }))).status).toBe(502)
  })
})
