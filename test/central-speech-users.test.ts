// Per-user speech settings (multi-user hub): precedence user → server default → hub.json → env; each
// user's keys stay theirs; admins manage the server default; speech requests use the caller's settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { harness, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, signIn, type FakeProvider } from "./oidc-fake"

const ALICE_KEY = "sk-alice-0000111122223333ALICE"
const ENV_KEY = "sk-env-0000111122223333ENVKEY"

interface Call {
  url: string
  headers: Record<string, string>
}

let h: Harness
let idp: FakeProvider
let calls: Call[]
let alice: string
let bob: string
let admin: string

beforeEach(async () => {
  calls = []
  idp = fakeProvider()
  h = harness({
    speech: undefined,
    noDevice: true,
    env: oidcEnv(idp, { OPENROUTER_API_KEY: ENV_KEY }),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: Object.fromEntries([...(new Headers(init?.headers) as unknown as Iterable<[string, string]>)]) })
      if (String(url).endsWith("/models") || String(url).includes("/models?")) return Response.json({ data: [{ id: "m1", name: "Model 1" }] })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })
    }) as unknown as typeof globalThis.fetch,
  })
  alice = (await signIn(h.url, idp, "alice@example.com")).cookie!
  bob = (await signIn(h.url, idp, "bob@example.com")).cookie!
  admin = (await signIn(h.url, idp, "admin@example.com")).cookie!
})

afterEach(async () => {
  await h?.stop()
  idp?.stop()
})

const get = async (cookie: string, path: string) => {
  const res = await h.api(path, { cookie })
  return { status: res.status, body: (await res.json()) as any }
}
const put = async (cookie: string, path: string, json: unknown) => {
  const res = await h.api(path, { method: "PUT", json, cookie })
  return { status: res.status, body: (await res.json()) as any }
}

describe("GET/PUT /api/settings/speech (per user)", () => {
  test("view has scope user, the masked default and the user's own fields", async () => {
    const { status, body } = await get(alice, "/api/settings/speech")
    expect(status).toBe(200)
    expect(body.scope).toBe("user")
    expect(body.default.stt.model).toBe("openai/gpt-4o-mini-transcribe")
    expect(body.default.voiceHints).toBeUndefined()
    expect(body.default.ready).toBeUndefined()
    expect(body.user).toEqual({ stt: {}, tts: {} })
    // the env key is inherited: set, but never its last 4 for a user
    expect(body.tts.apiKey).toEqual({ set: true, source: "env" })
    expect(body.default.tts.apiKey).toEqual({ set: true, source: "env" })
    expect(body.ready).toEqual({ stt: true, tts: true })
    expect(JSON.stringify(body)).not.toContain(ENV_KEY.slice(-4))
  })

  test("precedence: user field over server default over env", async () => {
    expect((await put(admin, "/api/settings/speech/default", { tts: { voice: "nova" } })).status).toBe(200)
    expect((await get(bob, "/api/settings/speech")).body.tts.voice).toBe("nova")
    const mine = await put(alice, "/api/settings/speech", { tts: { voice: "alloy" } })
    expect(mine.status).toBe(200)
    expect(mine.body.tts.voice).toBe("alloy")
    expect(mine.body.user.tts).toEqual({ voice: "alloy" })
    expect(mine.body.default.tts.voice).toBe("nova")
    expect((await get(bob, "/api/settings/speech")).body.tts.voice).toBe("nova")
    expect((await get(admin, "/api/settings/speech/default")).body.tts.voice).toBe("nova")
    // clearing the own field inherits again
    expect((await put(alice, "/api/settings/speech", { tts: { voice: null } })).body.tts.voice).toBe("nova")
  })

  test("a user's key is theirs: shown masked to them only, never to other users or admins", async () => {
    const own = await put(alice, "/api/settings/speech", { tts: { apiKey: ALICE_KEY } })
    expect(own.body.tts.apiKey).toEqual({ set: true, last4: "LICE", source: "user" })
    expect(own.body.user.tts.apiKey).toEqual({ set: true, last4: "LICE", source: "user" })
    expect(JSON.stringify(own.body)).not.toContain(ALICE_KEY)
    for (const [cookie, path] of [
      [bob, "/api/settings/speech"],
      [admin, "/api/settings/speech"],
      [admin, "/api/settings/speech/default"],
      [admin, "/api/admin/users"],
      [admin, "/api/admin/audit"],
      [bob, "/api/me"],
    ] as const) {
      const text = JSON.stringify((await get(cookie, path)).body)
      expect(text).not.toContain(ALICE_KEY)
      expect(text).not.toContain("LICE")
    }
  })

  test("ready follows the caller's effective settings", async () => {
    // a default without any key: bob is not ready; alice brings her own key
    await h.stop()
    idp.stop()
    idp = fakeProvider()
    h = harness({ speech: undefined, noDevice: true, env: oidcEnv(idp) })
    const a = (await signIn(h.url, idp, "alice@example.com")).cookie!
    const b = (await signIn(h.url, idp, "bob@example.com")).cookie!
    expect((await get(b, "/api/settings/speech")).body.ready.stt).toBe(false)
    const after = await put(a, "/api/settings/speech", { stt: { apiKey: ALICE_KEY }, tts: { apiKey: ALICE_KEY } })
    expect(after.body.ready).toEqual({ stt: true, tts: true })
    expect((await get(b, "/api/settings/speech")).body.ready.stt).toBe(false)
  })

  test("changing the provider or base URL drops the user's own key", async () => {
    await put(alice, "/api/settings/speech", { tts: { apiKey: ALICE_KEY } })
    const moved = await put(alice, "/api/settings/speech", { tts: { provider: "openai-compatible", baseURL: "https://speech.example.com/v1" } })
    expect(moved.status).toBe(200)
    expect(moved.body.user.tts.apiKey).toBeUndefined()
    expect(moved.body.tts.apiKey).toEqual({ set: false, source: "none" })
  })

  test("invalid input is 400 and changes nothing", async () => {
    expect((await put(alice, "/api/settings/speech", { tts: { speed: 9 } })).status).toBe(400)
    expect((await get(alice, "/api/settings/speech")).body.user).toEqual({ stt: {}, tts: {} })
  })
})

