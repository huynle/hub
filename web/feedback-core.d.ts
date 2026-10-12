// Types for web/feedback-core.js (plain ES module used by the PWA without a build step).

// ---------- voice speed ----------

export const SPEED_MIN: 0.75
export const SPEED_MAX: 2
export const SPEED_STEP: 0.05
export const SPEED_DEFAULT: 1

/** A playback rate on the 0.05 grid within 0.75–2.0; junk (NaN, "", null, "fast") becomes 1. */
export function clampSpeed(value: unknown): number

/** "1.0×", "1.25×", "0.75×". */
export function formatSpeed(value: unknown): string

// ---------- activity feed ----------

export type ActivityState = "running" | "done" | "failed"

/** SSE {type:"activity"} item (GET /api/sessions/:id items also carry sessionID). */
export interface ActivityItem {
  readonly id: string
  readonly kind: "tool" | "thinking" | string
  readonly tool?: string
  readonly summary?: string
  readonly state: ActivityState | string
  readonly error?: string
  readonly at: number
  readonly sessionID?: string
}

export interface StatusEntry {
  readonly id: string
  readonly title?: string
  readonly state: string
  /** ms epoch when the session's current run started (working entries, newer hubs). */
  readonly since?: number
}

export interface FeedRow {
  readonly key: string
  /** 0 for root items and subagent headers, 1 for a subagent's own items. */
  readonly depth: number
  readonly kind: "tool" | "thinking" | "subagent"
  readonly label: string
  /** Items: running | done | failed. Subagents: working | blocked | done | failed. */
  readonly state: string
  readonly error?: string
  readonly sessionID: string
  /** Thinking rows: the streamed reasoning text (newest part). */
  readonly text?: string
  /** Subagent rows: the latest non-empty line of its streamed output. */
  readonly line?: string
}

/** The session's "now" header. */
export interface Pulse {
  /** The root or a subagent is working. */
  readonly busy: boolean
  /** Not busy, and something waits for the user. */
  readonly blocked: boolean
  /** "Thinking", "Writing reply", "Running shell · bun test", "2 subagents working", "Working", "Needs you", "Idle". */
  readonly label: string
  /** ms epoch the current run started (while busy). */
  readonly since: number | undefined
  /** ms epoch of the newest activity, text or state change seen. */
  readonly lastAt: number | undefined
}

export class ActivityFeed {
  constructor(rootID: string, options?: { max?: number; maxSubagents?: number; maxText?: number })
  readonly rootID: string
  activity(sessionID: string, item: ActivityItem): void
  /** SSE reasoning delta. */
  reasoning(sessionID: string, messageID: string, delta: string, at?: number): void
  /** SSE text delta. */
  text(sessionID: string, messageID: string | undefined, delta: string, at?: number): void
  load(items: readonly ActivityItem[] | undefined): void
  status(sessions: readonly StatusEntry[] | undefined, now?: number): void
  rows(): FeedRow[]
  now(): string | undefined
  pulse(): Pulse
}

/** The last `lines` non-empty lines of `text`, trimmed, at most `maxChars` (cut at the start with "…"). */
export function tailText(text: string | undefined, lines?: number, maxChars?: number): string

/** "12s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string

// ---------- spoken progress cues ----------

export type CueName = "working" | "subagent" | "still"
export const CUE_PHRASES: Readonly<Record<CueName, string>>

export type Cue = { readonly type: "earcon"; readonly name: "heard" | "done" } | { readonly type: "speak"; readonly cue: CueName; readonly text: string }

/** Decides when conversation mode plays progress cues; all times are injected (ms). */
export class CueScheduler {
  constructor(options?: { ackMs?: number; quietMs?: number; stillMs?: number })
  enabled: boolean
  readonly gated: boolean
  heard(now: number): Cue[]
  working(on: boolean, now: number): void
  agentSaid(now: number): void
  agentSpeaking(on: boolean, now: number): void
  userTalking(on: boolean, now: number): void
  cueSpeaking(on: boolean, now: number): void
  subagentStarted(now: number): void
  subagentFinished(now: number): Cue[]
  tick(now: number): Cue[]
}

/** Subagent (non-root) sessions that started working or finished (idle, error or gone) between two status trees. */
export function subagentChanges(prev: readonly StatusEntry[] | undefined, next: readonly StatusEntry[] | undefined, rootID: string): { started: string[]; finished: string[] }

/** True while any session of a status tree is working (blocked ones wait for the user). */
export function isWorking(sessions: readonly StatusEntry[] | undefined): boolean

// ---------- speech settings ----------

export type SpeechProvider = "openrouter" | "openai-compatible"
export const SPEECH_PROVIDERS: readonly SpeechProvider[]

export interface ApiKeyInfo {
  readonly set: boolean
  readonly last4?: string
  readonly source: "settings" | "env" | "none"
}

/** GET /api/settings/speech */
export interface SpeechSettings {
  readonly stt: { readonly provider: string; readonly model: string; readonly baseURL?: string; readonly language?: string; readonly apiKey: ApiKeyInfo }
  readonly tts: { readonly provider: string; readonly model: string; readonly voice: string; readonly baseURL?: string; readonly speed?: number; readonly apiKey: ApiKeyInfo }
  readonly voiceHints?: Readonly<Record<string, readonly string[]>>
}

export interface ApiKeyEdit {
  action: "keep" | "set" | "clear"
  value: string
}

export interface SpeechForm {
  stt: { provider: string; model: string; baseURL: string; language: string; apiKey: ApiKeyEdit }
  tts: { provider: string; model: string; voice: string; baseURL: string; speed: string; apiKey: ApiKeyEdit }
}

/** PUT /api/settings/speech body (partial). */
export interface SpeechPatch {
  stt?: Partial<Record<"provider" | "model" | "baseURL" | "language", string | null>> & { apiKey?: string | null }
  tts?: Partial<Record<"provider" | "model" | "voice" | "baseURL", string | null>> & { speed?: number | null; apiKey?: string | null }
}

export function speechForm(settings: SpeechSettings | undefined): SpeechForm
export function speechPatch(settings: SpeechSettings | undefined, form: SpeechForm): SpeechPatch
export function validateSpeech(form: SpeechForm): Record<string, string>
export function voicesFor(hints: Readonly<Record<string, readonly string[]>> | undefined, model: string): string[]

// ---------- speech onboarding ----------

/** `ready` from GET /api/settings/speech. */
export interface SpeechReadyView {
  readonly stt: boolean
  readonly tts: boolean
  readonly reason?: string
}

export interface SpeechSetup {
  /** Why speech is not usable yet (the hub's reason, else a generic one). */
  readonly reason: string
  /** No speech-to-text: the mic and conversation mode cannot work. */
  readonly micBlocked: boolean
  /** Where keys live, for a hub on this computer. */
  readonly storage?: string
}

/** What the "Set up speech" banner shows; undefined when speech is ready (or the hub does not report it). */
export function speechSetup(ready: SpeechReadyView | undefined, publicURL: string | undefined): SpeechSetup | undefined
