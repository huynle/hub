// HUB_* environment variables with the legacy VOICE_* / OPENCODE_VOICE_* / OPENCODE_HUB_* names as deprecated fallbacks.
import { describe, expect, test } from "bun:test"
import { hubEnv, LEGACY_ENV } from "../src/env"

function collect() {
  const messages: string[] = []
  return { messages, options: { warn: (m: string) => messages.push(m), seen: new Set<string>() } }
}

describe("hubEnv", () => {
  test("new names pass through without warnings", () => {
    const { messages, options } = collect()
    const env = hubEnv({ HUB_HOST: "0.0.0.0", HUB_PORT: "4097", OTHER: "x" }, options)
    expect(env.HUB_HOST).toBe("0.0.0.0")
    expect(env.HUB_PORT).toBe("4097")
    expect(env.OTHER).toBe("x")
    expect(messages).toEqual([])
  })

  test("a legacy name fills the new one and warns", () => {
    const { messages, options } = collect()
    const env = hubEnv({ VOICE_PUBLIC_URL: "https://hub.example.com", VOICE_HUB_CONFIG: "/etc/hub.json", OPENCODE_VOICE_CONFIG: "/c.json" }, options)
    expect(env.HUB_PUBLIC_URL).toBe("https://hub.example.com")
    expect(env.HUB_CONFIG).toBe("/etc/hub.json")
    expect(env.HUB_SPOKE_CONFIG).toBe("/c.json")
    expect(messages).toHaveLength(3)
    expect(messages.find((m) => m.includes("VOICE_PUBLIC_URL"))).toContain("HUB_PUBLIC_URL")
    expect(messages.find((m) => m.includes("VOICE_HUB_CONFIG"))).toContain("HUB_CONFIG")
    expect(messages.find((m) => m.includes("OPENCODE_VOICE_CONFIG"))).toContain("HUB_SPOKE_CONFIG")
  })

  test("HUB_SPOKE_CONFIG: OPENCODE_HUB_CONFIG (0.5) and OPENCODE_VOICE_CONFIG (<= 0.4) are fallbacks, newest first", () => {
    const one = collect()
    expect(hubEnv({ OPENCODE_HUB_CONFIG: "/hub.json" }, one.options).HUB_SPOKE_CONFIG).toBe("/hub.json")
    expect(one.messages).toEqual([expect.stringMatching(/OPENCODE_HUB_CONFIG is deprecated.*HUB_SPOKE_CONFIG/)])

    const both = collect()
    expect(hubEnv({ OPENCODE_HUB_CONFIG: "/hub.json", OPENCODE_VOICE_CONFIG: "/voice.json" }, both.options).HUB_SPOKE_CONFIG).toBe("/hub.json")
    expect(both.messages).toContainEqual(expect.stringMatching(/OPENCODE_VOICE_CONFIG is ignored because OPENCODE_HUB_CONFIG is set/))

    const all = collect()
    const env = hubEnv({ HUB_SPOKE_CONFIG: "/new.json", OPENCODE_HUB_CONFIG: "/hub.json", OPENCODE_VOICE_CONFIG: "/voice.json" }, all.options)
    expect(env.HUB_SPOKE_CONFIG).toBe("/new.json")
    expect(all.messages).toHaveLength(2)
    expect(all.messages.every((m) => /ignored because HUB_SPOKE_CONFIG is set/.test(m))).toBe(true)
  })

  test("the new name wins over the legacy one, which is reported as ignored", () => {
    const { messages, options } = collect()
    const env = hubEnv({ HUB_PORT: "5000", VOICE_PORT: "4097" }, options)
    expect(env.HUB_PORT).toBe("5000")
    expect(messages).toEqual([expect.stringMatching(/VOICE_PORT.*ignored.*HUB_PORT/)])
  })

  test("an empty new name still wins (explicitly set)", () => {
    const { options } = collect()
    expect(hubEnv({ HUB_STT_MODEL: "", VOICE_STT_MODEL: "m" }, options).HUB_STT_MODEL).toBe("")
  })

  test("each legacy name warns once per warner", () => {
    const { messages, options } = collect()
    hubEnv({ VOICE_AUTH: "oidc" }, options)
    hubEnv({ VOICE_AUTH: "oidc" }, options)
    hubEnv({ VOICE_AUTH: "oidc", VOICE_HOST: "h" }, options)
    expect(messages).toHaveLength(2)
  })

  test("does not modify its input", () => {
    const input = { VOICE_HOST: "h" }
    hubEnv(input, collect().options)
    expect(input).toEqual({ VOICE_HOST: "h" })
  })

  test("maps every documented setting", () => {
    expect(LEGACY_ENV).toMatchObject({
      HUB_HOST: ["VOICE_HOST"],
      HUB_PORT: ["VOICE_PORT"],
      HUB_PUBLIC_URL: ["VOICE_PUBLIC_URL"],
      HUB_STATE_DIR: ["VOICE_STATE_DIR"],
      HUB_CONFIG: ["VOICE_HUB_CONFIG"],
      HUB_AUTH: ["VOICE_AUTH"],
      HUB_OIDC_ISSUER: ["VOICE_OIDC_ISSUER"],
      HUB_OIDC_CLIENT_ID: ["VOICE_OIDC_CLIENT_ID"],
      HUB_OIDC_CLIENT_SECRET: ["VOICE_OIDC_CLIENT_SECRET"],
      HUB_OIDC_ALLOWED: ["VOICE_OIDC_ALLOWED"],
      HUB_OIDC_INSECURE_ISSUER: ["VOICE_OIDC_INSECURE_ISSUER"],
      HUB_ADMIN_EMAILS: ["VOICE_ADMIN_EMAILS"],
      HUB_STT_MODEL: ["VOICE_STT_MODEL"],
      HUB_TTS_MODEL: ["VOICE_TTS_MODEL"],
      HUB_VOICE: ["VOICE_VOICE"],
      HUB_MAX_AUDIO_BYTES: ["VOICE_MAX_AUDIO_BYTES"],
      HUB_MAX_SPEECH_CHARS: ["VOICE_MAX_SPEECH_CHARS"],
      HUB_TURN_TIMEOUT_MS: ["VOICE_TURN_TIMEOUT_MS"],
      HUB_VAPID_SUBJECT: ["VOICE_VAPID_SUBJECT"],
      HUB_SPOKE_CONFIG: ["OPENCODE_HUB_CONFIG", "OPENCODE_VOICE_CONFIG"],
    })
  })

  test("never echoes values (secrets) in warnings", () => {
    const { messages, options } = collect()
    hubEnv({ VOICE_OIDC_CLIENT_SECRET: "s3cr3t-value" }, options)
    expect(messages.join("\n")).not.toContain("s3cr3t-value")
  })
})
