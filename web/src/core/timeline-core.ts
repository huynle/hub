// Pure session-timeline state (no DOM): timeline items keyed by `key` (history pages and live updates
// merge in place), subagent rows from status trees with their own items nested under them, lazily loaded
// tool details, and the model catalog for the Voice/Worker model menus.
//
// Order: rows never sort by wall-clock time (`at` comes from different clocks: OpenCode's message and part times,
// the hub's, this device's). History rows carry the spoke's ordering position (`pos`: session message order, then
// part order). Live rows (streamed thoughts and text, tool activity, sent messages) go after the history rows
// that were loaded when they arrived, in arrival order; when their stored row arrives it takes their place. A
// subagent row stands in place of the tool call that spawned it; without a loaded spawn it stays where it first
// appeared live, or (seen before any of its history was loaded) at the top of the loaded history.

export interface ModelSelection {
  providerID: string
  modelID: string
  variant?: string
}
export interface ModelItem extends ModelSelection {
  name?: string
  enabled?: boolean
  variants?: string[]
  stale?: boolean
}

const fold = (value: unknown) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
const modelKey = (model: ModelSelection) => `${model.providerID}/${model.modelID}`

export class ModelCatalog {
  readonly models: ModelItem[]

  constructor(models: ModelItem[] = []) {
    this.models = Array.isArray(models)
      ? models.filter((model) => model && typeof model.providerID === "string" && typeof model.modelID === "string")
      : []
  }

  groups(search = ""): Array<{ providerID: string; items: ModelItem[] }> {
    const query = fold(search.trim())
    const byProvider = new Map<string, ModelItem[]>()
    // Disabled models are hidden, unless the catalog reports every model disabled (then nothing would show).
    const hideDisabled = this.models.some((model) => model.enabled !== false)
    for (const model of this.models) {
      if (hideDisabled && model.enabled === false) continue
      if (query && !fold([model.name, model.modelID, model.providerID].join(" ")).includes(query)) continue
      const items = byProvider.get(model.providerID) ?? []
      items.push({ ...model, variants: [...(model.variants ?? [])] })
      byProvider.set(model.providerID, items)
    }
    return [...byProvider]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerID, items]) => ({ providerID, items: items.sort((a, b) => (a.name || a.modelID).localeCompare(b.name || b.modelID)) }))
  }

  selection(value?: ModelSelection): ModelItem | undefined {
    if (!value) return undefined
    const found = this.models.find((model) => model.providerID === value.providerID && model.modelID === value.modelID)
    if (found) return { ...found, variants: [...(found.variants ?? [])], stale: found.enabled === false }
    return { ...value, name: modelKey(value), variants: value.variant ? [value.variant] : [], stale: true }
  }
}

export interface TimelineRow {
  key: string
  kind: string
  sessionID?: string
  messageID?: string
  partID?: string
  text?: string
  name?: string
  label?: string
  state?: string
  at?: number
  completed?: number
  depth?: number
  detail?: unknown
  /** History rows: ordering position from the spoke (session message order, then part order). */
  pos?: number
  /** Tool rows: the tool call ID. */
  callID?: string
  /** Subagent tool rows: the child session the call spawned. */
  childSessionID?: string
  [key: string]: unknown
}

/** Key of the thought built from live deltas of a message (before its stored row is known). */
const reasoningKey = (messageID: string) => `${messageID}:reasoning`
/** Key of live text of a message's text part (`ordinal`; all its text with hubs that do not send it). */
const textKey = (messageID: string, ordinal?: number) => (ordinal === undefined ? `${messageID}:text` : `${messageID}:text:${ordinal}`)
/** Key of a live tool activity item. */
const activityKey = (sessionID: string, id: string) => `activity:${sessionID}:${id}`

export type TimelineInput = Omit<TimelineRow, "depth"> & { depth?: number }
type Keyed = TimelineInput & { key: string }

/** A live activity item (SSE `activity`): a tool call or a stretch of thinking. */
export interface ActivityInput {
  id: string
  kind?: string
  tool?: string
  summary?: string
  error?: string
  state?: string
  at?: number
  childSessionID?: string
}

