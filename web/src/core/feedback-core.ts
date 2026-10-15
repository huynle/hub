// Pure logic for voice feedback (no DOM, no audio APIs): playback speed, the live activity feed, spoken
// progress cues and the speech settings form.

// ---------- voice speed ----------

export const SPEED_MIN = 0.75
export const SPEED_MAX = 2
export const SPEED_STEP = 0.05
export const SPEED_DEFAULT = 1

/** A playback rate on the 0.05 grid within 0.75–2.0; junk (NaN, "", null, "fast") becomes 1. */
export function clampSpeed(value: unknown): number {
  const n = typeof value === "string" ? (value.trim() ? Number(value) : Number.NaN) : Number(value ?? Number.NaN)
  if (!Number.isFinite(n)) return SPEED_DEFAULT
  const stepped = Math.round(n / SPEED_STEP) / Math.round(1 / SPEED_STEP)
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(stepped.toFixed(2))))
}

/** "1.0×", "1.25×", "0.75×". */
export function formatSpeed(value: unknown): string {
  const n = clampSpeed(value)
  return `${Number.isInteger(n) ? n.toFixed(1) : String(n)}×`
}

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
  readonly busy: boolean
  readonly blocked: boolean
  readonly label: string
  readonly since: number | undefined
  readonly lastAt: number | undefined
}

interface FeedItem {
  id: string
  sessionID: string
  kind: "tool" | "thinking"
  tool?: string
  summary?: string
  state: string
  error?: string
  text?: string
  at: number
  seq: number
}

interface FeedSubagent {
  id: string
  title?: string
  state: string
  at: number
  since?: number
  out?: string
  msg?: string
  line?: string
}

const SUBAGENT_STATE: Record<string, string> = { working: "working", blocked: "blocked", error: "failed", idle: "done" }
/** Longest subagent output line shown, and how much of its latest output is kept to find that line. */
const LINE_MAX = 160
const OUT_MAX = 600

/**
 * What one root session is doing right now: SSE activity items for the root and its subagents, plus subagent
 * states from status trees. Items are deduped by id (later events update in place), kept in time order and
 * capped at `max` (oldest finished ones go first). `rows()` flattens it for display; `pulse()` sums it up.
 */
export class ActivityFeed {
  readonly rootID: string
  private max: number
  private maxSubagents: number
  private maxText: number
  private items: FeedItem[] = []
  private subagents = new Map<string, FeedSubagent>()
  private seq = 0
  private rootState: string | undefined
  private rootSince: number | undefined
  private busyAt: number | undefined
  private writing: { messageID: string | undefined; at: number } | undefined
  private lastAt: number | undefined

  constructor(rootID: string, { max = 30, maxSubagents = 10, maxText = 4000 }: { max?: number; maxSubagents?: number; maxText?: number } = {}) {
    this.rootID = rootID
    this.max = max
    this.maxSubagents = maxSubagents
    this.maxText = maxText
  }

  private touch(at: number | undefined): void {
    if (at !== undefined && Number.isFinite(at) && !((this.lastAt ?? -Infinity) >= at)) this.lastAt = at
  }

  /** Streamed reasoning text of `sessionID` (SSE reasoning): appended to its Thinking row. */
  reasoning(sessionID: string, messageID: string, delta: string, at = Date.now()): void {
    const id = `thinking:${messageID}`
    if (!this.items.some((x) => x.id === id)) this.activity(sessionID, { id, kind: "thinking", state: "running", at })
    const entry = this.items.find((x) => x.id === id)
    if (entry) entry.text = `${entry.text ?? ""}${delta ?? ""}`.slice(-this.maxText)
    this.touch(at)
  }

