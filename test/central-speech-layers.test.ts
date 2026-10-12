// Speech settings precedence: the phone's saved settings (state.json) > hub.json > env vars.
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ValidationError } from "../src/central/auth"
import { SpeechService } from "../src/central/speech/service"
import type { StoredSpeech } from "../src/central/speech/settings"
import { Store } from "../src/central/store"

const ENV_KEY = "sk-env-9876543210ENVKEY1"
const FILE_KEY = "sk-file-0123456789FILEKEY2"
const PHONE_KEY = "sk-phone-0123456789PHONE3"
const env = { apiKey: ENV_KEY, sttModel: "openai/gpt-4o-mini-transcribe", ttsModel: "microsoft/mai-voice-2.1-flash", voice: "en-US-Harper:MAI-Voice-2.1-Flash" }

/** A local Kokoro/Whisper-style setup from hub.json. */
const LOCAL: StoredSpeech = {
  stt: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8000/v1", model: "whisper-1", language: "en", apiKey: FILE_KEY },
  tts: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8880/v1", model: "kokoro", voice: "af_heart", speed: 1.1, apiKey: FILE_KEY },
}

let store: Store
let calls: Array<{ url: string; init: RequestInit }>
const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} })
  return String(url).endsWith("/audio/speech") ? new Response(new Uint8Array([1])) : Response.json({ text: "ok" })
}) as unknown as typeof globalThis.fetch
const make = (file?: StoredSpeech) => new SpeechService({ store, defaults: { ...env, ...(file ? { file } : {}) }, fetch })
const bearer = (i: number) => new Headers(calls[i]!.init.headers).get("authorization")

beforeEach(() => {
  store = Store.open(mkdtempSync(path.join(tmpdir(), "voice-layers-")))
  calls = []
})

describe("hub.json layer", () => {
  test("applies when the phone saved nothing; its key reports source config", () => {
    expect(make(LOCAL).view()).toMatchObject({
      stt: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8000/v1", model: "whisper-1", language: "en", apiKey: { set: true, last4: "KEY2", source: "config" } },
      tts: { provider: "openai-compatible", baseURL: "http://127.0.0.1:8880/v1", model: "kokoro", voice: "af_heart", speed: 1.1, apiKey: { set: true, last4: "KEY2", source: "config" } },
    })
  })

  test("an openrouter file key beats OPENROUTER_API_KEY; without one the env key and env models still apply", () => {
    expect(make({ tts: { apiKey: FILE_KEY, voice: "nova" } }).view().tts).toMatchObject({ provider: "openrouter", model: env.ttsModel, voice: "nova", apiKey: { source: "config" } })
    expect(make({ tts: { voice: "nova" } }).view().tts.apiKey).toMatchObject({ source: "env", last4: "KEY1" })
    expect(make({ tts: { model: "openai/gpt-4o-mini-tts" } }).view().stt).toMatchObject({ model: env.sttModel, apiKey: { source: "env" } })
  })

  test("requests go to the file's endpoints with the file's key", async () => {
    const service = make(LOCAL)
    await service.transcribe(new Uint8Array([1]), "wav")
    await service.speak("Hi")
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8000/v1/audio/transcriptions", "http://127.0.0.1:8880/v1/audio/speech"])
    expect([bearer(0), bearer(1)]).toEqual([`Bearer ${FILE_KEY}`, `Bearer ${FILE_KEY}`])
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ model: "kokoro", voice: "af_heart", speed: 1.1 })
  })
})

describe("phone settings over hub.json", () => {
  test("field by field on the same endpoint; the file key stays until the phone sets its own", () => {
    const service = make(LOCAL)
    service.update({ tts: { voice: "bf_emma" } })
    expect(service.view().tts).toMatchObject({ model: "kokoro", voice: "bf_emma", baseURL: "http://127.0.0.1:8880/v1", apiKey: { source: "config" } })
    service.update({ tts: { apiKey: PHONE_KEY } })
    expect(service.view().tts.apiKey).toMatchObject({ source: "settings", last4: "ONE3" })
    service.update({ tts: { apiKey: null } })
    expect(service.view().tts.apiKey).toMatchObject({ source: "config", last4: "KEY2" })
  })

  test("a different provider on the phone ignores the file's section (no model, URL or key carried over)", async () => {
    const service = make(LOCAL)
    service.update({ stt: { provider: "openrouter" } })
    expect(service.view().stt).toEqual({ provider: "openrouter", model: env.sttModel, apiKey: { set: true, last4: "KEY1", source: "env" } })
    await service.transcribe(new Uint8Array([1]), "wav")
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(bearer(0)).toBe(`Bearer ${ENV_KEY}`)
    // tts is untouched and still comes from the file
    expect(service.view().tts.model).toBe("kokoro")
  })

  test("a different base URL on the phone never receives the file's key", async () => {
    const service = make(LOCAL)
    service.update({ tts: { baseURL: "https://speech.example/v1" } })
    expect(service.view().tts).toMatchObject({ provider: "openai-compatible", baseURL: "https://speech.example/v1", apiKey: { set: false, source: "none" } })
    await service.speak("Hi")
    expect(calls[0]!.url).toBe("https://speech.example/v1/audio/speech")
    expect(bearer(0)).toBeNull()
  })

  test("validation sees the file: openai-compatible needs a base URL from either layer", () => {
    expect(() => make(LOCAL).update({ tts: { provider: "openai-compatible" } })).not.toThrow()
    expect(() => make().update({ tts: { provider: "openai-compatible" } })).toThrow(ValidationError)
  })
})
