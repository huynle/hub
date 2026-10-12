// Speech settings: env defaults, masking (a stored key never leaves the hub), partial updates,
// validation, provider switching, and the models proxy with its cache.
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ValidationError } from "../src/central/auth"
import { MODELS_CACHE_MS, SpeechService } from "../src/central/speech/service"
import { VOICE_HINTS, speechReady } from "../src/central/speech/settings"
import { Store } from "../src/central/store"

const KEY = "sk-or-v1-0123456789abcdefSECRET"
const LOCAL_KEY = "sk-local-zyxwvutsrqLOCALKEY"
const ENV_KEY = "sk-env-9876543210ENVKEY1"
const defaults = { apiKey: ENV_KEY, sttModel: "openai/gpt-4o-mini-transcribe", ttsModel: "microsoft/mai-voice-2.1-flash", voice: "en-US-Harper:MAI-Voice-2.1-Flash" }

interface Call {
  url: string
  init: RequestInit
}

let dir: string
let store: Store
let clock: number
let calls: Call[]
let reply: (call: Call) => Response
let service: SpeechService

const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(url), init: init ?? {} }
  calls.push(call)
  return reply(call)
}) as unknown as typeof globalThis.fetch

const make = (d: Partial<typeof defaults> = defaults) => new SpeechService({ store, defaults: { ...defaults, ...d }, fetch, now: () => clock })
const auth = (call: Call) => new Headers(call.init.headers).get("authorization")

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "voice-speech-"))
  store = Store.open(dir)
  clock = 1_000_000
  calls = []
  reply = () => Response.json({ text: "ok" })
  service = make()
})

describe("ready", () => {
  const r = (provider: "openrouter" | "openai-compatible", extra: { apiKey?: string; baseURL?: string } = {}) => ({
    provider,
    model: "m",
    baseURL: extra.baseURL ?? "",
    keySource: extra.apiKey ? ("settings" as const) : ("none" as const),
    ...(extra.apiKey ? { apiKey: extra.apiKey } : {}),
  })

  test("openrouter needs a key; openai-compatible needs a base URL (a key is optional)", () => {
    expect(speechReady(r("openrouter", { apiKey: KEY, baseURL: "https://openrouter.ai/api/v1" }), r("openai-compatible", { baseURL: "http://127.0.0.1:8880/v1" }))).toEqual({ stt: true, tts: true })
    const none = speechReady(r("openrouter"), r("openrouter"))
    expect(none).toMatchObject({ stt: false, tts: false })
    expect(none.reason).toContain("OpenRouter API key")
    const half = speechReady(r("openrouter", { apiKey: KEY }), r("openai-compatible"))
    expect(half).toMatchObject({ stt: true, tts: false })
    expect(half.reason).toContain("base URL")
  })

  test("the view reports readiness, and it follows a key set from the phone", () => {
    const keyless = make({ apiKey: undefined })
    expect(keyless.view().ready).toMatchObject({ stt: false, tts: false, reason: expect.stringContaining("Speech-to-text") })
    expect(keyless.update({ stt: { apiKey: KEY }, tts: { apiKey: KEY } }).ready).toEqual({ stt: true, tts: true })
  })
})

describe("view", () => {
  test("defaults come from the environment; the env key is reported by source only", () => {
    expect(service.view()).toEqual({
      stt: { provider: "openrouter", model: defaults.sttModel, apiKey: { set: true, last4: "KEY1", source: "env" } },
      tts: { provider: "openrouter", model: defaults.ttsModel, voice: defaults.voice, apiKey: { set: true, last4: "KEY1", source: "env" } },
      voiceHints: VOICE_HINTS,
      ready: { stt: true, tts: true },
    })
    expect(make({ apiKey: undefined }).view().stt.apiKey).toEqual({ set: false, source: "none" })
  })

  test("a stored key is masked to set/last4/source and never appears in the view", () => {
    const view = service.update({ stt: { apiKey: KEY }, tts: { apiKey: KEY, speed: 1.25 } })
    expect(view.stt.apiKey).toEqual({ set: true, last4: "CRET", source: "settings" })
    expect(view.tts).toMatchObject({ speed: 1.25, apiKey: { set: true, last4: "CRET", source: "settings" } })
    expect(JSON.stringify(view)).not.toContain(KEY)
    expect(JSON.stringify(service.view())).not.toContain(KEY)
    expect(JSON.stringify(service.view())).not.toContain(ENV_KEY)
  })

  test("short keys show no last4", () => {
    expect(service.update({ stt: { apiKey: "abc12345" } }).stt.apiKey).toEqual({ set: true, source: "settings" })
  })

  test("voice hints cover the known OpenRouter TTS model families", () => {
    expect(VOICE_HINTS["microsoft/mai-voice"]).toContain("en-US-Harper:MAI-Voice-2.1-Flash")
    expect(VOICE_HINTS["hexgrad/kokoro-82m"]).toContain("af_heart")
    expect(VOICE_HINTS["openai/"]).toEqual(expect.arrayContaining(["alloy", "nova"]))
  })
})

