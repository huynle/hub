export interface ModelSelection { providerID: string; modelID: string; variant?: string }
export interface ModelItem extends ModelSelection { name?: string; enabled?: boolean; variants?: string[]; stale?: boolean }
export class ModelCatalog {
  constructor(models?: ModelItem[])
  groups(search?: string): Array<{ providerID: string; items: ModelItem[] }>
  selection(value?: ModelSelection): ModelItem | undefined
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
export class Timeline {
  load(items: Array<Omit<TimelineRow, "depth"> & { depth?: number }>): void
  upsert(item: Omit<TimelineRow, "depth"> & { depth?: number }): void
  status(sessions: Array<Record<string, unknown>>, rootID: string): void
  detail(key: string, detail: unknown): void
  rows(): TimelineRow[]
}
