// Transcript layout of a session: timeline rows (history + live) become display blocks — user pills, assistant
// markdown, "Thought for Ns", consecutive tools folded into "Used N tools", and subagent rows that link to the
// child session. Rows nested under a subagent (depth 1) stay in the child's own transcript.
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
      case "subagent":
        if (row.sessionID) out.push({ type: "subagent", key: row.key, sessionID: row.sessionID, label: row.label ?? row.sessionID, state: row.state ?? "working" })
        break
    }
  }
  return out
}
