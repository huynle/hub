// Speech settings API: GET/PUT /api/settings/speech, GET /api/settings/speech/models, POST
// /api/settings/speech/test; keys never leave the hub (responses or logs); speech follows the settings.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { harness, type Harness } from "./central-harness"

const KEY = "sk-or-v1-abcdef0123456789TOPSECRET"
const ENV_KEY = "sk-env-0000111122223333ENVSECRET"

interface Call {
  url: string
  init: RequestInit
}

let h: Harness
let calls: Call[]
let reply: (call: Call) => Response
let logged: string[]
let restore: Array<() => void>

beforeEach(() => {
  calls = []
  reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })
  logged = []
  restore = (["log", "error", "warn", "info"] as const).map((level) => {
    const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")))
    return () => spy.mockRestore()
  })
  h = harness({
    speech: undefined,
    env: { OPENROUTER_API_KEY: ENV_KEY },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} }
      calls.push(call)
      return reply(call)
    }) as unknown as typeof globalThis.fetch,
  })
})

afterEach(async () => {
  await h?.stop()
  for (const r of restore) r()
  // No key ever reaches a log line.
  for (const line of logged) {
    expect(line).not.toContain(KEY)
    expect(line).not.toContain(ENV_KEY)
  }
})

const get = async (pathname: string) => {
  const res = await h.api(pathname)
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined }
}
const put = (json: unknown, init: { origin?: string | null; cookie?: null } = {}) =>
  h.api("/api/settings/speech", { method: "PUT", json, ...init })

