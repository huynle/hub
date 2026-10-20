import { PROMPT_IMAGE_MIMES, type PromptImage } from "../protocol"

/** An attachment of a user message: its position in the message's files (for timelineFile), type and name. */
export interface TimelineFile {
  readonly index: number
  readonly mime: string
  readonly name?: string
}

export interface TimelineItem {
  readonly key: string
  readonly messageID: string
  readonly partID?: string
  readonly sessionID: string
  readonly kind: "user" | "assistant" | "reasoning" | "tool"
  readonly text?: string
  readonly name?: string
  readonly state?: "running" | "done" | "failed"
  readonly at?: number
  readonly completed?: number
  readonly files?: readonly TimelineFile[]
}

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}

/** Projects OpenCode messages into stable, ordered, payload-light phone timeline rows. */
export function timelineItems(sessionID: string, messages: readonly unknown[]): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const raw of messages) {
    const message = record(raw)
    if (typeof message.id !== "string") continue
    const at = typeof message.time?.created === "number" ? message.time.created : undefined
    if (message.type === "user") {
      const text = typeof message.text === "string" ? message.text : Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("") : ""
      const files = userFiles(message.files)
      if (text || files.length) out.push({ key: `${message.id}:text`, messageID: message.id, sessionID, kind: "user", text, ...(at === undefined ? {} : { at }), ...(files.length ? { files } : {}) })
      continue
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    message.content.forEach((part: any, index: number) => {
      if (!part || typeof part !== "object") return
      const partID = String(index)
      const base = { key: `${message.id}:${partID}`, messageID: message.id, partID, sessionID, ...(at === undefined ? {} : { at }) }
      if (part.type === "text" && typeof part.text === "string" && part.text) out.push({ ...base, kind: "assistant", text: part.text })
      if (part.type === "reasoning") out.push({ ...base, kind: "reasoning", text: String(part.text ?? ""), state: part.time?.completed === undefined ? "running" : "done", ...(typeof part.time?.created === "number" ? { at: part.time.created } : {}), ...(typeof part.time?.completed === "number" ? { completed: part.time.completed } : {}) })
      if (part.type === "tool") {
        const status = part.state?.status
        out.push({ ...base, kind: "tool", name: String(part.name ?? "tool"), state: status === "error" ? "failed" : status === "completed" ? "done" : "running", ...(typeof part.time?.created === "number" ? { at: part.time.created } : {}), ...(typeof part.time?.completed === "number" ? { completed: part.time.completed } : {}) })
      }
    })
  }
  return out
}

/** A newest-first timeline page: rows in chronological order, and the cursor of the rows before them. */
export interface NewestPage {
  readonly items: TimelineItem[]
  /** Pass as `before` for the next older page; absent at the beginning of the conversation. */
  readonly older?: string
}

/**
 * The `limit` rows just before the row keyed `before` (the newest rows without it). The cursor is the key of
 * the oldest row returned, so it stays valid while new messages arrive (an offset would shift). A page starts
 * at a message boundary when the message fits in twice the limit; larger messages are split.
 */
export function newestPage(items: readonly TimelineItem[], limit: number, before?: string): NewestPage {
  const end = before === undefined ? items.length : items.findIndex((item) => item.key === before)
  if (end < 0) throw new Error("Invalid timeline cursor")
  let start = Math.max(0, end - limit)
  const cap = Math.max(0, end - limit * 2)
  while (start > cap && items[start - 1]!.messageID === items[start]!.messageID) start--
  const page = items.slice(start, end)
  return { items: page, ...(start > 0 && page.length ? { older: page[0]!.key } : {}) }
}

/**
 * Short-lived per-session timeline rows, so paging through a history reads OpenCode's whole history once rather
 * than once per page. Entries expire after `ttlMs` and are dropped when the session changes (invalidate).
 */
export class TimelineCache {
  private readonly entries = new Map<string, { items: TimelineItem[]; at: number }>()
  /** Bumped on invalidation: a load started before it is not stored. */
  private readonly generations = new Map<string, number>()
  private readonly ttlMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.max = options.max ?? 20
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  /** The cached rows of `sessionID`, else (or with `fresh`) loaded and cached. */
  async get(sessionID: string, load: () => Promise<TimelineItem[]>, fresh = false): Promise<TimelineItem[]> {
    const cached = this.entries.get(sessionID)
    if (!fresh && cached && this.now() - cached.at < this.ttlMs) {
      this.entries.delete(sessionID)
      this.entries.set(sessionID, cached)
      return cached.items
    }
    const generation = this.generations.get(sessionID) ?? 0
    const items = await load()
    if ((this.generations.get(sessionID) ?? 0) !== generation) return items
    this.entries.delete(sessionID)
    this.entries.set(sessionID, { items, at: this.now() })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
    return items
  }

  invalidate(sessionID: string): void {
    this.entries.delete(sessionID)
    if (this.generations.size > 1000) this.generations.clear()
    this.generations.set(sessionID, (this.generations.get(sessionID) ?? 0) + 1)
  }
}

/** Attachment metadata (never the bytes) of a user message's files. */
function userFiles(raw: unknown): TimelineFile[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((file, index) => {
    const f = record(file)
    if (typeof f.mime !== "string") return []
    return [{ index, mime: f.mime, ...(typeof f.name === "string" && f.name ? { name: f.name.slice(0, 200) } : {}) }]
  })
}

/** Largest attachment served (base64 characters), so the answer fits in one frame. */
export const TIMELINE_FILE_MAX_BASE64 = 900_000

/**
 * The image at `index` of a user message: only the prompt image types are served (never SVG or other
 * files); nothing when there is no such image; `tooLarge` when its bytes would not fit in a frame.
 */
export function timelineFile(messages: readonly unknown[], messageID: string, index: number): { file?: PromptImage; tooLarge?: boolean } {
  const message = messages.map(record).find((item) => item.id === messageID && item.type === "user")
  const file = Array.isArray(message?.files) ? record(message.files[index]) : {}
  if (typeof file.mime !== "string" || !PROMPT_IMAGE_MIMES.includes(file.mime) || typeof file.data !== "string" || !file.data) return {}
  if (file.data.length > TIMELINE_FILE_MAX_BASE64) return { tooLarge: true }
  return { file: { mime: file.mime, data: file.data, ...(typeof file.name === "string" && file.name ? { name: file.name.slice(0, 200) } : {}) } }
}

export function timelinePart(messages: readonly unknown[], messageID: string, partID: string): unknown {
  const message = messages.map(record).find((item) => item.id === messageID)
  const index = Number(partID)
  const part = Number.isInteger(index) && Array.isArray(message?.content) ? message.content[index] : undefined
  if (!part || part.type !== "tool") throw new Error("Timeline part not found")
  return { name: part.name, state: structuredClone(part.state), time: structuredClone(part.time) }
}

const DETAIL_MAX_BYTES = 750_000
export function boundedTimelinePart(messages: readonly unknown[], messageID: string, partID: string): unknown {
  const detail = timelinePart(messages, messageID, partID)
  if (JSON.stringify(detail).length > DETAIL_MAX_BYTES) throw new Error("Timeline part is too large to display")
  return detail
}
