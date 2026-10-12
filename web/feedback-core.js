// Pure logic for voice feedback on the phone (no DOM, no audio APIs): playback speed, the live activity
// feed, spoken progress cues and the speech settings form. Imported by web/app.js and by bun tests.

// ---------- voice speed ----------

export const SPEED_MIN = 0.75
export const SPEED_MAX = 2
export const SPEED_STEP = 0.05
export const SPEED_DEFAULT = 1

/** A playback rate on the 0.05 grid within 0.75–2.0; junk (NaN, "", null, "fast") becomes 1. */
export function clampSpeed(value) {
  const n = typeof value === "string" ? (value.trim() ? Number(value) : Number.NaN) : Number(value ?? Number.NaN)
  if (!Number.isFinite(n)) return SPEED_DEFAULT
  const stepped = Math.round(n / SPEED_STEP) / Math.round(1 / SPEED_STEP)
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(stepped.toFixed(2))))
}

/** "1.0×", "1.25×", "0.75×". */
export function formatSpeed(value) {
  const n = clampSpeed(value)
  return `${Number.isInteger(n) ? n.toFixed(1) : String(n)}×`
}

// ---------- activity feed ----------

const SUBAGENT_STATE = { working: "working", blocked: "blocked", error: "failed", idle: "done" }
/** Longest subagent output line shown, and how much of its latest output is kept to find that line. */
const LINE_MAX = 160
const OUT_MAX = 600

/**
 * What one root session is doing right now: SSE activity items ({id, kind: "tool"|"thinking", tool?, summary?,
 * state, error?, at}) for the root and its subagents, plus subagent states from status trees. Items are deduped
 * by id (later events update in place), kept in time order and capped at `max` (oldest finished ones go first).
 * `rows()` flattens it for display: root items and subagent headers in time order, each subagent's own items
 * nested under its header (depth 1). Finished "thinking" items are hidden unless reasoning text streamed into them
 * (then they stay as "Thought"). Streamed text (SSE delta/reasoning) adds reasoning text to thinking rows, the
 * latest output line to subagent rows and the root's "writing" step; `pulse()` sums it up for the "now" header.
 */
export class ActivityFeed {
  constructor(rootID, { max = 30, maxSubagents = 10, maxText = 4000 } = {}) {
    this.rootID = rootID
    this.max = max
    this.maxSubagents = maxSubagents
    this.maxText = maxText
    this.items = [] // [{ id, sessionID, kind, tool?, summary?, state, error?, text?, at, seq }] by (at, seq)
    this.subagents = new Map() // id → { id, title?, state, at, since?, out?, msg?, line? }
    this.seq = 0
    this.rootState = undefined // root state from the last status tree
    this.rootSince = undefined // root run start (status tree `since`)
    this.busyAt = undefined // when this feed first saw the tree busy (fallback for since)
    this.writing = undefined // { messageID, at } while the root streams reply text
    this.lastAt = undefined // newest activity, text or state change
  }

  touch(at) {
    if (Number.isFinite(at) && !(this.lastAt >= at)) this.lastAt = at
  }

  /** Streamed reasoning text of `sessionID` (SSE reasoning): appended to its Thinking row. */
  reasoning(sessionID, messageID, delta, at = Date.now()) {
    const id = `thinking:${messageID}`
    if (!this.items.some((x) => x.id === id)) this.activity(sessionID, { id, kind: "thinking", state: "running", at })
    const entry = this.items.find((x) => x.id === id)
    if (entry) entry.text = `${entry.text ?? ""}${delta ?? ""}`.slice(-this.maxText)
    this.touch(at)
  }