describe("server default (admin)", () => {
  test("admin only; today's view; audited", async () => {
    expect((await get(bob, "/api/settings/speech/default")).status).toBe(403)
    expect((await put(bob, "/api/settings/speech/default", { tts: { voice: "x" } })).status).toBe(403)
    const res = await put(admin, "/api/settings/speech/default", { tts: { voice: "nova" } })
    expect(res.body.scope).toBeUndefined()
    expect(res.body.voiceHints).toBeDefined()
    expect(h.store.speechSettings()).toEqual({ tts: { voice: "nova" } })
    expect(h.store.auditLog()[0]).toMatchObject({ action: "speech.default" })
    // the admin's own settings are separate from the default
    await put(admin, "/api/settings/speech", { tts: { voice: "echo" } })
    expect(h.store.speechSettings()).toEqual({ tts: { voice: "nova" } })
  })
})

describe("speech requests use the caller's settings", () => {
  test("models and test use alice's provider and key; bob's use the default", async () => {
    await put(alice, "/api/settings/speech", {
      tts: { provider: "openai-compatible", baseURL: "https://speech.example.com/v1", apiKey: ALICE_KEY, model: "tts-1", voice: "alloy" },
    })
    calls.length = 0
    expect((await get(alice, "/api/settings/speech/models?kind=tts")).status).toBe(200)
    expect(calls[0]!.url).toBe("https://speech.example.com/v1/models")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ALICE_KEY}`)
    calls.length = 0
    expect((await get(bob, "/api/settings/speech/models?kind=tts")).status).toBe(200)
    expect(calls[0]!.url).toContain("openrouter.ai")
    expect(JSON.stringify(calls)).not.toContain(ALICE_KEY)

    calls.length = 0
    const test = await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "tts" }, cookie: alice })
    expect(test.status).toBe(200)
    expect(calls[0]!.url).toBe("https://speech.example.com/v1/audio/speech")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ALICE_KEY}`)
    calls.length = 0
    await h.api("/api/speak", { method: "POST", json: { text: "hello" }, cookie: bob })
    expect(calls[0]!.url).toContain("openrouter.ai")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${ENV_KEY}`)
  })
})

describe("pairing mode is unchanged", () => {
  test("GET has no scope; PUT writes the stored (default) settings", async () => {
    const p = harness({ speech: undefined })
    try {
      const view = (await (await p.api("/api/settings/speech")).json()) as any
      expect(view.scope).toBeUndefined()
      expect(view.default).toBeUndefined()
      await p.api("/api/settings/speech", { method: "PUT", json: { tts: { voice: "nova" } } })
      expect(p.store.speechSettings()).toEqual({ tts: { voice: "nova" } })
      expect(((await (await p.api("/api/settings/speech/default")).json()) as any).tts.voice).toBe("nova")
    } finally {
      await p.stop()
    }
  })
})
