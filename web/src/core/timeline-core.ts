// Pure session-timeline state (no DOM): timeline items keyed by `key` (history pages and live updates
// merge in place), subagent rows from status trees with their own items nested under them, lazily loaded
// tool details, and the model catalog for the Voice/Worker model menus.

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
  [key: string]: unknown
}

/** Key of the thought built from live deltas of a message (before its stored row is known). */
const reasoningKey = (messageID: string) => `${messageID}:reasoning`

export type TimelineInput = Omit<TimelineRow, "depth"> & { depth?: number }

interface Subagent {
  id: string
  at: number
  title?: string
  state?: string
  since?: number
}

export class Timeline {
  private items = new Map<string, TimelineRow>()
  private subagents = new Map<string, Subagent>()
  private details = new Map<string, unknown>()
  /** Display order among rows of the same time: new rows count up, rows of older pages count down. */
  private order = new Map<string, number>()
  private newest = 0
  private oldest = 0
  /** Keys of rows that came from history pages (dropped by forgetHistory). */
  private history = new Set<string>()

  /** History rows; `older`: a page from before the rows already loaded (they go first). */
  load(items: readonly TimelineInput[] | undefined, options: { older?: boolean } = {}): void {
    const list = (items ?? []).filter((item) => item && typeof item.key === "string") as Array<TimelineInput & { key: string }>
    if (options.older) {
      const fresh = list.filter((item) => !this.order.has(item.key))
      fresh.forEach((item, index) => this.order.set(item.key, this.oldest - fresh.length + index))
      this.oldest -= fresh.length
    }
    for (const item of list) this.history.add(item.key)
    for (const item of list) {
      // A stored thought replaces the row its live deltas built; the streamed text stays when the provider
      // stored none (many keep only an encrypted signature).
      const liveKey = item?.kind === "reasoning" && typeof item.messageID === "string" ? reasoningKey(item.messageID) : undefined
      const live = liveKey !== undefined && liveKey !== item.key ? this.items.get(liveKey) : undefined
      if (live) {
        this.items.delete(liveKey!)
        this.upsert({ ...item, text: item.text || live.text || "" })
      } else this.upsert(item)
    }
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

  /** Thinking ended (text followed, or the tree went idle): running thoughts of `sessionID` (all when omitted) are done. */
  endReasoning(sessionID: string | undefined, at = Date.now()): void {
    for (const row of this.items.values()) {
      if (row.kind === "reasoning" && row.state === "running" && (sessionID === undefined || row.sessionID === sessionID)) this.upsert({ key: row.key, kind: row.kind, state: "done", completed: at })
    }
  }

  upsert(item: TimelineInput): void {
    if (!item || typeof item.key !== "string") return
    if (!this.order.has(item.key)) this.order.set(item.key, ++this.newest)
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
      this.order.delete(key)
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
    for (const session of sessions ?? []) {
      const id = session?.id
      if (!session || typeof id !== "string" || !id || id === rootID) continue
      if (!below.has(id) && !(flat && (sessions ?? [])[0]?.id === rootID)) continue
      seen.add(id)
      const since = typeof session.since === "number" ? session.since : undefined
      const current = this.subagents.get(id) ?? { id, at: since ?? Date.now() }
      this.subagents.set(id, {
        ...current,
        title: typeof session.title === "string" ? session.title : undefined,
        state: session.state === "idle" ? "done" : (session.state as string | undefined),
        since,
      })
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
    const seq = (key: string) => this.order.get(key) ?? 0
    const groups = root.map((row) => ({ at: row.at ?? 0, seq: seq(row.key), rows: [row] }))
    for (const sub of this.subagents.values()) {
      groups.push({
        at: sub.at ?? 0,
        seq: Number.MAX_SAFE_INTEGER,
        rows: [
          { key: `sub:${sub.id}`, kind: "subagent", label: sub.title || sub.id, state: sub.state, sessionID: sub.id, depth: 0 },
          ...(children.get(sub.id) ?? []).sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || seq(a.key) - seq(b.key)),
        ],
      })
    }
    return groups.sort((a, b) => a.at - b.at || a.seq - b.seq).flatMap((group) => group.rows)
  }
}