/**
 * Where a row goes: by `pos`, then `live` (0 for history rows; live rows count up in arrival order after the
 * history position they were anchored to).
 */
interface Place {
  pos: number
  live: number
}
const before = (a: Place, b: Place) => a.pos - b.pos || a.live - b.live

interface Subagent {
  id: string
  title?: string
  state?: string
  since?: number
  /** Where it first appeared live (spawned while this view was open); absent when it was already there. */
  place?: Place
  /** Order among subagents without a place (first seen first). */
  seen: number
}

export class Timeline {
  private items = new Map<string, TimelineRow>()
  private subagents = new Map<string, Subagent>()
  private details = new Map<string, unknown>()
  private places = new Map<string, Place>()
  /** Highest and lowest history positions so far (live rows anchor after the highest). */
  private top = 0
  private bottom = 0
  private liveSeq = 0
  private seenSeq = 0
  /** A newest history page was loaded (subagents appearing after it were spawned while the view was open). */
  private loaded = false
  /** A status tree was seen (subagents in the first one already existed). */
  private snapshots = 0
  /** Keys of rows that came from history pages (dropped by forgetHistory). */
  private history = new Set<string>()

  /** History rows; `older`: a page from before the rows already loaded (they go first). */
  load(items: readonly TimelineInput[] | undefined, options: { older?: boolean } = {}): void {
    const list = (items ?? []).filter((item) => item && typeof item.key === "string") as Keyed[]
    // Rows from spokes without positions keep the order of the pages: newer pages after, older pages before.
    const legacy = list.filter((item) => typeof item.pos !== "number" && !this.places.has(item.key))
    legacy.forEach((item, index) => {
      this.places.set(item.key, { pos: options.older ? this.bottom - legacy.length + index : this.top + 1 + index, live: 0 })
    })
    for (const item of list) {
      if (typeof item.pos === "number" && Number.isFinite(item.pos)) this.places.set(item.key, { pos: item.pos, live: 0 })
      const pos = this.places.get(item.key)!.pos
      this.top = Math.max(this.top, pos)
      this.bottom = Math.min(this.bottom, pos)
      this.history.add(item.key)
    }
    for (const item of list) {
      // A stored row replaces the live row built for the same part (a thought keeps its streamed text when the
      // provider stored none: many keep only an encrypted signature).
      const live = this.liveTwin(item)
      if (live) {
        this.items.delete(live.key)
        this.places.delete(live.key)
        if (live.kind === "reasoning") this.put({ ...item, text: item.text || live.text || "" })
        else if (live.kind === "tool") this.put({ ...pick(live, ["summary", "error"]), ...item })
        else this.put(item)
      } else this.put(item)
    }
    if (!options.older) {
      // What is still live happened after this page: it goes after it, in the same order.
      this.loaded = true
      for (const [key, place] of this.places) if (place.live > 0 && place.pos < this.top) this.places.set(key, { ...place, pos: this.top })
      for (const sub of this.subagents.values()) if (sub.place && sub.place.pos < this.top) sub.place = { ...sub.place, pos: this.top }
    }
  }

  /** The live row a stored row replaces: the same thought, text part, tool call or sent message. */
  private liveTwin(item: Keyed): TimelineRow | undefined {
    if (this.history.has(item.key) && this.items.has(item.key)) return undefined
    const messageID = typeof item.messageID === "string" ? item.messageID : undefined
    const candidates: string[] = []
    if (item.kind === "reasoning" && messageID) candidates.push(reasoningKey(messageID))
    if (item.kind === "assistant" && messageID) {
      if (typeof item.ordinal === "number") candidates.push(textKey(messageID, item.ordinal))
      if (item.ordinal === undefined || item.ordinal === 0) candidates.push(textKey(messageID))
    }
    if (item.kind === "tool" && typeof item.callID === "string" && typeof item.sessionID === "string") candidates.push(activityKey(item.sessionID, item.callID))
    for (const key of candidates) {
      const row = key === item.key ? undefined : this.items.get(key)
      if (row && !this.history.has(key)) return row
    }
    if (item.kind === "user" && typeof item.text === "string" && item.text) {
      for (const row of this.items.values()) {
        if (row.kind === "user" && !row.messageID && !this.history.has(row.key) && row.text === item.text) return row
      }
    }
    return undefined
  }