describe("update", () => {
  test("partial: untouched fields keep their values; apiKey string sets, null clears, absent keeps", () => {
    service.update({ stt: { model: "openai/whisper-1", apiKey: KEY, language: "en" } })
    service.update({ tts: { voice: "nova" } })
    expect(service.view().stt).toMatchObject({ model: "openai/whisper-1", language: "en", apiKey: { source: "settings" } })
    service.update({ stt: { model: "other/model" } })
    expect(service.view().stt).toMatchObject({ model: "other/model", language: "en", apiKey: { source: "settings" } })
    service.update({ stt: { apiKey: null, language: null } })
    expect(service.view().stt).toEqual({ provider: "openrouter", model: "other/model", apiKey: { set: true, last4: "KEY1", source: "env" } })
    expect(service.view().tts).toMatchObject({ voice: "nova", model: defaults.ttsModel })
    service.update({ tts: { voice: "" } })
    expect(service.view().tts.voice).toBe(defaults.voice)
  })

  test("persists in state.json (0600) and survives a restart", () => {
    service.update({ tts: { provider: "openai-compatible", baseURL: "https://speech.example/v1/", apiKey: LOCAL_KEY, model: "kokoro", voice: "af_heart" } })
    expect(statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600)
    store = Store.open(dir)
    expect(make().view().tts).toEqual({
      provider: "openai-compatible",
      model: "kokoro",
      voice: "af_heart",
      baseURL: "https://speech.example/v1",
      apiKey: { set: true, last4: "LKEY", source: "settings" },
    })
  })

  test("switching provider or base URL drops a stored key unless a new one is given", () => {
    service.update({ stt: { apiKey: KEY } })
    service.update({ stt: { provider: "openai-compatible", baseURL: "https://speech.example/v1" } })
    expect(service.view().stt.apiKey).toEqual({ set: false, source: "none" })
    service.update({ stt: { apiKey: LOCAL_KEY } })
    service.update({ stt: { baseURL: "http://localhost:8000/v1" } })
    expect(service.view().stt.apiKey.set).toBe(false)
    service.update({ stt: { baseURL: "http://127.0.0.1:8000/v1", apiKey: LOCAL_KEY } })
    expect(service.view().stt).toMatchObject({ baseURL: "http://127.0.0.1:8000/v1", apiKey: { source: "settings" } })
  })

  test.each([
    [{ stt: { provider: "azure" } }],
    [{ stt: "openrouter" }],
    [{ stt: { model: "x".repeat(201) } }],
    [{ stt: { model: 5 } }],
    [{ tts: { voice: "x".repeat(201) } }],
    [{ tts: { speed: 0.4 } }],
    [{ tts: { speed: 2.1 } }],
    [{ tts: { speed: "1" } }],
    [{ tts: { baseURL: "http://speech.example/v1" } }],
    [{ tts: { baseURL: "ftp://speech.example" } }],
    [{ tts: { baseURL: "https://user:pw@speech.example" } }],
    [{ tts: { baseURL: "not a url" } }],
    [{ tts: { provider: "openai-compatible" } }],
    [{ stt: { apiKey: "has space" } }],
    [{ stt: { apiKey: 42 } }],
    [{ stt: { language: "english please" } }],
  ])("rejects %j and changes nothing", (input) => {
    service.update({ tts: { voice: "nova" } })
    const before = JSON.stringify(store.data())
    expect(() => service.update(input)).toThrow(ValidationError)
    expect(JSON.stringify(store.data())).toBe(before)
  })

  test("validation messages never echo the key", () => {
    try {
      service.update({ stt: { apiKey: `${KEY} with space` } })
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(KEY)
    }
  })
})

