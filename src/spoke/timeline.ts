import { DELIVER_ID_MAX, MESSAGE_KINDS, PROMPT_IMAGE_MIMES, type MessageKind, type PromptImage, type TimelineMessageItem } from "../protocol"
import { PROMPT_SOURCE } from "./conversation"

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
  /** "message": a hub message delivered to the session (TimelineMessageItem). */
  /** "error": the turn failed; "retry": the provider call is being retried (until the message completes or fails). */
  readonly kind: "user" | "assistant" | "reasoning" | "tool" | "message" | "error" | "retry"
  readonly text?: string
  readonly name?: string
  readonly state?: "running" | "done" | "failed"
  readonly at?: number
  readonly completed?: number
  readonly files?: readonly TimelineFile[]
  /**
   * Ordering position: rows sort by it (never by `at`, whose clocks differ between parts). It follows the order
   * of the session's messages and of the parts within a message, and depends only on the message's own creation
   * time and its predecessors' (so it stays the same while history pages or the context window move).
   */
  readonly pos?: number
  /** Tool rows: the tool call ID (live activity items use it as their ID). */
  readonly callID?: string
  /** Subagent (subagent/task) tool rows: the child session it runs in. */
  readonly childSessionID?: string
  /** Subagent tool rows: the task's short description. */
  readonly title?: string
  /** Assistant text rows: which text part of the message this is (0, 1, …), as in live text deltas. */
  readonly ordinal?: number
  /** Message rows: always "in" here (the hub adds the session's sent messages). */
  readonly direction?: TimelineMessageItem["direction"]
  /** Message rows: who sent it, how it was addressed, what it answers. */
  readonly message?: TimelineMessageItem["message"]
  /** Error and retry rows: the error's type (bounded) and HTTP status (100–599). */
  readonly errorType?: string
  readonly errorStatus?: number
  /** Retry rows: the attempt number and when the next attempt starts (epoch ms). */
  readonly attempt?: number
  readonly next?: number
}

/** Parts of one message a position leaves room for (later parts share the last slot). */
const POS_PARTS = 1000
const SUBAGENT_TOOLS = new Set(["subagent", "task"])
const TITLE_MAX = 160
const ERROR_TEXT_MAX = 1000
const ERROR_TYPE_MAX = 64

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}

/** Projects OpenCode messages into stable, ordered, payload-light phone timeline rows. */
export function timelineItems(sessionID: string, messages: readonly unknown[]): TimelineItem[] {
  const out: TimelineItem[] = []
  let previous = -Infinity
  for (const raw of messages) {
    const message = record(raw)
    if (typeof message.id !== "string") continue
    const at = millis(message.time?.created)
    // Messages keep the session's order even when one was created earlier than the one before it (a queued prompt).
    const start = Math.max(at === undefined ? -Infinity : at * POS_PARTS, previous + POS_PARTS)
    const first = (previous = Number.isFinite(start) ? start : 0)
    const pos = (index: number) => first + Math.min(index, POS_PARTS - 1)
    if (message.type === "user") {
      const text = typeof message.text === "string" ? message.text : Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("") : ""
      const files = userFiles(message.files)
      if (text || files.length) out.push({ key: `${message.id}:text`, messageID: message.id, sessionID, kind: "user", text, ...(at === undefined ? {} : { at }), ...(files.length ? { files } : {}), pos: pos(0) })
      continue
    }
    if (message.type === "synthetic") {
      const row = hubMessageRow(sessionID, message, at, pos(0))
      if (row) out.push(row)
      continue
    }
    if (message.type !== "assistant") continue
    const status = statusRow(sessionID, message, at, pos(Array.isArray(message.content) ? message.content.length : 0))
    if (!Array.isArray(message.content)) {
      if (status) out.push(status)
      continue
    }
    let texts = 0
    message.content.forEach((part: any, index: number) => {
      if (!part || typeof part !== "object") return
      const partID = String(index)
      const base = { key: `${message.id}:${partID}`, messageID: message.id, partID, sessionID, ...(at === undefined ? {} : { at }), pos: pos(index) }
      if (part.type === "text" && typeof part.text === "string") {
        const ordinal = texts++
        if (part.text) out.push({ ...base, kind: "assistant", text: part.text, ordinal })
      }
      if (part.type === "reasoning") out.push({ ...base, kind: "reasoning", text: String(part.text ?? ""), state: part.time?.completed === undefined ? "running" : "done", ...(typeof part.time?.created === "number" ? { at: part.time.created } : {}), ...(typeof part.time?.completed === "number" ? { completed: part.time.completed } : {}) })
      if (part.type === "tool") {
        const status = part.state?.status
        const name = String(part.name ?? "tool")
        const spawn = SUBAGENT_TOOLS.has(name) ? subagentOf(part.state) : {}
        out.push({
          ...base,
          kind: "tool",
          name,
          state: status === "error" ? "failed" : status === "completed" ? "done" : "running",
          ...(typeof part.id === "string" && part.id ? { callID: part.id } : {}),
          ...spawn,
          ...(typeof part.time?.created === "number" ? { at: part.time.created } : {}),
          ...(typeof part.time?.completed === "number" ? { completed: part.time.completed } : {}),
        })
      }
    })
    if (status) out.push(status)
  }
  return out
}

