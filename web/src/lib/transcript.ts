// Transcript layout of a session: timeline rows (history + live) become display blocks — user pills, assistant
// markdown, "Thought for Ns", consecutive tools folded into "Used N tools", and subagent rows that link to the
// child session. Rows nested under a subagent (depth 1) stay in the child's own transcript.
import type { TimelineRow } from "../core/timeline-core"

export type Block =
  | { type: "user"; key: string; text: string }
  | { type: "assistant"; key: string; text: string; live: boolean }
  | { type: "thought"; key: string; text: string; running: boolean; seconds?: number }
  | { type: "tools"; key: string; items: TimelineRow[]; failed: number; running: number }
  | { type: "subagent"; key: string; sessionID: string; label: string; state: string }

export function transcriptBlocks(rows: readonly TimelineRow[]): Block[] {
  const out: Block[] = []
  for (const row of rows) {
    if ((row.depth ?? 0) > 0) continue
    switch (row.kind) {
      case "user":
        if (row.text) out.push({ type: "user", key: row.key, text: row.text })
        break
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