  /** Streamed reply text of `sessionID` (SSE delta): the root is writing; a subagent shows its latest line. */
  text(sessionID: string, messageID: string | undefined, delta: string, at = Date.now()): void {
    for (const x of this.items) if (x.sessionID === sessionID && x.kind === "thinking" && x.state === "running") x.state = "done"
    this.touch(at)
    if (sessionID === this.rootID) {
      this.writing = { messageID, at }
      return
    }
    let sub = this.subagents.get(sessionID)
    if (!sub) {
      sub = { id: sessionID, state: "working", at }
      this.subagents.set(sessionID, sub)
      this.trim()
    }
    if (sub.msg !== messageID) sub.out = ""
    sub.msg = messageID
    sub.out = `${sub.out ?? ""}${delta ?? ""}`.slice(-OUT_MAX)
    const line = sub.out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1)
    if (line) sub.line = line.length > LINE_MAX ? `…${line.slice(-(LINE_MAX - 1))}` : line
  }

  /** One activity item for `sessionID` (the root or a subagent). */
  activity(sessionID: string | undefined, item: ActivityItem): void {
    if (!item || typeof item.id !== "string") return
    const session = item.sessionID ?? sessionID ?? this.rootID
    const existing = this.items.find((x) => x.id === item.id)
    if (existing) {
      existing.state = item.state ?? existing.state
      if (item.error !== undefined) existing.error = item.error
      if (item.summary) existing.summary = item.summary
      if (item.tool) existing.tool = item.tool
      this.touch(item.at)
      return
    }
    const at = Number.isFinite(item.at) ? item.at : Date.now()
    this.touch(at)
    // A new step in a session ends that session's earlier thinking.
    for (const x of this.items) if (x.sessionID === session && x.kind === "thinking" && x.state === "running" && x.at <= at) x.state = "done"
    const entry: FeedItem = {
      id: item.id,
      sessionID: session,
      kind: item.kind === "thinking" ? "thinking" : "tool",
      tool: item.tool,
      summary: item.summary,
      state: item.state ?? "running",
      error: item.error,
      at,
      seq: ++this.seq,
    }
    let i = this.items.length
    while (i > 0 && this.items[i - 1]!.at > at) i--
    this.items.splice(i, 0, entry)
    if (session !== this.rootID && !this.subagents.has(session)) this.subagents.set(session, { id: session, state: "working", at })
    this.trim()
  }

  /** Items from GET /api/sessions/:id (each with its sessionID). */
  load(items: readonly ActivityItem[] | undefined): void {
    for (const item of [...(items ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) this.activity(item.sessionID ?? this.rootID, item)
  }

  /** A status tree for this root (first entry the root itself). `now` timestamps newly seen subagents. */
  status(sessions: readonly StatusEntry[] | undefined, now = Date.now()): void {
    const seen = new Set<string>()
    const before = this.stateKey()
    let root: StatusEntry | undefined
    for (const s of sessions ?? []) {
      if (s.id === this.rootID) {
        root = s
        continue
      }
      seen.add(s.id)
      const state = SUBAGENT_STATE[s.state] ?? "working"
      const known = this.subagents.get(s.id)
      if (known) {
        known.state = state
        if (s.title) known.title = s.title
        known.since = s.since
      } else if (state !== "done") {
        this.subagents.set(s.id, { id: s.id, title: s.title, state, at: now, since: s.since })
      }
    }
    for (const sub of this.subagents.values()) if (!seen.has(sub.id) && (sub.state === "working" || sub.state === "blocked")) sub.state = "done"
    const busy =
      root?.state === "working" ||
      root?.state === "blocked" ||
      [...this.subagents.values()].some((x) => x.state === "working" || x.state === "blocked")
    if (root && !busy) for (const x of this.items) if (x.state === "running") x.state = "done"
    if (root) {
      this.rootState = root.state
      this.rootSince = root.since
      if (root.state !== "working") this.writing = undefined
    }
    const working = this.rootState === "working" || [...this.subagents.values()].some((x) => x.state === "working")
    if (!working) this.busyAt = undefined
    else if (this.busyAt === undefined) this.busyAt = now
    // The first tree only seeds the feed; later changes count as activity.
    if (before !== undefined && before !== this.stateKey()) this.touch(now)
    this.trim()
  }

  /** Root and subagent states as one string (undefined before the first status tree). */
  private stateKey(): string | undefined {
    if (this.rootState === undefined) return undefined
    return [this.rootState, ...[...this.subagents.values()].map((x) => `${x.id}=${x.state}`)].join(" ")
  }

  private trim(): void {
    while (this.items.length > this.max) {
      const i = this.items.findIndex((x) => x.state !== "running")
      this.items.splice(i === -1 ? 0 : i, 1)
    }
    if (this.subagents.size > this.maxSubagents) {
      const finished = [...this.subagents.values()].filter((x) => x.state === "done" || x.state === "failed").sort((a, b) => a.at - b.at)
      for (const sub of finished.slice(0, this.subagents.size - this.maxSubagents)) this.subagents.delete(sub.id)
    }
  }

  rows(): FeedRow[] {
    const visible = (x: FeedItem) => !(x.kind === "thinking" && x.state !== "running" && !x.text)
    const row = (x: FeedItem, depth: number): FeedRow => ({
      key: x.id,
      depth,
      kind: x.kind,
      label: x.kind === "thinking" && x.state !== "running" ? "Thought" : itemLabel(x),
      state: x.state,
      error: x.error,
      sessionID: x.sessionID,
      ...(x.text ? { text: x.text } : {}),
    })
    const top: Array<{ at: number; seq: number; rows: FeedRow[] }> = []
    for (const x of this.items) if (x.sessionID === this.rootID && visible(x)) top.push({ at: x.at, seq: x.seq, rows: [row(x, 0)] })
    for (const sub of this.subagents.values()) {
      top.push({
        at: sub.at,
        seq: 0,
        rows: [
          { key: `sub:${sub.id}`, depth: 0, kind: "subagent", label: sub.title || sub.id, state: sub.state, sessionID: sub.id, ...(sub.line ? { line: sub.line } : {}) },
          ...this.items.filter((x) => x.sessionID === sub.id && visible(x)).map((x) => row(x, 1)),
        ],
      })
    }
    return top.sort((a, b) => a.at - b.at || a.seq - b.seq).flatMap((t) => t.rows)
  }

  /** The newest running step ("shell · bun test", "Thinking…"), else "Subagent: <title>" while one works. */
  now(): string | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.state === "running") return itemLabel(this.items[i]!)
    const sub = [...this.subagents.values()].reverse().find((x) => x.state === "working")
    return sub ? `Subagent: ${sub.title || sub.id}` : undefined
  }

  /**
   * The "now" header: `busy` while the root or a subagent works; `label` is the root's newest step plus working
   * subagents, else "Working"; "Needs you" / "Idle" when not busy. `since` is when the run started; `lastAt` the
   * newest activity seen.
   */
  pulse(): Pulse {
    const working = [...this.subagents.values()].filter((x) => x.state === "working")
    const rootWorking = this.rootState === "working"
    const busy = rootWorking || working.length > 0
    const blocked = !busy && (this.rootState === "blocked" || [...this.subagents.values()].some((x) => x.state === "blocked"))
    let label = blocked ? "Needs you" : "Idle"
    let since: number | undefined
    if (busy) {
      const mine = this.items.filter((x) => x.sessionID === this.rootID)
      const running = [...mine].reverse().find((x) => x.state === "running")
      let step = running ? (running.kind === "thinking" ? "Thinking" : `Running ${itemLabel(running)}`) : undefined
      const writing = this.writing
      if (writing && !mine.some((x) => x.at > writing.at)) step = "Writing reply"
      const n = working.length
      const subs =
        n === 0 ? "" : step || n > 1 ? `${n} subagent${n === 1 ? "" : "s"} working` : `Subagent “${working[0]!.title || working[0]!.id}” working`
      label = step && subs ? `${step} · ${subs}` : step || subs || "Working"
      const starts = [rootWorking ? this.rootSince : undefined, ...working.map((x) => x.since)].filter(
        (x): x is number => typeof x === "number" && Number.isFinite(x),
      )
      since = starts.length ? Math.min(...starts) : this.busyAt
    }
    return { busy, blocked, label, since, lastAt: this.lastAt }
  }
}