/** Epoch milliseconds of an OpenCode timestamp: a number (ms) or an ISO date string. */
function millis(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** The bounded type and HTTP status of an OpenCode error, and its trimmed message (else `fallback`). */
function errorFields(raw: unknown, fallback: string): { text: string; errorType?: string; errorStatus?: number } {
  const error = record(raw)
  const message = typeof error.message === "string" ? error.message.trim().slice(0, ERROR_TEXT_MAX) : ""
  const type = typeof error.type === "string" ? error.type.trim().slice(0, ERROR_TYPE_MAX) : ""
  const status = error.status
  return {
    text: message || fallback,
    ...(type ? { errorType: type } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { errorStatus: status } : {}),
  }
}

/**
 * The status row of an assistant message, after its parts: "error" when the turn failed, "retry" while the
 * provider call is being retried (no error yet and not completed), else none.
 */
function statusRow(sessionID: string, message: Record<string, any>, at: number | undefined, pos: number): TimelineItem | undefined {
  const base = { messageID: message.id as string, sessionID, ...(at === undefined ? {} : { at }), pos }
  if (message.error != null) return { key: `${message.id}:error`, kind: "error", ...errorFields(message.error, "failed"), ...base }
  if (message.retry == null || message.time?.completed != null) return undefined
  const retry = record(message.retry)
  const next = millis(retry.at)
  return {
    key: `${message.id}:retry`,
    kind: "retry",
    ...errorFields(retry.error, "retrying"),
    ...(Number.isInteger(retry.attempt) && retry.attempt >= 0 ? { attempt: retry.attempt } : {}),
    ...(next === undefined ? {} : { next }),
    ...base,
  }
}

/** A message the hub delivered (synthetic, with deliverMetadata): a "message" row; other synthetic messages: none. */
function hubMessageRow(sessionID: string, message: Record<string, any>, at: number | undefined, pos: number): TimelineMessageItem | undefined {
  const meta = record(message.metadata)
  const id = meta.messageID
  if (meta.source !== PROMPT_SOURCE || !isID(id) || !MESSAGE_KINDS.includes(meta.kind) || !isID(meta.from) || !isID(meta.to)) return undefined
  const text = typeof message.text === "string" ? message.text : ""
  return {
    key: `${message.id}:message`,
    messageID: id,
    sessionID,
    kind: "message",
    text: meta.kind === "primer" ? text : messageBody(text, id),
    ...(at === undefined ? {} : { at }),
    pos,
    direction: "in",
    message: { kind: meta.kind as MessageKind, from: meta.from, to: meta.to, ...(isID(meta.replyTo) ? { replyTo: meta.replyTo } : {}) },
  }
}

const isID = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= DELIVER_ID_MAX

/** A line of the envelope body escaped by renderEnvelope (a leading backslash before a header-like line). */
const ESCAPED = /^(\s*)\\(\\*(?:\[hub\]|-{3,}|↩))/i

/**
 * The body of a hub envelope (packages/sdk/src/envelope.ts renderEnvelope): the lines between its boundaries,
 * unescaped. Text without boundaries (a reminder) shows its first line without the "[hub]" tag.
 */
function messageBody(text: string, id: string): string {
  const lines = text.split("\n")
  const boundary = `----- ${id} -----`
  const start = lines.indexOf(boundary)
  const end = lines.lastIndexOf(boundary)
  if (start < 0 || end <= start) return lines[0]!.replace(/^\[hub\]\s*/i, "")
  return lines
    .slice(start + 1, end)
    .map((line) => line.replace(ESCAPED, "$1$2"))
    .join("\n")
}

const CHILD_SESSION = /sessionID:?\s*"?(ses_[A-Za-z0-9]+)/

/** The child session (from the tool's metadata, else its output) and description of a subagent tool call. */
function subagentOf(rawState: unknown): { childSessionID?: string; title?: string } {
  const state = record(rawState)
  const description = typeof state.input?.description === "string" ? state.input.description.trim().split("\n")[0]!.slice(0, TITLE_MAX) : ""
  let child = typeof state.metadata?.sessionID === "string" && state.metadata.sessionID.startsWith("ses_") ? (state.metadata.sessionID as string) : undefined
  if (!child) {
    const outputs = [state.output, state.error, ...(Array.isArray(state.content) ? state.content.map((c: any) => c?.text) : [])]
    for (const text of outputs) {
      const match = typeof text === "string" ? CHILD_SESSION.exec(text) : null
      if (match) {
        child = match[1]
        break
      }
    }
  }
  return { ...(child ? { childSessionID: child } : {}), ...(description ? { title: description } : {}) }
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
