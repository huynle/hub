// The metadata source the hub marks its prompts and delivered messages with, so a spoke never takes them for the user's.

/** metadata.source of the prompts the hub sends. opencode-hub (0.5) wrote "opencode-hub", opencode-voice (<= 0.4) "opencode-voice". */
export const PROMPT_SOURCE = "hub"
const PROMPT_SOURCES: readonly unknown[] = [PROMPT_SOURCE, "opencode-hub", "opencode-voice"]
/** True for prompt metadata written by the hub, under either name. */
export const isHubPrompt = (metadata: unknown): boolean =>
  typeof metadata === "object" && metadata !== null && PROMPT_SOURCES.includes((metadata as { source?: unknown }).source)
