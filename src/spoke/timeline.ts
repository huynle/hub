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
      if (text) out.push({ key: `${message.id}:text`, messageID: message.id, sessionID, kind: "user", text, ...(at === undefined ? {} : { at }) })
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