describe("providers follow the settings", () => {
  test("openrouter by default with the env key; openai-compatible uses its base URL and stored key only", async () => {
    await service.transcribe(new Uint8Array([1, 2]), "webm")
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(auth(calls[0]!)).toBe(`Bearer ${ENV_KEY}`)
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: defaults.sttModel, input_audio: { format: "webm" } })

    service.update({ stt: { provider: "openai-compatible", baseURL: "https://speech.example/v1", model: "whisper-1" } })
    await service.transcribe(new Uint8Array([1, 2]), "webm")
    expect(calls[1]!.url).toBe("https://speech.example/v1/audio/transcriptions")
    expect(auth(calls[1]!)).toBeNull() // the OpenRouter env key never goes to another provider
    expect((calls[1]!.init.body as FormData).get("model")).toBe("whisper-1")

    service.update({ stt: { apiKey: LOCAL_KEY } })
    await service.transcribe(new Uint8Array([1]), "wav")
    expect(auth(calls[2]!)).toBe(`Bearer ${LOCAL_KEY}`)
  })

  test("speak uses the TTS model, voice and speed", async () => {
    reply = () => new Response(new Uint8Array([7]))
    service.update({ tts: { model: "hexgrad/kokoro-82m", voice: "af_heart", speed: 1.5, apiKey: KEY } })
    expect([...(await service.speak("Hi"))]).toEqual([7])
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/speech")
    expect(auth(calls[0]!)).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "hexgrad/kokoro-82m",
      input: "Hi",
      voice: "af_heart",
      response_format: "mp3",
      speed: 1.5,
    })
  })
})

describe("models", () => {
  test("openrouter: proxies the models list filtered by output modality, cached for 10 minutes", async () => {
    expect(MODELS_CACHE_MS).toBe(600_000)
    reply = () => Response.json({ data: [{ id: "openai/whisper-1", name: "Whisper", pricing: {} }, { id: "x/no-name" }] })
    expect(await service.models("stt")).toEqual([
      { id: "openai/whisper-1", name: "Whisper" },
      { id: "x/no-name", name: "x/no-name" },
    ])
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription")
    expect(auth(calls[0]!)).toBeNull()
    await service.models("stt")
    expect(calls).toHaveLength(1)
    await service.models("tts")
    expect(calls[1]!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech")
    clock += MODELS_CACHE_MS
    await service.models("stt")
    expect(calls).toHaveLength(3)
  })

  test("openrouter failures are SpeechErrors (502), not cached", async () => {
    reply = () => new Response("down", { status: 503 })
    expect(await service.models("tts").catch((e) => e.name)).toBe("SpeechError")
    reply = () => Response.json({ data: [{ id: "a", name: "A" }] })
    expect(await service.models("tts")).toEqual([{ id: "a", name: "A" }])
  })

  test("openai-compatible: GET {baseURL}/models with its key; anything wrong gives []", async () => {
    service.update({ tts: { provider: "openai-compatible", baseURL: "https://speech.example/v1", apiKey: LOCAL_KEY } })
    reply = () => Response.json({ data: [{ id: "kokoro", object: "model" }] })
    expect(await service.models("tts")).toEqual([{ id: "kokoro", name: "kokoro" }])
    expect(calls[0]!.url).toBe("https://speech.example/v1/models")
    expect(auth(calls[0]!)).toBe(`Bearer ${LOCAL_KEY}`)

    service.update({ stt: { provider: "openai-compatible", baseURL: "https://other.example/v1" } })
    reply = () => new Response("nope", { status: 404 })
    expect(await service.models("stt")).toEqual([])
    reply = () => {
      throw new Error("connection refused")
    }
    service.update({ stt: { baseURL: "https://third.example/v1" } })
    expect(await service.models("stt")).toEqual([])
  })

  test("a settings change clears the cache", async () => {
    reply = () => Response.json({ data: [] })
    await service.models("stt")
    service.update({ stt: { model: "m" } })
    await service.models("stt")
    expect(calls).toHaveLength(2)
  })
})