  /** Streamed reply text of `sessionID` (SSE delta): the root is writing; a subagent shows its latest line. */
  text(sessionID, messageID, delta, at = Date.now()) {
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
    const line = sub.out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)
    if (line) sub.line = line.length > LINE_MAX ? `…${line.slice(-(LINE_MAX - 1))}` : line
  }

  /** One activity item for `sessionID` (the root or a subagent). */
  activity(sessionID, item) {
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
    const entry = { id: item.id, sessionID: session, kind: item.kind === "thinking" ? "thinking" : "tool", tool: item.tool, summary: item.summary, state: item.state ?? "running", error: item.error, at, seq: ++this.seq }
    let i = this.items.length
    while (i > 0 && this.items[i - 1].at > at) i--
    this.items.splice(i, 0, entry)
    if (session !== this.rootID && !this.subagents.has(session)) this.subagents.set(session, { id: session, state: "working", at })
    this.trim()
  }

  /** Items from GET /api/sessions/:id (each with its sessionID). */
  load(items) {
    for (const item of [...(items ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) this.activity(item.sessionID ?? this.rootID, item)
  }

  /** A status tree for this root (first entry the root itself). `now` timestamps newly seen subagents. */
  status(sessions, now = Date.now()) {
    const seen = new Set()
    const before = this.stateKey()
    let root
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
    const busy = root?.state === "working" || root?.state === "blocked" || [...this.subagents.values()].some((x) => x.state === "working" || x.state === "blocked")
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
  stateKey() {
    if (this.rootState === undefined) return undefined
    return [this.rootState, ...[...this.subagents.values()].map((x) => `${x.id}=${x.state}`)].join(" ")
  }

  trim() {
    while (this.items.length > this.max) {
      const i = this.items.findIndex((x) => x.state !== "running")
      this.items.splice(i === -1 ? 0 : i, 1)
    }
    if (this.subagents.size > this.maxSubagents) {
      const finished = [...this.subagents.values()].filter((x) => x.state === "done" || x.state === "failed").sort((a, b) => a.at - b.at)
      for (const sub of finished.slice(0, this.subagents.size - this.maxSubagents)) this.subagents.delete(sub.id)
    }
  }

  rows() {
    const visible = (x) => !(x.kind === "thinking" && x.state !== "running" && !x.text)
    const row = (x, depth) => ({
      key: x.id, depth, kind: x.kind, label: x.kind === "thinking" && x.state !== "running" ? "Thought" : itemLabel(x), state: x.state, error: x.error, sessionID: x.sessionID,
      ...(x.text ? { text: x.text } : {}),
    })
    const top = []
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
  now() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].state === "running") return itemLabel(this.items[i])
    const sub = [...this.subagents.values()].reverse().find((x) => x.state === "working")
    return sub ? `Subagent: ${sub.title || sub.id}` : undefined
  }

  /**
   * The "now" header: `busy` while the root or a subagent works; `label` is the root's newest step ("Thinking",
   * "Writing reply", "Running shell · bun test") plus working subagents ("2 subagents working"), else "Working";
   * "Needs you" / "Idle" when not busy. `since` is when the run started (status `since`, else first seen busy);
   * `lastAt` the newest activity seen.
   */
  pulse() {
    const working = [...this.subagents.values()].filter((x) => x.state === "working")
    const rootWorking = this.rootState === "working"
    const busy = rootWorking || working.length > 0
    const blocked = !busy && (this.rootState === "blocked" || [...this.subagents.values()].some((x) => x.state === "blocked"))
    let label = blocked ? "Needs you" : "Idle"
    let since
    if (busy) {
      const mine = this.items.filter((x) => x.sessionID === this.rootID)
      const running = [...mine].reverse().find((x) => x.state === "running")
      let step = running ? (running.kind === "thinking" ? "Thinking" : `Running ${itemLabel(running)}`) : undefined
      if (this.writing && !mine.some((x) => x.at > this.writing.at)) step = "Writing reply"
      const n = working.length
      const subs = n === 0 ? "" : step || n > 1 ? `${n} subagent${n === 1 ? "" : "s"} working` : `Subagent “${working[0].title || working[0].id}” working`
      label = step && subs ? `${step} · ${subs}` : step || subs || "Working"
      const starts = [rootWorking ? this.rootSince : undefined, ...working.map((x) => x.since)].filter(Number.isFinite)
      since = starts.length ? Math.min(...starts) : this.busyAt
    }
    return { busy, blocked, label, since, lastAt: this.lastAt }
  }
}