/** The last `lines` non-empty lines of `text`, trimmed, at most `maxChars` (cut at the start with "…"). */
export function tailText(text: string | undefined, lines = 4, maxChars = 600): string {
  const out = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n")
  return out.length > maxChars ? `…${out.slice(-(maxChars - 1))}` : out
}

/** "12s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const pad = (n: number) => String(n).padStart(2, "0")
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}

function itemLabel(x: { kind: string; tool?: string; summary?: string }): string {
  if (x.kind === "thinking") return "Thinking…"
  const name = x.tool || "tool"
  return x.summary ? `${name} · ${x.summary}` : name
}

// ---------- spoken progress cues ----------

export type CueName = "working" | "subagent" | "still"
export const CUE_PHRASES: Readonly<Record<CueName, string>> = Object.freeze({
  working: "Working on it.",
  subagent: "Started a subagent.",
  still: "Still working.",
})

export type Cue = { readonly type: "earcon"; readonly name: "heard" | "done" } | { readonly type: "speak"; readonly cue: CueName; readonly text: string }

/**
 * Decides when conversation mode plays progress cues. Event methods take the current time and return earcons
 * to play at once; `tick(now)` (call about once a second) returns a phrase to speak when one is due and nobody
 * is talking:
 * - "Working on it." once, ≥ `ackMs` after an utterance was heard, while working, if the agent has not spoken;
 * - "Started a subagent." when a subagent starts, unless the agent spoke in the last `quietMs`;
 * - "Still working." while work continues and nothing was spoken for `stillMs`.
 */
export class CueScheduler {
  ackMs: number
  quietMs: number
  stillMs: number
  enabled = true
  private busy = false
  private awaiting: number | undefined
  private pendingSubagent = false
  private lastSay = -Infinity
  private lastSpoke = -Infinity
  private user = false
  private agent = false
  private cue = false

