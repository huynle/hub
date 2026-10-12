// Settings → Speech: partial PUT built from changed fields only, inline validation, voice hints by model prefix.
import { describe, expect, test } from "bun:test"
import { speechForm, speechPatch, validateSpeech, voicesFor, type SpeechSettings } from "../web/feedback-core.js"

const current: SpeechSettings & { voiceHints: Record<string, string[]> } = {
  stt: { provider: "openrouter", model: "openai/whisper-1", language: "en", apiKey: { set: true, last4: "abcd", source: "env" } },
  tts: { provider: "openai-compatible", model: "tts-1", voice: "alloy", baseURL: "http://kokoro:8880/v1", speed: 1.1, apiKey: { set: false, source: "none" } },
  voiceHints: { "tts-": ["alloy", "nova"], "gpt-4o-mini-tts": ["coral"], kokoro: ["af_bella"] },
}

describe("speechForm", () => {
  test("form values from settings: strings, empty for missing, key kept", () => {
    expect(speechForm(current)).toEqual({
      stt: { provider: "openrouter", model: "openai/whisper-1", baseURL: "", language: "en", apiKey: { action: "keep", value: "" } },
      tts: { provider: "openai-compatible", model: "tts-1", voice: "alloy", baseURL: "http://kokoro:8880/v1", speed: "1.1", apiKey: { action: "keep", value: "" } },
    })
  })
})

describe("speechPatch", () => {
  test("nothing changed: empty patch", () => {
    expect(speechPatch(current, speechForm(current))).toEqual({})
  })

  test("only changed fields, trimmed, per card", () => {
    const form = speechForm(current)
    form.tts.voice = " nova "
    expect(speechPatch(current, form)).toEqual({ tts: { voice: "nova" } })
  })

  test("API key: set sends the string, clear sends null, keep omits it", () => {
    const form = speechForm(current)
    form.stt.apiKey = { action: "clear", value: "" }
    form.tts.apiKey = { action: "set", value: " sk-new " }
    expect(speechPatch(current, form)).toEqual({ stt: { apiKey: null }, tts: { apiKey: "sk-new" } })
  })

  test("cleared optional fields are sent as null; speed as a number", () => {
    const form = speechForm(current)
    form.stt.language = ""
    form.tts.speed = "1.25"
    expect(speechPatch(current, form)).toEqual({ stt: { language: null }, tts: { speed: 1.25 } })
    form.tts.speed = ""
    expect(speechPatch(current, form).tts).toEqual({ speed: null })
  })

  test("switching to openai-compatible sends the base URL; OpenRouter never sends one", () => {
    const form = speechForm(current)
    form.stt.provider = "openai-compatible"
    form.stt.baseURL = "http://whisper:9000/v1"
    expect(speechPatch(current, form)).toEqual({ stt: { provider: "openai-compatible", baseURL: "http://whisper:9000/v1" } })
    form.tts.provider = "openrouter"
    form.tts.baseURL = "http://ignored"
    expect(speechPatch(current, form).tts).toEqual({ provider: "openrouter" })
  })
})

describe("validateSpeech", () => {
  test("valid form: no errors", () => {
    expect(validateSpeech(speechForm(current))).toEqual({})
  })

  test("model required; base URL required and http(s) for openai-compatible; voice required", () => {
    const form = speechForm(current)
    form.stt.model = " "
    form.tts.baseURL = "kokoro:8880"
    form.tts.voice = ""
    expect(validateSpeech(form)).toEqual({
      "stt.model": "Enter a model.",
      "tts.baseURL": "Enter an http:// or https:// URL.",
      "tts.voice": "Enter a voice.",
    })
    form.tts.baseURL = ""
    expect(validateSpeech(form)["tts.baseURL"]).toBe("Enter the server's base URL.")
  })

  test("speed must be a number from 0.25 to 4 when given", () => {
    const form = speechForm(current)
    for (const bad of ["fast", "0.1", "5"]) {
      form.tts.speed = bad
      expect(validateSpeech(form)["tts.speed"]).toBe("Use a number from 0.25 to 4.")
    }
    form.tts.speed = ""
    expect(validateSpeech(form)["tts.speed"]).toBeUndefined()
  })

  test("replacing a key needs a value", () => {
    const form = speechForm(current)
    form.stt.apiKey = { action: "set", value: "  " }
    expect(validateSpeech(form)).toEqual({ "stt.apiKey": "Paste the new key, or cancel." })
  })

  test("unknown provider", () => {
    const form = speechForm(current)
    form.stt.provider = "azure"
    expect(validateSpeech(form)["stt.provider"]).toBe("Choose a provider.")
  })
})

describe("voicesFor", () => {
  test("longest matching model prefix wins; none: empty", () => {
    expect(voicesFor(current.voiceHints, "tts-1-hd")).toEqual(["alloy", "nova"])
    expect(voicesFor(current.voiceHints, "gpt-4o-mini-tts")).toEqual(["coral"])
    expect(voicesFor({ "openai/": ["a"], "openai/gpt-4o": ["b"] }, "openai/gpt-4o-mini-tts")).toEqual(["b"])
    expect(voicesFor(current.voiceHints, "eleven")).toEqual([])
    expect(voicesFor(undefined, "tts-1")).toEqual([])
  })
})
