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
/** Short spoken variants per cue; CuePicker rotates through them so no phrase plays twice in a row. */
export const CUE_VARIANTS: Readonly<Record<CueName, readonly string[]>> = Object.freeze({
  working: Object.freeze([
    "On it.",
    "Give me a sec.",
    "One moment.",
    "Let me check.",
    "Okay, looking into it.",
    "Sure, one sec.",
    "Hang on.",
    "Let me see.",
    "Checking now.",
    "Bear with me.",
  ]),
  subagent: Object.freeze([
    "I'll hand that off.",
    "Starting that in the background.",
    "Sending that off now.",
    "Getting a helper on it.",
    "Passing that along.",
  ]),
  still: Object.freeze([
    "Still on it.",
    "Almost there.",
    "Still working through it.",
    "Bear with me, still going.",
    "Taking a bit longer.",
  ]),
})

/** Every cue phrase, interleaved by kind (one of each kind first) so prefetching readies each kind early. */
export function cueTexts(): string[] {
  const lists = Object.values(CUE_VARIANTS)
  const out: string[] = []
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) for (const l of lists) if (i < l.length) out.push(l[i]!)
  return out
}

/**
 * Chooses which variant of a cue to speak: a shuffle-bag per kind (every variant once per round, reshuffled
 * each round), never the phrase that played last for that kind. With `ready` (cached audio), a ready variant
 * wins: the next ready one in the bag, else the least recently used ready one; with none ready it returns a
 * fresh variant anyway (the player plays its pending tone and loads it).
 */
export class CuePicker {
  private rng: () => number
  private ready: (text: string) => boolean
  private bags = new Map<CueName, string[]>()
  private last = new Map<CueName, string>()
  private used = new Map<string, number>()
  private count = 0

  constructor({ rng = Math.random, ready = () => true }: { rng?: () => number; ready?: (text: string) => boolean } = {}) {
    this.rng = rng
    this.ready = ready
  }

  pick(cue: CueName): string {
    const all = CUE_VARIANTS[cue]
    const last = this.last.get(cue)
    let bag = this.bags.get(cue)
    if (!bag?.length) {
      bag = this.shuffle(all)
      if (bag.length > 1 && bag[0] === last) bag.push(bag.shift()!)
      this.bags.set(cue, bag)
    }
    const fresh = (t: string) => t !== last || all.length < 2
    let i = bag.findIndex((t) => fresh(t) && this.ready(t))
    let text: string | undefined
    if (i >= 0) text = bag.splice(i, 1)[0]
    else {
      const lru = all.filter((t) => fresh(t) && this.ready(t)).sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))[0]
      if (lru) text = lru
      else {
        i = bag.findIndex(fresh)
        text = i >= 0 ? bag.splice(i, 1)[0] : all.find(fresh)
      }
    }
    text ??= all[0]!
    this.last.set(cue, text)
    this.used.set(text, ++this.count)
    return text
  }

  private shuffle(list: readonly string[]): string[] {
    const out = [...list]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }
}

export type Cue = { readonly type: "earcon"; readonly name: "heard" | "done" } | { readonly type: "speak"; readonly cue: CueName; readonly text: string }

/**
 * Decides when conversation mode plays progress cues. Event methods take the current time and return earcons
 * to play at once; `tick(now)` returns a phrase to speak when one is due and nobody is talking, and
 * `nextDue(now)` says when that will be (CueClock arms one timer for it); which variant is spoken comes from
 * `pick` (default: a CuePicker):
 * - a short acknowledgement ("On it.", "One moment." …) once, ≥ `ackMs` after the end of the speech that was sent (`awaitReply`; else after the hub
 *   reported it heard), while working, if the agent has not spoken;
 * - a hand-off phrase ("I'll hand that off." …) when a subagent starts, unless the agent spoke in the last `quietMs`;
 * - a still-working phrase ("Still on it." …) while work continues and nothing was spoken for `stillMs`.
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

  private pick: (cue: CueName) => string

  constructor({ ackMs = 2500, quietMs = 3000, stillMs = 40_000, pick }: { ackMs?: number; quietMs?: number; stillMs?: number; pick?: (cue: CueName) => string } = {}) {
    if (!pick) {
      const picker = new CuePicker()
      pick = (cue) => picker.pick(cue)
    }
    this.pick = pick
    this.ackMs = ackMs
    this.quietMs = quietMs
    this.stillMs = stillMs
  }

  get gated(): boolean {
    return this.user || this.agent || this.cue
  }

  /**
   * The hub reports an utterance reached the agent. `tone: false` when it was already acknowledged locally
   * (`speechEnded`), so the earcon does not play twice.
   */
  heard(now: number, { tone = true }: { tone?: boolean } = {}): Cue[] {
    this.awaiting = Math.min(this.awaiting ?? now, now)
    return tone && this.enabled && !this.user ? [{ type: "earcon", name: "heard" }] : []
  }

  /** An utterance whose speech ended at `since` was sent: the acknowledgement counts from then. */
  awaitReply(since: number): void {
    this.awaiting = since
  }

  /** The VAD ended a segment of speech that goes to transcription: acknowledge it at once. */
  speechEnded(now: number): Cue[] {
    this.userTalking(false, now)
    return this.enabled ? [{ type: "earcon", name: "heard" }] : []
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

  /** When `tick` will next have a phrase to speak; undefined when nothing is pending or someone is talking. */
  nextDue(now: number): number | undefined {
    if (!this.enabled || this.gated) return undefined
    if (this.pendingSubagent) return now
    if (!this.busy) return undefined
    return Math.min(this.awaiting !== undefined ? this.awaiting + this.ackMs : Infinity, this.lastSpoke + this.stillMs)
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
    return [{ type: "speak", cue, text: this.pick(cue) }]
  }
}

export interface CueClockOptions {
  readonly scheduler: CueScheduler
  readonly play: (cues: Cue[]) => void
  /** False while cues must wait (Voice mode muted or off): nothing is armed; poke again when ready. */
  readonly ready?: () => boolean
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (id: any) => void
}

/**
 * Plays the scheduler's phrases right on their deadline: one timer for `nextDue`, re-armed by `poke()` after
 * anything that may change it (speech, status, cue or agent playback). Nothing runs while nothing is due.
 */
export class CueClock {
  private scheduler: CueScheduler
  private playFn: (cues: Cue[]) => void
  private ready: () => boolean
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (id: any) => void
  private timer: unknown

  // The defaults wrap the globals: called as `this.setTimer(…)`, a bare setTimeout throws "Illegal invocation" in browsers.
  constructor({ scheduler, play, ready = () => true, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }: CueClockOptions) {
    this.scheduler = scheduler
    this.playFn = play
    this.ready = ready
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
  }

  poke(): void {
    this.stop()
    if (!this.ready()) return
    // A due phrase plays at once; playing it moves the deadline (bounded in case it does not).
    for (let i = 0; i < 3; i++) {
      const now = this.now()
      const due = this.scheduler.nextDue(now)
      if (due === undefined || !Number.isFinite(due)) return
      if (due > now) {
        this.timer = this.setTimer(() => {
          this.timer = undefined
          this.poke()
        }, due - now)
        return
      }
      const cues = this.scheduler.tick(now)
      if (cues.length) this.playFn(cues)
    }
  }

  stop(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
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
    ...(local ? { storage: "Keys are stored on this computer in ~/.local/state/hub" } : {}),
  }
}
