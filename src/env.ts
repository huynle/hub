// Environment variables of Hub. The project was called opencode-voice, then opencode-hub: their VOICE_*,
// OPENCODE_VOICE_* and OPENCODE_HUB_* names are still read as fallbacks (the new HUB_* name wins, then the
// most recent legacy name), with a one-time deprecation warning per legacy name. Code reads only the new names from hubEnv(env).

export type Env = Readonly<Record<string, string | undefined>>

/** New name → legacy names, most recent first. */
export const LEGACY_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
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
  /** The spoke (plugin) config file: OPENCODE_HUB_CONFIG in 0.5, OPENCODE_VOICE_CONFIG before. */
  HUB_SPOKE_CONFIG: ["OPENCODE_HUB_CONFIG", "OPENCODE_VOICE_CONFIG"],
})

export interface HubEnvOptions {
  /** Where deprecation warnings go (default console.warn with the [hub] prefix). */
  readonly warn?: (message: string) => void
  /** Legacy names already warned about (default: once per process). */
  readonly seen?: Set<string>
}

const processSeen = new Set<string>()
const defaultWarn = (message: string) => console.warn(`[hub] warning: ${message}`)

/** A copy of `env` with every unset HUB_* name filled from its legacy name. Never echoes values. */
export function hubEnv(env: Env = process.env, options: HubEnvOptions = {}): Env {
  const warn = options.warn ?? defaultWarn
  const seen = options.seen ?? processSeen
  const out: Record<string, string | undefined> = { ...env }
  for (const [name, legacies] of Object.entries(LEGACY_ENV)) {
    // The name that supplies the value: the new one when set, else the first legacy one set.
    let winner = env[name] !== undefined ? name : undefined
    for (const legacy of legacies) {
      if (env[legacy] === undefined) continue
      const ignored = winner !== undefined
      if (!ignored) {
        winner = legacy
        out[name] = env[legacy]
      }
      if (seen.has(legacy)) continue
      seen.add(legacy)
      warn(ignored ? `${legacy} is ignored because ${winner} is set; remove ${legacy}` : `${legacy} is deprecated; rename it to ${name}`)
    }
  }
  return out
}
