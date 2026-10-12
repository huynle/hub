// Speech providers: OpenRouter (JSON base64 STT) and OpenAI-compatible (multipart STT), both TTS via
// /audio/speech, with an optional speed that is dropped and retried once when the provider rejects it.
import { describe, expect, test } from "bun:test"
import { OpenAICompatible } from "../src/central/speech/openai"
import { OpenRouter, OpenRouterError } from "../src/central/speech/openrouter"
import { SpeechError } from "../src/central/speech/provider"

interface Call {
  url: string
  init: RequestInit
}

/** Fake fetch answering each call with the next response (the last one repeats). */
function fakeFetch(...responses: Array<() => Response>) {
  const calls: Call[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return responses[Math.min(calls.length - 1, responses.length - 1)]!()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const mp3 = () => new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "audio/mpeg" } })
const json = (call: Call) => JSON.parse(String(call.init.body))

const compatible = (fetch: typeof globalThis.fetch, key: string | null = "sk-local", language?: string) =>
  new OpenAICompatible({
    fetch,
    baseURL: "https://speech.example/v1",
    apiKey: async () => key ?? undefined,
    sttModel: "whisper-large-v3",
    ttsModel: "kokoro",
    voice: "af_heart",
    ...(language ? { language } : {}),
  })

describe("OpenAICompatible", () => {
  test("transcribe posts multipart file + model + language to /audio/transcriptions", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ text: " hi there " }))
    expect(await compatible(fetch, "sk-local", "en").transcribe(new Uint8Array([1, 2, 3]), "webm")).toBe("hi there")
    expect(calls[0]!.url).toBe("https://speech.example/v1/audio/transcriptions")
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-local")
    const form = calls[0]!.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get("model")).toBe("whisper-large-v3")
    expect(form.get("language")).toBe("en")
    const file = form.get("file") as File
    expect(file.name).toBe("audio.webm")
    expect(file.type).toBe("audio/webm")
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3])
  })

  test("without a key no authorization header is sent (local servers); no language field when unset", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ text: "ok" }))
    await compatible(fetch, null).transcribe(new Uint8Array([1]), "m4a")
    expect(new Headers(calls[0]!.init.headers).has("authorization")).toBe(false)
    const form = calls[0]!.init.body as FormData
    expect(form.has("language")).toBe(false)
    expect((form.get("file") as File).name).toBe("audio.m4a")
  })

  test("speak posts {model, input, voice, response_format, speed} to /audio/speech", async () => {
    const { fetch, calls } = fakeFetch(mp3)
    expect([...(await compatible(fetch).speak("Hello", 1.25))]).toEqual([9, 8, 7])
    expect(calls[0]!.url).toBe("https://speech.example/v1/audio/speech")
    expect(json(calls[0]!)).toEqual({ model: "kokoro", input: "Hello", voice: "af_heart", response_format: "mp3", speed: 1.25 })
    await compatible(fetch).speak("Hello")
    expect(json(calls[1]!)).toEqual({ model: "kokoro", input: "Hello", voice: "af_heart", response_format: "mp3" })
  })

  test("a 400 with speed is retried once without speed; errors are SpeechErrors with status", async () => {
    const reject = () => Response.json({ error: { message: "speed not supported" } }, { status: 400 })
    const retried = fakeFetch(reject, mp3)
    expect([...(await compatible(retried.fetch).speak("Hi", 1.5))]).toEqual([9, 8, 7])
    expect(retried.calls.map((c) => json(c).speed)).toEqual([1.5, undefined])

    const twice = fakeFetch(reject)
    const error = await compatible(twice.fetch).speak("Hi", 1.5).catch((e) => e)
    expect(twice.calls).toHaveLength(2)
    expect(error).toBeInstanceOf(SpeechError)
    expect(error).toMatchObject({ status: 400, message: "Speech provider speech failed (400): speed not supported" })

    const once = fakeFetch(reject)
    await compatible(once.fetch).speak("Hi").catch(() => {})
    expect(once.calls).toHaveLength(1)

    const down = fakeFetch(() => new Response("down", { status: 503 }))
    expect(await compatible(down.fetch).transcribe(new Uint8Array([1]), "wav").catch((e) => e)).toMatchObject({
      status: 503,
      message: "Speech provider transcription failed (503): down",
    })
  })
})

describe("OpenRouter provider", () => {
  const openrouter = (fetch: typeof globalThis.fetch, language?: string) =>
    new OpenRouter({
      fetch,
      apiKey: async () => "sk-or",
      sttModel: "openai/whisper-1",
      ttsModel: "hexgrad/kokoro-82m",
      voice: "af_heart",
      ...(language ? { language } : {}),
    })

  test("speed is sent when given and retried without on 400; language goes with transcription", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ error: { message: "bad speed" } }, { status: 400 }), mp3)
    await openrouter(fetch).speak("Hi", 0.75)
    expect(calls.map((c) => json(c).speed)).toEqual([0.75, undefined])
    expect(json(calls[1]!)).toEqual({ model: "hexgrad/kokoro-82m", input: "Hi", voice: "af_heart", response_format: "mp3" })

    const stt = fakeFetch(() => Response.json({ text: "x" }))
    await openrouter(stt.fetch, "de").transcribe(new Uint8Array([1]), "webm")
    expect(json(stt.calls[0]!)).toEqual({ model: "openai/whisper-1", input_audio: { data: "AQ==", format: "webm" }, language: "de" })
  })

  test("OpenRouterError is a SpeechError", () => {
    expect(new OpenRouterError("x", 500)).toBeInstanceOf(SpeechError)
  })
})