/** The last `lines` non-empty lines of `text`, trimmed, at most `maxChars` (cut at the start with "…"). */
export function tailText(text, lines = 4, maxChars = 600) {
  const out = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join("\n")
  return out.length > maxChars ? `…${out.slice(-(maxChars - 1))}` : out
}

/** "12s", "3m 05s", "1h 02m". */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const pad = (n) => String(n).padStart(2, "0")
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}

function itemLabel(x) {
  if (x.kind === "thinking") return "Thinking…"
  const name = x.tool || "tool"
  return x.summary ? `${name} · ${x.summary}` : name
}

// ---------- spoken progress cues ----------

export const CUE_PHRASES = Object.freeze({ working: "Working on it.", subagent: "Started a subagent.", still: "Still working." })

/**
 * Decides when conversation mode plays progress cues. Event methods take the current time and return earcons
 * to play at once ({type: "earcon", name: "heard" | "done"}); `tick(now)` (call about once a second) returns a
 * phrase to speak ({type: "speak", cue, text}) when one is due and nobody is talking:
 * - "Working on it." once, ≥ `ackMs` after an utterance was heard, while working, if the agent has not spoken;
 * - "Started a subagent." when a subagent starts, unless the agent spoke in the last `quietMs`;
 * - "Still working." while work continues and nothing was spoken for `stillMs` (so at most every `stillMs`).
 * Nothing is spoken while the user talks, the agent's speech plays or a cue plays; due cues wait until then,
 * and are dropped when the agent speaks first.
 */
export class CueScheduler {
  constructor({ ackMs = 5000, quietMs = 3000, stillMs = 40_000 } = {}) {
    Object.assign(this, { ackMs, quietMs, stillMs })
    this.enabled = true
    this.busy = false // work in progress (root or subagents)
    this.awaiting = undefined // heard time of an utterance not yet acknowledged
    this.pendingSubagent = false
    this.lastSay = -Infinity
    this.lastSpoke = -Infinity // last time anyone spoke (or work started): the "Still working." window
    this.user = false
    this.agent = false
    this.cue = false
  }

  get gated() {
    return this.user || this.agent || this.cue
  }

  heard(now) {
    this.awaiting = now
    return this.enabled && !this.user ? [{ type: "earcon", name: "heard" }] : []
  }

  working(on, now) {
    if (on && !this.busy) this.lastSpoke = Math.max(this.lastSpoke, now)
    if (!on) {
      this.awaiting = undefined
      this.pendingSubagent = false
    }
    this.busy = on
  }

  agentSaid(now) {
    this.lastSay = now
    this.spoke(now)
  }

  agentSpeaking(on, now) {
    this.agent = on
    this.spoke(now)
  }