  /**
   * A streamed reasoning delta: appended to the running thought of that message (a history row when the
   * session was opened mid-run), else to the message's live thought.
   */
  appendReasoning({ sessionID, messageID, delta, at = Date.now() }: { sessionID?: string; messageID: string; delta: string; at?: number }): void {
    let target: TimelineRow | undefined
    for (const row of this.items.values()) if (row.kind === "reasoning" && row.messageID === messageID && row.state === "running") target = row
    target ??= this.items.get(reasoningKey(messageID))
    const key = target?.key ?? reasoningKey(messageID)
    this.upsert({
      key,
      kind: "reasoning",
      messageID,
      ...(sessionID ? { sessionID } : {}),
      text: `${target?.text ?? ""}${delta}`,
      state: "running",
      at: target?.at ?? at,
    })
  }

  /** A streamed text delta of a message's text part `ordinal` (hubs before 0.7 send none); it ends the thinking before it. */
  appendText({ sessionID, messageID, ordinal, delta, at = Date.now() }: { sessionID?: string; messageID: string; ordinal?: number; delta: string; at?: number }): void {
    const key = textKey(messageID, ordinal)
    const current = this.items.get(key)
    this.upsert({
      key,
      messageID,
      ...(sessionID ? { sessionID } : {}),
      kind: "assistant",
      text: `${current?.text ?? ""}${delta}`,
      live: true,
      at: current?.at ?? at,
    })
    this.endReasoning(sessionID)
  }

  /** Key of the live text of a message that spoken text joins: its latest streamed text part, else the whole message's. */
  liveTextKey(messageID: string): string {
    let key = textKey(messageID)
    let latest = -1
    for (const row of this.items.values()) {
      if (row.kind !== "assistant" || row.messageID !== messageID || this.history.has(row.key)) continue
      const ordinal = row.key.startsWith(`${messageID}:text:`) ? Number(row.key.slice(messageID.length + 6)) : NaN
      if (Number.isInteger(ordinal) && ordinal > latest) [key, latest] = [row.key, ordinal]
    }
    return key
  }

  /** A live tool activity item of `sessionID` (thinking items show up through streamed reasoning instead). */
  activity(sessionID: string, item: ActivityInput): void {
    if (!item || typeof item.id !== "string" || item.kind === "thinking") return
    const key = activityKey(sessionID, item.id)
    const current = this.items.get(key)
    this.upsert({
      key,
      sessionID,
      kind: "tool",
      callID: item.id,
      ...(item.tool ? { name: item.tool } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.childSessionID ? { childSessionID: item.childSessionID } : {}),
      state: item.state,
      at: current?.at ?? item.at,
    })
  }

  /** Thinking ended (text followed, or the tree went idle): running thoughts of `sessionID` (all when omitted) are done. */
  endReasoning(sessionID: string | undefined, at = Date.now()): void {
    for (const row of this.items.values()) {
      if (row.kind === "reasoning" && row.state === "running" && (sessionID === undefined || row.sessionID === sessionID)) this.upsert({ key: row.key, kind: row.kind, state: "done", completed: at })
    }
  }

  /** A row added or changed here (not from a history page): a new one goes after everything loaded so far. */
  upsert(item: TimelineInput): void {
    if (!item || typeof item.key !== "string") return
    if (!this.places.has(item.key)) this.places.set(item.key, this.livePlace())
    this.put(item as Keyed)
  }

  private livePlace(): Place {
    return { pos: this.top, live: ++this.liveSeq }
  }

  private put(item: Keyed): void {
    this.items.set(item.key, { ...(this.items.get(item.key) ?? {}), ...item } as TimelineRow)
  }

  /** Whether `key` came from a history page. */
  fromHistory(key: string): boolean {
    return this.history.has(key)
  }

  /** Drops every row loaded from history pages (to start over from the newest page); local and live rows stay. */
  forgetHistory(): void {
    for (const key of this.history) {
      this.items.delete(key)
      this.places.delete(key)
    }
    this.history.clear()
  }

