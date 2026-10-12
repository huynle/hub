import { describe, expect, test } from "bun:test"
import { audioFormat, OpenRouter, OpenRouterError } from "../src/openrouter"

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(response: () => Response) {
  const calls: Call[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const client = (fetch: typeof globalThis.fetch, key: string | null = "sk-test") =>
  new OpenRouter({
    fetch,
    apiKey: async () => key ?? undefined,
    sttModel: "openai/whisper-1",
    ttsModel: "openai/gpt-4o-mini-tts-2025-12-15",
    voice: "alloy",
  })

describe("audioFormat", () => {
  test.each([
    ["audio/webm;codecs=opus", "webm"],
    ["audio/mp4", "m4a"],
    ["audio/x-m4a", "m4a"],
    ["audio/ogg; codecs=opus", "ogg"],
    ["audio/wav", "wav"],
    ["audio/mpeg", "mp3"],
  ])("%s -> %s", (contentType, format) => {
    expect(audioFormat(contentType)).toBe(format)
  })

  test("rejects non-audio types", () => {
    expect(audioFormat("text/plain")).toBeUndefined()
    expect(audioFormat(null)).toBeUndefined()
  })
})

describe("OpenRouter.transcribe", () => {
  test("posts base64 audio to the transcription endpoint", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ text: " hello there " }))
    const text = await client(fetch).transcribe(new Uint8Array([1, 2, 3]), "webm")
    expect(text).toBe("hello there")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-test")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "openai/whisper-1",
      input_audio: { data: "AQID", format: "webm" },
    })
  })

  test("surfaces API errors with status and message", async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: { message: "bad audio" } }, { status: 400 }))
    const error = await client(fetch)
      .transcribe(new Uint8Array([1]), "webm")
      .catch((e) => e)
    expect(error).toBeInstanceOf(OpenRouterError)
    expect(error).toMatchObject({ status: 400, message: "OpenRouter transcription failed (400): bad audio" })
  })

  test("fails clearly without an API key and makes no request", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({}))
    const error = await client(fetch, null)
      .transcribe(new Uint8Array([1]), "webm")
      .catch((e) => e)
    expect(error).toBeInstanceOf(OpenRouterError)
    expect(String(error.message)).toContain("No OpenRouter API key")
    expect(calls).toHaveLength(0)
  })
})

describe("OpenRouter.speak", () => {
  test("posts text to the speech endpoint and returns the audio bytes", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "audio/mpeg" } }))
    const audio = await client(fetch).speak("Hi")
    expect([...audio]).toEqual([9, 8, 7])
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/speech")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "openai/gpt-4o-mini-tts-2025-12-15",
      input: "Hi",
      voice: "alloy",
      response_format: "mp3",
    })
  })

  test("surfaces API errors", async () => {
    const { fetch } = fakeFetch(() => new Response("upstream down", { status: 502 }))
    const error = await client(fetch)
      .speak("Hi")
      .catch((e) => e)
    expect(error).toMatchObject({ status: 502, message: "OpenRouter speech failed (502): upstream down" })
  })
})
