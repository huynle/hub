// Transcription-side noise check: Whisper models are asked for verbose_json, and segments Whisper itself rates as
// probably not speech (no_speech_prob > 0.6) are dropped, so "Thank you." made from noise never comes back.
// Providers that refuse verbose_json get a plain request (once refused, not asked again); other models are not asked.
import { describe, expect, test } from "bun:test"
import { NO_SPEECH_MAX, transcriptText, wantsVerbose } from "../src/central/speech/provider"
import { OpenRouter } from "../src/central/speech/openrouter"
import { OpenAICompatible } from "../src/central/speech/openai"

describe("transcriptText", () => {
  test("plain json: the text", () => {
    expect(transcriptText({ text: " hello there " })).toBe("hello there")
    expect(transcriptText({})).toBe("")
  })

  test("verbose_json without no_speech_prob: the text as is", () => {
    expect(transcriptText({ text: "Hello there.", segments: [{ id: 0, start: 0, end: 1, text: "Hello there." }] })).toBe("Hello there.")
  })

  test(`segments with no_speech_prob above ${NO_SPEECH_MAX} are dropped`, () => {
    expect(NO_SPEECH_MAX).toBe(0.6)
    const body = {
      text: "Thank you.",
      segments: [{ id: 0, start: 0, end: 1.2, text: " Thank you.", no_speech_prob: 0.83, avg_logprob: -0.9 }],
    }
    expect(transcriptText(body)).toBe("")
  })

  test("speech segments stay; a noise segment around them goes", () => {
    const body = {
      text: "Check the build. Thank you.",
      segments: [
        { id: 0, start: 0, end: 1.5, text: " Check the build.", no_speech_prob: 0.02 },
        { id: 1, start: 1.5, end: 2.5, text: " Thank you.", no_speech_prob: 0.71 },
      ],
    }
    expect(transcriptText(body)).toBe("Check the build.")
  })

  test("exactly 0.6 is kept", () => {
    expect(transcriptText({ text: "Yes.", segments: [{ id: 0, start: 0, end: 1, text: "Yes.", no_speech_prob: 0.6 }] })).toBe("Yes.")
  })
})

describe("wantsVerbose", () => {
  test.each([
    ["openai/whisper-large-v3-turbo", true],
    ["openai/whisper-1", true],
    ["whisper-large-v3", true],
    ["Systran/faster-whisper-small", true],
    ["openai/gpt-4o-mini-transcribe", false],
    ["openai/gpt-4o-transcribe", false],
    ["mistralai/voxtral-mini", false],
  ])("%s → %p", (model, verbose) => {
    expect(wantsVerbose(model)).toBe(verbose)
  })
})

function fakeFetch(respond: (form: FormData, n: number) => Response) {
  const forms: FormData[] = []
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init!.body as FormData
    forms.push(form)
    return respond(form, forms.length)
  }) as unknown as typeof globalThis.fetch
  return { fetch, forms }
}

const providers = {
  openrouter: (fetch: typeof globalThis.fetch, sttModel: string) => new OpenRouter({ fetch, apiKey: async () => "k", sttModel, ttsModel: "t", voice: "v" }),
  openai: (fetch: typeof globalThis.fetch, sttModel: string) => new OpenAICompatible({ fetch, baseURL: "https://api.example/v1", apiKey: async () => "k", sttModel, ttsModel: "t", voice: "v" }),
}

describe.each(Object.entries(providers))("%s transcribe", (_name, make) => {
  const noise = { text: "Thank you.", segments: [{ id: 0, start: 0, end: 1, text: " Thank you.", no_speech_prob: 0.9 }] }

  test("a Whisper model is asked for verbose_json; Whisper's no-speech rating drops the noise", async () => {
    const { fetch, forms } = fakeFetch(() => Response.json(noise))
    expect(await make(fetch, "openai/whisper-large-v3-turbo").transcribe(new Uint8Array([1]), "wav")).toBe("")
    expect(forms[0]!.get("response_format")).toBe("verbose_json")
  })

  test("other models are asked for plain json (verbose_json is Whisper's)", async () => {
    const { fetch, forms } = fakeFetch(() => Response.json({ text: "hello" }))
    expect(await make(fetch, "openai/gpt-4o-mini-transcribe").transcribe(new Uint8Array([1]), "wav")).toBe("hello")
    expect(forms[0]!.get("response_format")).toBeNull()
  })

  test("a provider refusing verbose_json gets a plain request, and is not asked again", async () => {
    const { fetch, forms } = fakeFetch((form) =>
      form.get("response_format") ? Response.json({ error: { message: "response_format verbose_json is not supported" } }, { status: 400 }) : Response.json({ text: "hello" }),
    )
    const provider = make(fetch, "whisper-large-v3")
    expect(await provider.transcribe(new Uint8Array([1]), "wav")).toBe("hello")
    expect(await provider.transcribe(new Uint8Array([1]), "wav")).toBe("hello")
    expect(forms.map((f) => f.get("response_format"))).toEqual(["verbose_json", null, null])
  })

  test("a 400 that a plain request also gets is reported (and verbose_json is kept for next time)", async () => {
    const { fetch, forms } = fakeFetch(() => Response.json({ error: { message: "bad audio" } }, { status: 400 }))
    const provider = make(fetch, "whisper-large-v3")
    await expect(provider.transcribe(new Uint8Array([1]), "wav")).rejects.toThrow(/bad audio/)
    await expect(provider.transcribe(new Uint8Array([1]), "wav")).rejects.toThrow(/bad audio/)
    expect(forms.map((f) => f.get("response_format"))).toEqual(["verbose_json", null, "verbose_json", null])
  })
})
