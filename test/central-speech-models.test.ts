// Speech model lists of OpenAI-compatible gateways (src/central/speech/models.ts): which of a big, unlabeled
// /v1/models list are speech-to-text or text-to-speech models, the configured model always offered, and the
// full list (with a note) when nothing is labeled. The fixture is a trimmed real gateway list (ids, types and
// modalities only).
import { describe, expect, test } from "bun:test"
import fixture from "./fixtures/openai-compatible-gateway-models.json"
import { SPEECH_UNLABELED_NOTE, speechModelList } from "../src/central/speech/models"

const ids = (list: { models: Array<{ id: string }> }) => list.models.map((m) => m.id)

describe("speechModelList: an OpenAI-compatible gateway with ~1000 models", () => {
  test("the fixture is the big mixed list", () => {
    expect(fixture.data.length).toBeGreaterThan(900)
  })

  test("speech-to-text: transcription models only (named or audio-in/text-out), never chat, music or audio chat", () => {
    const list = speechModelList("stt", fixture, "openrouter/openai/gpt-4o-mini-transcribe")
    const got = ids(list)
    for (const id of [
      "openrouter/openai/gpt-4o-mini-transcribe",
      "openrouter/openai/gpt-4o-transcribe",
      "openrouter/openai/whisper-1",
      "openrouter/openai/whisper-large-v3",
      "openrouter/openai/whisper-large-v3-turbo",
      "openrouter/microsoft/mai-transcribe-1.5",
      "openrouter/mistralai/voxtral-mini-transcribe",
      "openrouter/qwen/qwen3-asr-flash-2026-02-10",
    ]) expect(got).toContain(id)
    for (const id of ["openrouter/openai/gpt-audio", "openrouter/openai/gpt-audio-mini", "openrouter/google/lyria-3-pro-preview", "auto/best-coding"]) expect(got).not.toContain(id)
    expect(got.length).toBeLessThan(20)
    expect(list.note).toBeUndefined()
    // The configured model comes first, marked current.
    expect(list.models[0]).toMatchObject({ id: "openrouter/openai/gpt-4o-mini-transcribe", current: true })
    expect(list.models.filter((m) => m.current)).toHaveLength(1)
  })

  test("text-to-speech: the configured model is offered even though the gateway does not list it", () => {
    const list = speechModelList("tts", fixture, "ortts/microsoft/mai-voice-2.1-flash")
    expect(list.models[0]).toEqual({ id: "ortts/microsoft/mai-voice-2.1-flash", name: "ortts/microsoft/mai-voice-2.1-flash", current: true })
    const got = ids(list)
    for (const id of ["openrouter/openai/gpt-audio", "openrouter/google/lyria-3-pro-preview", "openrouter/openai/whisper-1"]) {
      // Nothing in this list is labeled TTS: the full list is shown with a note instead (gpt-audio included there).
      if (list.note) continue
      expect(got).not.toContain(id)
    }
  })

  test("nothing labeled for a kind: the full list with a note, current still first", () => {
    const list = speechModelList("tts", fixture, "ortts/microsoft/mai-voice-2.1-flash")
    expect(list.note).toBe(SPEECH_UNLABELED_NOTE)
    expect(list.models.length).toBe(fixture.data.length + 1)
    expect(list.models[0]!.id).toBe("ortts/microsoft/mai-voice-2.1-flash")
  })
})

describe("speechModelList: rules", () => {
  const data = (models: Array<Record<string, unknown>>) => ({ data: models })

  test("text-to-speech by name or by audio output; music and transcription models are not", () => {
    const list = speechModelList(
      "tts",
      data([
        { id: "openai/tts-1", type: "audio" },
        { id: "openai/gpt-4o-mini-tts" },
        { id: "eleven/text-to-speech-v3" },
        { id: "acme/voice-2" },
        { id: "acme/speaker", type: "audio", output_modalities: ["speech"] },
        { id: "google/lyria-3", type: "audio", output_modalities: ["audio"] },
        { id: "openai/gpt-audio", type: "audio", output_modalities: ["text", "audio"] },
        { id: "openai/whisper-1", type: "audio" },
        { id: "acme/speech-to-text", type: "audio" },
        { id: "acme/tts-chat", type: "chat" },
        { id: "acme/embed-voice", type: "embedding" },
      ]),
      "",
    )
    expect(ids(list)).toEqual(["openai/tts-1", "openai/gpt-4o-mini-tts", "eleven/text-to-speech-v3", "acme/voice-2", "acme/speaker"])
    expect(list.note).toBeUndefined()
  })

  test("speech-to-text by name, explicit transcription output, or unlabeled audio-in/text-out", () => {
    const list = speechModelList(
      "stt",
      data([
        { id: "a/whisper" },
        { id: "a/stt-fast" },
        { id: "a/asr-1" },
        { id: "a/listener", output_modalities: ["transcription"] },
        { id: "a/nova-3", type: "audio" },
        { id: "a/tts-1", type: "audio" },
        { id: "a/gpt-audio", type: "audio", output_modalities: ["text", "audio"] },
        { id: "a/whisper-chat", type: "chat" },
        { id: "a/rerank", type: "rerank" },
      ]),
      "a/whisper",
    )
    expect(ids(list)).toEqual(["a/whisper", "a/stt-fast", "a/asr-1", "a/listener", "a/nova-3"])
    expect(list.models[0]).toMatchObject({ current: true })
  })

  test("names default to the id; junk entries are dropped; an empty list offers just the current model", () => {
    expect(speechModelList("stt", data([{ id: "x/whisper", name: "Whisper X" }, { name: "no id" }, null as never]), "")).toEqual({ models: [{ id: "x/whisper", name: "Whisper X" }] })
    expect(speechModelList("stt", { nope: true }, "m/whisper")).toEqual({ models: [{ id: "m/whisper", name: "m/whisper", current: true }] })
    expect(speechModelList("stt", undefined, "")).toEqual({ models: [] })
  })
})
