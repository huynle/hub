// Claude Code tools in the hub's vocabulary (decision fx04e42c point 4). A permission request names the hub action
// (Bash → shell, Edit/Write/MultiEdit/NotebookEdit → edit, Read → read, mcp__<server>__<tool> → <server>_<tool>,
// any other tool its lower-case name), what it applies to (the command, the file path, the URL: short resources,
// never the whole tool input) and the rules an "always" reply would save (Claude's permission_suggestions).
import { HARNESS_ACTION_MAX, HARNESS_RESOURCE_MAX, HARNESS_RESOURCES_MAX, HARNESS_SUMMARY_MAX, summarizeToolInput } from "../../protocol/src/index.ts"

export interface PermissionRequestInfo {
  readonly action: string
  readonly resources: string[]
  /** Rules an "always" reply saves, as Claude Code writes them (`Bash(npm test:*)`). */
  readonly save?: string[]
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const MCP = /^mcp__(.+?)__(.+)$/

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)

/** The hub action for a Claude Code tool name. */
export function permissionAction(tool: string): string {
  if (tool === "Bash") return "shell"
  if (EDIT_TOOLS.has(tool)) return "edit"
  if (tool === "Read") return "read"
  const mcp = MCP.exec(tool)
  const name = mcp ? `${mcp[1]}_${mcp[2]}` : tool.toLowerCase()
  const clean = name.replace(/[^A-Za-z0-9_.-]/g, "_")
  return clean ? cut(clean, HARNESS_ACTION_MAX) : "unknown"
}

/** What a tool call applies to: its command, file, path, URL or pattern (one short text), else nothing. */
function resourceOf(tool: string, input: unknown): string | undefined {
  const r = record(input)
  const value = tool === "Bash" ? str(r.command) : (str(r.file_path) ?? str(r.notebook_path) ?? str(r.path) ?? str(r.url) ?? str(r.pattern))
  return value === undefined ? undefined : cut(value, HARNESS_RESOURCE_MAX)
}

/** permission_suggestions' addRules entries as rule texts (`Tool(content)`, or `Tool` alone). */
function savedRules(suggestions: unknown): string[] {
  const out: string[] = []
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    const suggestion = record(s)
    if (suggestion.type !== "addRules" || (suggestion.behavior !== undefined && suggestion.behavior !== "allow")) continue
    for (const rule of Array.isArray(suggestion.rules) ? suggestion.rules : []) {
      const { toolName, ruleContent } = record(rule)
      if (typeof toolName !== "string" || !toolName) continue
      const text = typeof ruleContent === "string" && ruleContent ? `${toolName}(${ruleContent})` : toolName
      if (!out.includes(text) && out.length < HARNESS_RESOURCES_MAX) out.push(cut(text, HARNESS_RESOURCE_MAX))
    }
  }
  return out
}

/** A PermissionRequest hook input as the hub's permission.asked fields. */
export function permissionRequest(tool: string, input: unknown, suggestions: unknown): PermissionRequestInfo {
  const resource = resourceOf(tool, input)
  const save = savedRules(suggestions)
  return { action: permissionAction(tool), resources: resource === undefined ? [] : [resource], ...(save.length ? { save } : {}) }
}

/** A short summary of a tool call (its command or path's first line), or undefined when it has none. */
export function toolSummary(tool: string, input: unknown): string | undefined {
  const line = (resourceOf(tool, input) ?? summarizeToolInput(input)).trim().split("\n")[0]!
  return line ? cut(line, HARNESS_SUMMARY_MAX) : undefined
}