  /** The current row of `key`, if any. */
  get(key: string): TimelineRow | undefined {
    return this.items.get(key)
  }

  /** Subagent rows from a status tree: the sessions below `rootID` (the session on screen). */
  status(sessions: ReadonlyArray<Record<string, unknown>> | undefined, rootID: string): void {
    const seen = new Set<string>()
    const below = new Set([rootID])
    for (let grew = true; grew; ) {
      grew = false
      for (const s of sessions ?? []) {
        if (typeof s?.id === "string" && typeof s.parentID === "string" && below.has(s.parentID) && !below.has(s.id)) {
          below.add(s.id)
          grew = true
        }
      }
    }
    // Older hubs send entries without parentID: everything but the root is below it then.
    const flat = (sessions ?? []).every((s) => s?.id === rootID || typeof s?.parentID !== "string")
    // Subagents in the first tree already existed; later ones that work were spawned while this view is open.
    const spawning = this.snapshots > 0 && this.loaded
    if (sessions?.length) this.snapshots++
    for (const session of sessions ?? []) {
      const id = session?.id
      if (!session || typeof id !== "string" || !id || id === rootID) continue
      if (!below.has(id) && !(flat && (sessions ?? [])[0]?.id === rootID)) continue
      seen.add(id)
      const since = typeof session.since === "number" ? session.since : undefined
      const state = session.state === "idle" ? "done" : (session.state as string | undefined)
      const current = this.subagents.get(id) ?? { id, seen: ++this.seenSeq, ...(spawning && state === "working" ? { place: this.livePlace() } : {}) }
      this.subagents.set(id, { ...current, title: typeof session.title === "string" ? session.title : undefined, state, since })
    }
    for (const sub of this.subagents.values()) if (!seen.has(sub.id) && sub.state === "working") sub.state = "done"
  }

  detail(key: string, detail: unknown): void {
    this.details.set(key, detail)
  }

  rows(): TimelineRow[] {
    const root: TimelineRow[] = []
    const children = new Map<string, TimelineRow[]>()
    for (const item of this.items.values()) {
      const row: TimelineRow = { ...item, depth: 0, ...(this.details.has(item.key) ? { detail: this.details.get(item.key) } : {}) }
      if (item.sessionID && this.subagents.has(item.sessionID)) {
        const list = children.get(item.sessionID) ?? []
        list.push({ ...row, depth: 1 })
        children.set(item.sessionID, list)
      } else root.push(row)
    }
    const place = (key: string): Place => this.places.get(key) ?? { pos: this.top, live: Number.MAX_SAFE_INTEGER }
    const byPlace = (a: TimelineRow, b: TimelineRow) => before(place(a.key), place(b.key))
    const group = (sub: Subagent): TimelineRow[] => [
      { key: `sub:${sub.id}`, kind: "subagent", label: sub.title || sub.id, state: sub.state, sessionID: sub.id, depth: 0 },
      ...(children.get(sub.id) ?? []).sort(byPlace),
    ]
    const groups: Array<{ place: Place; rows: TimelineRow[] }> = []
    const placed = new Set<string>()
    for (const row of root.sort(byPlace)) {
      // A subagent stands in place of the (first) tool call that spawned it.
      const sub = typeof row.childSessionID === "string" && !placed.has(row.childSessionID) ? this.subagents.get(row.childSessionID) : undefined
      if (sub) placed.add(sub.id)
      groups.push({ place: place(row.key), rows: sub ? group(sub) : [row] })
    }
    const unplaced = [...this.subagents.values()].filter((sub) => !placed.has(sub.id))
    const top = unplaced.filter((sub) => !sub.place).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.seen - b.seen)
    top.forEach((sub, index) => groups.push({ place: { pos: -Infinity, live: index }, rows: group(sub) }))
    for (const sub of unplaced) if (sub.place) groups.push({ place: sub.place, rows: group(sub) })
    return groups.sort((a, b) => before(a.place, b.place)).flatMap((g) => g.rows)
  }
}

function pick(row: TimelineRow, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]))
}
