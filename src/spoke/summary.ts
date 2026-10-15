// Right-rail summary of a session, computed on the spoke from OpenCode data: context usage (latest
// assistant tokens against the model's context limit), MCP server status and working-tree changes.
// Pure: the spoke passes in what it read from OpenCode.
import type { ChangedFile, ContextUsage, FilePatch, McpStatus, SessionChanges } from "../protocol"

/**
 * Longest patch sent for one file, measured as JSON-encoded characters (quotes, backslashes and control
 * characters count at their escaped size), so the reply always fits in one protocol frame. The rest is cut
 * and marked truncated.
 */
export const MAX_PATCH_CHARS = 400 * 1024
const MAX_ERROR_CHARS = 200
const MCP_STATUSES = new Set(["connected", "pending", "disabled", "failed", "needs_auth"])
const FILE_STATUSES = new Set(["added", "deleted", "modified"])

const record = (v: unknown): Record<string, any> => (typeof v === "object" && v !== null ? (v as Record<string, any>) : {})
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

export function contextUsage(messages: ReadonlyArray<unknown>, models: ReadonlyArray<unknown>): ContextUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = record(messages[i])
    if (message.type !== "assistant" || !message.tokens) continue
    const t = record(message.tokens)
    const used = count(t.input) + count(t.output) + count(t.reasoning) + count(record(t.cache).read) + count(record(t.cache).write)
    const ref = record(message.model)
    const info = record(models.find((m) => record(m).providerID === ref.providerID && record(m).modelID === ref.id))
    const limit = count(record(info.limit).context)
    return {
      used,
      ...(limit ? { limit, percent: Math.min(100, Math.max(0, Math.round((used / limit) * 100))) } : {}),
      ...(typeof info.name === "string" ? { model: info.name } : {}),
    }
  }
  return undefined
}

export function mcpServers(raw: ReadonlyArray<unknown>): McpStatus[] {
  return raw.flatMap((value) => {
    const server = record(value)
    if (typeof server.name !== "string" || !server.name) return []
    const status = record(server.status)
    const name = MCP_STATUSES.has(status.status) ? (status.status as McpStatus["status"]) : "unknown"
    const error = typeof status.error === "string" && status.error ? status.error.slice(0, MAX_ERROR_CHARS) : undefined
    return [{ name: server.name, status: name, ...(error ? { error } : {}) }]
  })
}

function changedFile(value: unknown): (ChangedFile & { patch: string }) | undefined {
  const d = record(value)
  if (typeof d.file !== "string" || !d.file) return undefined
  return {
    file: d.file,
    status: FILE_STATUSES.has(d.status) ? d.status : "modified",
    additions: count(d.additions),
    deletions: count(d.deletions),
    patch: typeof d.patch === "string" ? d.patch : "",
  }
}

export function changeStats(raw: ReadonlyArray<unknown>): SessionChanges {
  const files = raw.flatMap((value) => {
    const file = changedFile(value)
    if (!file) return []
    const { patch: _patch, ...stats } = file
    return [stats]
  })
  return { files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) }
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c])

/** The longest prefix of `text` whose JSON encoding (with quotes) fits in `max` characters, never splitting a surrogate pair. */
export function clipEncoded(text: string, max: number): { text: string; truncated: boolean } {
  let size = 2
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // A well-formed surrogate pair is written as-is (two units); lone surrogates and other control characters as \uXXXX.
    const pair = isHigh(c) && isLow(text.charCodeAt(i + 1))
    const width = pair ? 2 : SHORT_ESCAPES.has(c) ? 2 : c < 0x20 || isHigh(c) || isLow(c) ? 6 : 1
    if ((size += width) > max) return { text: text.slice(0, i), truncated: true }
    if (pair) i++
  }
  return { text, truncated: false }
}

export function filePatch(raw: ReadonlyArray<unknown>, file: string): FilePatch | undefined {
  for (const value of raw) {
    const found = changedFile(value)
    if (found?.file !== file) continue
    const { text, truncated } = clipEncoded(found.patch, MAX_PATCH_CHARS)
    return { ...found, patch: text, truncated }
  }
  return undefined
}
