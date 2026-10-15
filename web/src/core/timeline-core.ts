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
    for (const model of this.models) {
      if (model.enabled === false) continue
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

  load(items: readonly TimelineInput[] | undefined): void {
    for (const item of items ?? []) this.upsert(item)
  }

  upsert(item: TimelineInput): void {
    if (!item || typeof item.key !== "string") return
    this.items.set(item.key, { ...(this.items.get(item.key) ?? {}), ...item } as TimelineRow)
  }

  /** The current row of `key`, if any. */
  get(key: string): TimelineRow | undefined {
    return this.items.get(key)
  }

  status(sessions: ReadonlyArray<Record<string, unknown>> | undefined, rootID: string): void {
    const seen = new Set<string>()
    for (const session of sessions ?? []) {
      const id = session?.id
      if (!session || typeof id !== "string" || !id || id === rootID) continue
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
    const groups = root.map((row) => ({ at: row.at ?? 0, rows: [row] }))
    for (const sub of this.subagents.values()) {
      groups.push({
        at: sub.at ?? 0,
        rows: [
          { key: `sub:${sub.id}`, kind: "subagent", label: sub.title || sub.id, state: sub.state, sessionID: sub.id, depth: 0 },
          ...(children.get(sub.id) ?? []).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        ],
      })
    }
    return groups.sort((a, b) => a.at - b.at).flatMap((group) => group.rows)
  }
}