  userTalking(on, now) {
    this.user = on
    if (!on) this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  cueSpeaking(on, now) {
    this.cue = on
    if (!on) this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  subagentStarted(now) {
    if (now - this.lastSay >= this.quietMs) this.pendingSubagent = true
  }

  subagentFinished() {
    return this.enabled && !this.user ? [{ type: "earcon", name: "done" }] : []
  }

  tick(now) {
    if (!this.enabled || this.gated) return []
    if (this.pendingSubagent) return this.say("subagent", now)
    if (this.awaiting !== undefined && this.busy && now - this.awaiting >= this.ackMs) return this.say("working", now)
    if (this.busy && now - this.lastSpoke >= this.stillMs) return this.say("still", now)
    return []
  }

  /** The agent spoke: no acknowledgement or subagent announcement needed any more. */
  spoke(now) {
    this.awaiting = undefined
    this.pendingSubagent = false
    this.lastSpoke = Math.max(this.lastSpoke, now)
  }

  say(cue, now) {
    this.spoke(now)
    return [{ type: "speak", cue, text: CUE_PHRASES[cue] }]
  }
}

const ACTIVE = new Set(["working", "blocked"])

/** Subagent (non-root) sessions that started working or finished (idle, error or gone) between two status trees. */
export function subagentChanges(prev, next, rootID) {
  const before = new Map((prev ?? []).filter((s) => s.id !== rootID).map((s) => [s.id, s.state]))
  const started = []
  const finished = []
  for (const s of next ?? []) {
    if (s.id === rootID) continue
    const was = before.get(s.id)
    before.delete(s.id)
    if (s.state === "working" && !ACTIVE.has(was)) started.push(s.id)
    else if (ACTIVE.has(was) && !ACTIVE.has(s.state)) finished.push(s.id)
  }
  for (const [id, was] of before) if (ACTIVE.has(was)) finished.push(id)
  return { started, finished }
}

/** True while any session of a status tree is working (blocked ones wait for the user). */
export function isWorking(sessions) {
  return (sessions ?? []).some((s) => s.state === "working")
}

// ---------- speech settings ----------

export const SPEECH_PROVIDERS = Object.freeze(["openrouter", "openai-compatible"])
const SPEECH_FIELDS = { stt: ["provider", "model", "baseURL", "language"], tts: ["provider", "model", "voice", "baseURL", "speed"] }
const str = (v) => (v === undefined || v === null ? "" : String(v).trim())

/** Editable form values for GET /api/settings/speech: every field a string, API keys untouched ("keep"). */
export function speechForm(settings) {
  const form = {}
  for (const kind of ["stt", "tts"]) {
    const card = settings?.[kind] ?? {}
    form[kind] = Object.fromEntries(SPEECH_FIELDS[kind].map((f) => [f, str(card[f])]))
    form[kind].apiKey = { action: "keep", value: "" }
  }
  return form
}

/**
 * Partial PUT body with only the fields that differ from `settings`: trimmed strings, speed as a number,
 * cleared optional fields as null, base URL only for openai-compatible, apiKey string (replace) / null (clear).
 */
export function speechPatch(settings, form) {
  const patch = {}
  for (const kind of ["stt", "tts"]) {
    const before = settings?.[kind] ?? {}
    const after = form[kind]
    const out = {}
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
  return patch
}

/** Inline errors keyed "stt.model", "tts.baseURL", …; empty object when the form can be saved. */
export function validateSpeech(form) {
  const errors = {}
  for (const kind of ["stt", "tts"]) {
    const card = form[kind]
    const err = (field, text) => (errors[`${kind}.${field}`] = text)
    if (!SPEECH_PROVIDERS.includes(str(card.provider))) err("provider", "Choose a provider.")
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
export function voicesFor(hints, model) {
  let best
  for (const prefix of Object.keys(hints ?? {})) {
    if (String(model ?? "").startsWith(prefix) && (best === undefined || prefix.length > best.length)) best = prefix
  }
  return best === undefined ? [] : [...hints[best]]
}

// ---------- speech onboarding ----------

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/** What the "Set up speech" banner shows; undefined when speech is ready (or the hub does not report it). */
export function speechSetup(ready, publicURL) {
  if (!ready || (ready.stt && ready.tts)) return undefined
  let local = false
  try {
    local = LOOPBACK_HOST.test(new URL(publicURL).hostname)
  } catch {
    local = false
  }
  return {
    reason: ready.reason || "Choose a speech provider and add its API key in Settings → Speech.",
    micBlocked: !ready.stt,
    ...(local ? { storage: "Keys are stored on this computer in ~/.local/state/opencode-voice" } : {}),
  }
}