  constructor({ ackMs = 5000, quietMs = 3000, stillMs = 40_000 }: { ackMs?: number; quietMs?: number; stillMs?: number } = {}) {
    this.ackMs = ackMs
    this.quietMs = quietMs
    this.stillMs = stillMs
  }

  get gated(): boolean {
    return this.user || this.agent || this.cue
  }

  heard(now: number): Cue[] {
    this.awaiting = now
    return this.enabled && !this.user ? [{ type: "earcon", name: "heard" }] : []
  }

  working(on: boolean, now: number): void {
    if (on && !this.busy) this.lastSpoke = Math.max(this.lastSpoke, now)
    if (!on) {
      this.awaiting = undefined
      this.pendingSubagent = false
    }
    this.busy = on
  }

  agentSaid(now: number): void {
    this.lastSay = now
    this.spoke(now)
  }

  agentSpeaking(on: boolean, now: number): void {
    this.agent = on
    this.spoke(now)
  }

  userTalking(on: boolean, now: number): void {
    this.user = on
    if (!on) this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  cueSpeaking(on: boolean, now: number): void {
    this.cue = on
    if (!on) this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  subagentStarted(now: number): void {
    if (now - this.lastSay >= this.quietMs) this.pendingSubagent = true
  }

  subagentFinished(_now?: number): Cue[] {
    return this.enabled && !this.user ? [{ type: "earcon", name: "done" }] : []
  }

  tick(now: number): Cue[] {
    if (!this.enabled || this.gated) return []
    if (this.pendingSubagent) return this.say("subagent", now)
    if (this.awaiting !== undefined && this.busy && now - this.awaiting >= this.ackMs) return this.say("working", now)
    if (this.busy && now - this.lastSpoke >= this.stillMs) return this.say("still", now)
    return []
  }

  /** The agent spoke: no acknowledgement or subagent announcement needed any more. */
  private spoke(now: number): void {
    this.awaiting = undefined
    this.pendingSubagent = false
    this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  private say(cue: CueName, now: number): Cue[] {
    this.spoke(now)
    return [{ type: "speak", cue, text: CUE_PHRASES[cue] }]
  }
}

const ACTIVE = new Set(["working", "blocked"])

/** Subagent (non-root) sessions that started working or finished (idle, error or gone) between two status trees. */
export function subagentChanges(
  prev: readonly StatusEntry[] | undefined,
  next: readonly StatusEntry[] | undefined,
  rootID: string,
): { started: string[]; finished: string[] } {
  const before = new Map((prev ?? []).filter((s) => s.id !== rootID).map((s) => [s.id, s.state]))
  const started: string[] = []
  const finished: string[] = []
  for (const s of next ?? []) {
    if (s.id === rootID) continue
    const was = before.get(s.id)
    before.delete(s.id)
    if (s.state === "working" && !ACTIVE.has(was ?? "")) started.push(s.id)
    else if (ACTIVE.has(was ?? "") && !ACTIVE.has(s.state)) finished.push(s.id)
  }
  for (const [id, was] of before) if (ACTIVE.has(was)) finished.push(id)
  return { started, finished }
}

/** True while any session of a status tree is working (blocked ones wait for the user). */
export function isWorking(sessions: readonly StatusEntry[] | undefined): boolean {
  return (sessions ?? []).some((s) => s.state === "working")
}

// ---------- speech settings ----------

export type SpeechProvider = "openrouter" | "openai-compatible"
export const SPEECH_PROVIDERS: readonly SpeechProvider[] = Object.freeze(["openrouter", "openai-compatible"] as const)

export interface ApiKeyInfo {
  readonly set: boolean
  readonly last4?: string
  readonly source: "settings" | "env" | "none" | "config" | "user" | string
}

/** GET /api/settings/speech */
export interface SpeechSettings {
  readonly stt: { readonly provider: string; readonly model: string; readonly baseURL?: string; readonly language?: string; readonly apiKey: ApiKeyInfo }
  readonly tts: {
    readonly provider: string
    readonly model: string
    readonly voice: string
    readonly baseURL?: string
    readonly speed?: number
    readonly apiKey: ApiKeyInfo
  }
  readonly voiceHints?: Readonly<Record<string, readonly string[]>>
  readonly ready?: SpeechReadyView
  readonly scope?: string
  readonly [key: string]: unknown
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

const SPEECH_FIELDS = { stt: ["provider", "model", "baseURL", "language"], tts: ["provider", "model", "voice", "baseURL", "speed"] } as const
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim())

/** Editable form values for GET /api/settings/speech: every field a string, API keys untouched ("keep"). */
export function speechForm(settings: SpeechSettings | undefined): SpeechForm {
  const form: Record<string, Record<string, unknown>> = {}
  for (const kind of ["stt", "tts"] as const) {
    const card = (settings?.[kind] ?? {}) as Record<string, unknown>
    form[kind] = Object.fromEntries(SPEECH_FIELDS[kind].map((f) => [f, str(card[f])]))
    form[kind].apiKey = { action: "keep", value: "" }
  }
  return form as unknown as SpeechForm
}

/**
 * Partial PUT body with only the fields that differ from `settings`: trimmed strings, speed as a number,
 * cleared optional fields as null, base URL only for openai-compatible, apiKey string (replace) / null (clear).
 */
export function speechPatch(settings: SpeechSettings | undefined, form: SpeechForm): SpeechPatch {
  const patch: Record<string, Record<string, unknown>> = {}
  for (const kind of ["stt", "tts"] as const) {
    const before = (settings?.[kind] ?? {}) as Record<string, unknown>
    const after = form[kind] as unknown as Record<string, unknown> & { apiKey?: ApiKeyEdit }
    const out: Record<string, unknown> = {}
    for (const field of SPEECH_FIELDS[kind]) {
      if (field === "baseURL" && str(after.provider) !== "openai-compatible") continue
      const next = str(after[field])
      if (next === str(before[field])) continue
      out[field] = next === "" ? null : field === "speed" ? Number(next) : next
    }
    if (after.apiKey?.action === "set") out.apiKey = str(after.apiKey.value)
    else if (after.apiKey?.action === "clear") out.apiKey = null
    if (Object.keys(out).length) patch[kind] = out
  }
  return patch as SpeechPatch
}

/** Inline errors keyed "stt.model", "tts.baseURL", …; empty object when the form can be saved. */
export function validateSpeech(form: SpeechForm): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const kind of ["stt", "tts"] as const) {
    const card = form[kind] as unknown as Record<string, unknown> & { apiKey?: ApiKeyEdit }
    const err = (field: string, text: string) => (errors[`${kind}.${field}`] = text)
    if (!SPEECH_PROVIDERS.includes(str(card.provider) as SpeechProvider)) err("provider", "Choose a provider.")
    if (!str(card.model)) err("model", "Enter a model.")
    if (str(card.provider) === "openai-compatible") {
      const url = str(card.baseURL)
      if (!url) err("baseURL", "Enter the server's base URL.")
      else if (!/^https?:\/\/[^\s/]+/i.test(url)) err("baseURL", "Enter an http:// or https:// URL.")
    }
    if (kind === "tts") {
      if (!str(card.voice)) err("voice", "Enter a voice.")
      const speed = str(card.speed)
      if (speed && !(Number(speed) >= 0.25 && Number(speed) <= 4)) err("speed", "Use a number from 0.25 to 4.")
    }
    if (card.apiKey?.action === "set" && !str(card.apiKey.value)) err("apiKey", "Paste the new key, or cancel.")
  }
  return errors
}

/** Voice suggestions for a TTS model: the hint list of the longest model prefix that matches. */
export function voicesFor(hints: Readonly<Record<string, readonly string[]>> | undefined, model: string): string[] {
  let best: string | undefined
  for (const prefix of Object.keys(hints ?? {})) {
    if (String(model ?? "").startsWith(prefix) && (best === undefined || prefix.length > best.length)) best = prefix
  }
  return best === undefined ? [] : [...(hints![best] ?? [])]
}

// ---------- speech onboarding ----------

/** `ready` from GET /api/settings/speech. */
export interface SpeechReadyView {
  readonly stt: boolean
  readonly tts: boolean
  readonly reason?: string
}

export interface SpeechSetup {
  readonly reason: string
  readonly micBlocked: boolean
  readonly storage?: string
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/** What the "Set up speech" banner shows; undefined when speech is ready (or the hub does not report it). */
export function speechSetup(ready: SpeechReadyView | undefined, publicURL: string | undefined): SpeechSetup | undefined {
  if (!ready || (ready.stt && ready.tts)) return undefined
  let local = false
  try {
    local = LOOPBACK_HOST.test(new URL(publicURL ?? "").hostname)
  } catch {
    local = false
  }
  return {
    reason: ready.reason || "Choose a speech provider and add its API key in Settings → Speech.",
    micBlocked: !ready.stt,
    ...(local ? { storage: "Keys are stored on this computer in ~/.local/state/opencode-hub" } : {}),
  }
}
