// Transcript layout of a session: timeline rows (history + live) become display blocks — user pills, assistant
// markdown, "Thought for Ns", consecutive tools folded into "Used N tools", and subagent rows that link to the
// child session. Rows nested under a subagent (depth 1) stay in the child's own transcript.
import { messageDeliveryLabel } from "../core/harness-core"
import type { TimelineRow } from "../core/timeline-core"
import { acceptsImage } from "./images"

/** An attachment of a user message: images have a `src` (lazy URL or local preview), other files only a name. */
export interface BlockImage {
  key: string
  name: string
  mime: string
  src?: string
}

export type Block =
  | { type: "user"; key: string; text: string; images?: BlockImage[] }
  | { type: "assistant"; key: string; text: string; live: boolean }
  | { type: "thought"; key: string; text: string; running: boolean; seconds?: number }
  | { type: "tools"; key: string; items: TimelineRow[]; failed: number; running: number }
  | { type: "subagent"; key: string; sessionID: string; label: string; state: string }
  /** A hub message: `label` "from @y" (in) or "to @@r (→ @x)" (out); the identity primer is a compact note. */
  | { type: "message"; key: string; direction: "in" | "out"; kind: string; label: string; text: string; primer: boolean; state?: string; delivery?: string }

/** URL of one image of a user message (GET …/timeline/messages/:message/files/:index). */
export const messageFileURL = (sessionID: string, messageID: string, index: number) =>
  `/api/sessions/${encodeURIComponent(sessionID)}/timeline/messages/${encodeURIComponent(messageID)}/files/${index}`

/** History rows list `files` ({index, mime, name?}); a message just sent carries local `images` previews. */
function attachments(row: TimelineRow): BlockImage[] {
  const out: BlockImage[] = []
  if (Array.isArray(row.images)) {
    row.images.forEach((image: any, i: number) => {
      if (image && typeof image.mime === "string") out.push({ key: `${row.key}:${i}`, name: String(image.name || "image"), mime: image.mime, ...(typeof image.preview === "string" ? { src: image.preview } : {}) })
    })
  } else if (Array.isArray(row.files)) {
    for (const file of row.files as any[]) {
      if (!file || typeof file.mime !== "string" || !Number.isInteger(file.index)) continue
      const linked = acceptsImage(file.mime) && typeof row.sessionID === "string" && typeof row.messageID === "string"
      out.push({
        key: `${row.key}:${file.index}`,
        name: typeof file.name === "string" && file.name ? file.name : file.mime.startsWith("image/") ? "image" : "file",
        mime: file.mime,
        ...(linked ? { src: messageFileURL(row.sessionID!, row.messageID!, file.index) } : {}),
      })
    }
  }
  return out
}

export function transcriptBlocks(rows: readonly TimelineRow[]): Block[] {
  const out: Block[] = []
  for (const row of rows) {
    if ((row.depth ?? 0) > 0) continue
    switch (row.kind) {
      case "user":
      {
        const images = attachments(row)
        if (row.text || images.length) out.push({ type: "user", key: row.key, text: row.text ?? "", ...(images.length ? { images } : {}) })
        break
      }
      case "assistant":
        if (row.text) out.push({ type: "assistant", key: row.key, text: row.text, live: row.live === true })
        break
      case "reasoning": {
        const running = row.state === "running"
        const seconds = !running && typeof row.at === "number" && typeof row.completed === "number" ? Math.max(0, Math.round((row.completed - row.at) / 1000)) : undefined
        out.push({ type: "thought", key: row.key, text: row.text ?? "", running, ...(seconds === undefined ? {} : { seconds }) })
        break
      }
      case "tool": {
        const last = out[out.length - 1]
        const group = last?.type === "tools" ? last : undefined
        const target = group ?? { type: "tools" as const, key: `tools:${row.key}`, items: [], failed: 0, running: 0 }
        target.items.push(row)
        if (row.state === "failed") target.failed++
        if (row.state === "running") target.running++
        if (!group) out.push(target)
        break
      }
      case "message":
        out.push(messageBlock(row))
        break
      case "subagent":
        if (row.sessionID) out.push({ type: "subagent", key: row.key, sessionID: row.sessionID, label: row.label ?? row.sessionID, state: row.state ?? "working" })
        break
    }
  }
  return out
}

function messageBlock(row: TimelineRow): Extract<Block, { type: "message" }> {
  const meta = row.message && typeof row.message === "object" ? (row.message as Record<string, unknown>) : {}
  const kind = typeof meta.kind === "string" ? meta.kind : "msg"
  const direction = row.direction === "out" ? "out" : "in"
  const to = String(meta.to ?? "")
  const recipient = typeof row.recipient === "string" ? row.recipient : undefined
  /** Not (yet) delivered into a turn: queued, held or pending (honest about hooks and screen spokes). */
  const delivery = messageDeliveryLabel(row.delivery)
  const label =
    kind === "primer" ? "Hub identity note" : direction === "out" ? `to ${to}${recipient && recipient !== to ? ` (→ ${recipient})` : ""}` : `from ${String(meta.from ?? "?")}`
  return { type: "message", key: row.key, direction, kind, label, text: row.text ?? "", primer: kind === "primer", ...(typeof row.state === "string" ? { state: row.state } : {}), ...(delivery ? { delivery } : {}) }
}

/** Shown when a thought has no readable text: the provider kept only an encrypted signature. */
export const HIDDEN_REASONING = "The model didn't share its reasoning text (only an encrypted summary)."

/** The "Thought for Ns" row: its label and what it shows when expanded (always expandable). */
export function thoughtView(block: Extract<Block, { type: "thought" }>): { label: string; body: string; muted: boolean } {
  const label = block.running ? "Thinking…" : block.seconds !== undefined ? `Thought for ${block.seconds}s` : "Thought"
  if (block.text) return { label, body: block.text, muted: false }
  return { label, body: block.running ? "Waiting for the model's reasoning…" : HIDDEN_REASONING, muted: true }
}
