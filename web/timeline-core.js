const fold = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
const modelKey = (model) => `${model.providerID}/${model.modelID}`

export class ModelCatalog {
  constructor(models = []) {
    this.models = Array.isArray(models) ? models.filter((model) => model && typeof model.providerID === "string" && typeof model.modelID === "string") : []
  }

  groups(search = "") {
    const query = fold(search.trim())
    const byProvider = new Map()
    for (const model of this.models) {
      if (model.enabled === false) continue
      if (query && !fold([model.name, model.modelID, model.providerID].join(" ")).includes(query)) continue
      const items = byProvider.get(model.providerID) ?? []
      items.push({ ...model, variants: [...(model.variants ?? [])] })
      byProvider.set(model.providerID, items)
    }
    return [...byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([providerID, items]) => ({ providerID, items: items.sort((a, b) => (a.name || a.modelID).localeCompare(b.name || b.modelID)) }))
  }

  selection(value) {
    if (!value) return undefined
    const found = this.models.find((model) => model.providerID === value.providerID && model.modelID === value.modelID)
    if (found) return { ...found, variants: [...(found.variants ?? [])], stale: found.enabled === false }
    return { ...value, name: modelKey(value), variants: value.variant ? [value.variant] : [], stale: true }
  }
}

export class Timeline {
  constructor() {
    this.items = new Map()
    this.subagents = new Map()
    this.details = new Map()
  }

  load(items) {
    for (const item of items ?? []) this.upsert(item)
  }

  upsert(item) {
    if (!item || typeof item.key !== "string") return
    this.items.set(item.key, { ...(this.items.get(item.key) ?? {}), ...item })
  }

  status(sessions, rootID) {
    const seen = new Set()
    for (const session of sessions ?? []) {
      if (!session || session.id === rootID || !session.id) continue
      seen.add(session.id)
      const current = this.subagents.get(session.id) ?? { id: session.id, at: session.since ?? Date.now() }
      this.subagents.set(session.id, { ...current, title: session.title, state: session.state === "idle" ? "done" : session.state, since: session.since })
    }
    for (const sub of this.subagents.values()) if (!seen.has(sub.id) && sub.state === "working") sub.state = "done"
  }

  detail(key, detail) {
    this.details.set(key, detail)
  }

  rows() {
    const root = []
    const children = new Map()
    for (const item of this.items.values()) {
      const row = { ...item, depth: 0, ...(this.details.has(item.key) ? { detail: this.details.get(item.key) } : {}) }
      if (item.sessionID && this.subagents.has(item.sessionID)) {
        const list = children.get(item.sessionID) ?? []
        list.push({ ...row, depth: 1 })
        children.set(item.sessionID, list)
      } else root.push(row)
    }
    const groups = root.map((row) => ({ at: row.at ?? 0, rows: [row] }))
    for (const sub of this.subagents.values()) {
      groups.push({ at: sub.at ?? 0, rows: [
        { key: `sub:${sub.id}`, kind: "subagent", label: sub.title || sub.id, state: sub.state, sessionID: sub.id, depth: 0 },
        ...(children.get(sub.id) ?? []).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
      ] })
    }
    return groups.sort((a, b) => a.at - b.at).flatMap((group) => group.rows)
  }
}