describe("auth", () => {
  test("cookie required everywhere; writes need the same Origin", async () => {
    for (const pathname of ["/api/settings/speech", "/api/settings/speech/models?kind=stt"]) {
      expect((await h.api(pathname, { cookie: null })).status).toBe(401)
    }
    expect((await put({ tts: { voice: "nova" } }, { cookie: null })).status).toBe(401)
    expect((await put({ tts: { voice: "nova" } }, { origin: null })).status).toBe(403)
    expect((await put({ tts: { voice: "nova" } }, { origin: "https://evil.test" })).status).toBe(403)
    const testCall = (origin?: string | null) => h.api("/api/settings/speech/test", { method: "POST", json: { kind: "tts" }, origin })
    expect((await testCall(null)).status).toBe(403)
    expect((await testCall("https://evil.test")).status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe("GET/PUT /api/settings/speech", () => {
  test("GET shows effective settings, keys masked, plus voice hints", async () => {
    const { status, body, text } = await get("/api/settings/speech")
    expect(status).toBe(200)
    expect(body.stt).toEqual({ provider: "openrouter", model: expect.any(String), apiKey: { set: true, last4: "CRET", source: "env" } })
    expect(body.tts).toMatchObject({ provider: "openrouter", voice: expect.any(String), apiKey: { set: true, source: "env" } })
    expect(body.voiceHints["hexgrad/kokoro-82m"]).toContain("af_heart")
    expect(text).not.toContain(ENV_KEY)
  })

  test("PUT updates partially and answers with the masked view; the key is only in the private state file", async () => {
    const res = await put({ stt: { apiKey: KEY, model: "openai/whisper-1" }, tts: { speed: 1.25 } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(KEY)
    expect(JSON.parse(text).stt).toEqual({ provider: "openrouter", model: "openai/whisper-1", apiKey: { set: true, last4: "CRET", source: "settings" } })
    const again = await get("/api/settings/speech")
    expect(again.text).not.toContain(KEY)
    expect(again.body.tts.speed).toBe(1.25)
    expect(again.body.stt.model).toBe("openai/whisper-1")
    expect(readFileSync(path.join(h.stateDir, "state.json"), "utf8")).toContain(KEY)

    expect((await put({ stt: { apiKey: null } })).status).toBe(200)
    expect((await get("/api/settings/speech")).body.stt.apiKey).toEqual({ set: true, last4: "CRET", source: "env" })
  })

  test("invalid input is 400 and changes nothing; the message never echoes a key", async () => {
    for (const json of [
      { tts: { speed: 3 } },
      { tts: { provider: "openai-compatible" } },
      { stt: { baseURL: "http://speech.example/v1" } },
      { stt: { provider: "whisper.cpp" } },
      { stt: { apiKey: `${KEY} oops` } },
      [],
    ]) {
      const res = await put(json)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain(KEY)
    }
    const raw = await h.api("/api/settings/speech", { method: "PUT", body: "{nope", headers: { "content-type": "application/json" } })
    expect(raw.status).toBe(400)
    expect((await get("/api/settings/speech")).body.tts.speed).toBeUndefined()
  })
})

describe("speech follows the settings", () => {
  test("transcribe and speak switch provider shapes at once", async () => {
    reply = () => Response.json({ text: "hello" })
    const audio = () => h.api("/api/transcribe", { method: "POST", body: new Uint8Array([1, 2, 3]), headers: { "content-type": "audio/webm" } })
    expect(await (await audio()).json()).toEqual({ text: "hello" })
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${ENV_KEY}`)

    await put({ stt: { provider: "openai-compatible", baseURL: "http://127.0.0.1:9000/v1", model: "whisper-1", apiKey: KEY } })
    await audio()
    expect(calls[1]!.url).toBe("http://127.0.0.1:9000/v1/audio/transcriptions")
    expect(calls[1]!.init.body).toBeInstanceOf(FormData)
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`)

    reply = () => new Response(new Uint8Array([5]))
    await put({ tts: { model: "hexgrad/kokoro-82m", voice: "af_heart", speed: 0.75 } })
    const spoken = await h.api("/api/speak", { method: "POST", json: { text: "Done." } })
    expect(spoken.headers.get("content-type")).toBe("audio/mpeg")
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      model: "hexgrad/kokoro-82m",
      input: "Done.",
      voice: "af_heart",
      response_format: "mp3",
      speed: 0.75,
    })
  })

  test("provider errors are 502 and do not reveal the key", async () => {
    await put({ tts: { apiKey: KEY } })
    reply = () => Response.json({ error: { message: "invalid voice" } }, { status: 422 })
    const res = await h.api("/api/speak", { method: "POST", json: { text: "Hi" } })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toContain("invalid voice")
    expect(text).not.toContain(KEY)
  })
})

describe("GET /api/settings/speech/models", () => {
  test("proxies OpenRouter by kind, cached; bad kind is 400", async () => {
    reply = () => Response.json({ data: [{ id: "openai/whisper-1", name: "Whisper" }] })
    const first = await get("/api/settings/speech/models?kind=stt")
    expect(first).toMatchObject({ status: 200, body: { models: [{ current: true }, { id: "openai/whisper-1", name: "Whisper" }] } })
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription")
    await get("/api/settings/speech/models?kind=stt")
    expect(calls).toHaveLength(1)
    await get("/api/settings/speech/models?kind=tts")
    expect(calls[1]!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech")
    expect((await get("/api/settings/speech/models?kind=video")).status).toBe(400)
    expect((await get("/api/settings/speech/models")).status).toBe(400)
  })

  test("OpenRouter being down is 502; an openai-compatible server without a list offers only the configured model", async () => {
    reply = () => new Response("down", { status: 503 })
    expect((await get("/api/settings/speech/models?kind=tts")).status).toBe(502)
    await put({ tts: { provider: "openai-compatible", baseURL: "https://speech.example/v1" } })
    const offline = await get("/api/settings/speech/models?kind=tts")
    expect(offline).toMatchObject({ status: 200 })
    expect(offline.body.models).toHaveLength(1)
    expect(offline.body.models[0]).toMatchObject({ current: true })
    expect(calls.at(-1)!.url).toBe("https://speech.example/v1/models")
  })
})

describe("POST /api/settings/speech/test", () => {
  test("tts returns an mp3 preview with the current settings; default text when none is given", async () => {
    await put({ tts: { voice: "nova", model: "openai/gpt-4o-mini-tts" } })
    const res = await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "tts", text: "Testing one two" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("audio/mpeg")
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3])
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: "openai/gpt-4o-mini-tts", voice: "nova", input: "Testing one two" })

    await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "tts" } })
    expect(JSON.parse(String(calls[1]!.init.body)).input).toBeTruthy()
    await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "tts", text: "x".repeat(5000) } })
    expect(JSON.parse(String(calls[2]!.init.body)).input.length).toBeLessThanOrEqual(300)
  })

  test("stt is not implemented (501); other kinds are 400", async () => {
    expect((await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "stt" } })).status).toBe(501)
    expect((await h.api("/api/settings/speech/test", { method: "POST", json: { kind: "music" } })).status).toBe(400)
    expect(calls).toEqual([])
  })
})
