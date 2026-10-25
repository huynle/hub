// Short human text for the CLI's default output (--json prints the hub's answers unchanged). The shapes are those
// of src/central/agent/read-routes.ts and directory.ts; unknown fields are ignored, missing ones skipped.

export interface Blocker {
  readonly kind: string
  readonly id?: string
  readonly summary: string
}

export interface SessionView {
  readonly id: string
  readonly name?: string
  readonly roles?: readonly string[]
  readonly title?: string
  readonly state: string
  readonly harness?: string
  readonly now?: string
  readonly blockers?: readonly Blocker[]
}

const at = (name: string) => `@${name.replace(/^@+/, "")}`
export const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const blockerText = (b: Blocker) => `${b.kind}: ${oneLine(b.summary, 100)}`

/** `@name ses_…  state  harness  now  [kind: summary; …]` */
export function sessionLine(s: SessionView): string {
  const parts = [[s.name ? at(s.name) : undefined, s.id].filter(Boolean).join(" "), s.state]
  if (s.harness) parts.push(s.harness)
  if (s.now) parts.push(oneLine(s.now, 80))
  if (s.blockers?.length) parts.push(`[${s.blockers.map(blockerText).join("; ")}]`)
  return parts.join("  ")
}

interface Snapshot {
  readonly machines: readonly {
    id: string
    name?: string
    online: boolean
    harnesses?: readonly string[]
    projects: readonly { root: string; name: string; sessions: readonly SessionView[] }[]
  }[]
  readonly attention: readonly { kind: string; sessionID: string; name?: string; summary: string }[]
}

export function statusText(snapshot: Snapshot): string {
  const lines: string[] = []
  for (const m of snapshot.machines) {
    lines.push([m.name ?? m.id, m.online ? "online" : "offline", ...(m.harnesses ?? [])].join("  "))
    for (const p of m.projects) {
      lines.push(`  ${p.name}`)
      for (const s of p.sessions) lines.push(`    ${sessionLine(s)}`)
    }
  }
  if (lines.length === 0) lines.push("no machines")
  if (snapshot.attention.length) {
    lines.push("attention:")
    for (const a of snapshot.attention) lines.push(`  ${[a.name ? at(a.name) : undefined, a.sessionID].filter(Boolean).join(" ")}  ${a.kind}: ${oneLine(a.summary, 100)}`)
  }
  return lines.join("\n")
}

export const sessionsText = (sessions: readonly SessionView[]): string => (sessions.length ? sessions.map(sessionLine).join("\n") : "no sessions")

interface Shown extends SessionView {
  readonly online?: boolean
  readonly project?: string
  readonly directory?: string
  readonly machineID?: string
  readonly parentID?: string
  readonly lastSeen?: number
  readonly children?: number
  readonly summary?: {
    branch?: string
    context?: { used: number; limit?: number; percent?: number; model?: string }
    changes?: { additions: number; deletions: number; totalFiles: number }
    mcp?: readonly { name: string; status: string }[]
  }
  readonly unsupported?: readonly { feature?: string; harness?: string }[]
  readonly failed?: readonly { feature?: string }[]
}

export function showText(s: Shown): string {
  const lines = [[s.name ? at(s.name) : undefined, s.id].filter(Boolean).join(" ")]
  const field = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") lines.push(`${label}: ${value}`)
  }
  field("title", s.title)
  field("state", [s.state, s.harness].filter(Boolean).join("  "))
  field("project", [s.project, s.directory && s.directory !== s.project ? `(${s.directory})` : undefined].filter(Boolean).join(" ") || undefined)
  field("machine", s.machineID)
  field("parent", s.parentID)
  if (s.roles?.length) field("roles", s.roles.map((r) => `@${at(r)}`).join(" "))
  field("now", s.now)
  if (s.children) field("subagents", s.children)
  if (s.online === false && s.lastSeen !== undefined) field("last seen", new Date(s.lastSeen).toISOString())
  if (s.blockers?.length) {
    lines.push("blockers:")
    for (const b of s.blockers) lines.push(`  ${b.kind}${b.id ? ` ${b.id}` : ""}: ${oneLine(b.summary, 200)}`)
  }
  const sum = s.summary
  if (sum) {
    field("branch", sum.branch)
    if (sum.context) field("context", `${sum.context.used} tokens${sum.context.percent !== undefined ? ` (${sum.context.percent}%)` : ""}${sum.context.model ? ` ${sum.context.model}` : ""}`)
    if (sum.changes) field("changes", `${sum.changes.totalFiles} files +${sum.changes.additions} -${sum.changes.deletions}`)
    if (sum.mcp?.length) field("mcp", sum.mcp.map((m) => `${m.name} ${m.status}`).join(", "))
  }
  for (const u of s.unsupported ?? []) lines.push(`unsupported: ${u.feature ?? "?"}${u.harness ? ` (${u.harness})` : ""}`)
  for (const f of s.failed ?? []) lines.push(`failed: ${f.feature ?? "?"}`)
  return lines.join("\n")
}

interface Row {
  readonly kind: string
  readonly text?: string
  readonly name?: string
  readonly state?: string
  readonly title?: string
  readonly at?: number
}

const time = (ms: number | undefined) => (ms === undefined ? "--:--:--" : new Date(ms).toISOString().slice(11, 19))

/** Timeline rows (the hub sends newest first), printed oldest first. */
export function logText(rows: readonly Row[]): string {
  if (!rows.length) return "no rows"
  return [...rows]
    .reverse()
    .map((r) => {
      const head = r.kind === "tool" ? `tool ${r.name ?? "?"}${r.state ? ` (${r.state})` : ""}` : r.kind
      const body = oneLine(r.text ?? r.title ?? "", 200)
      return `${time(r.at)}  ${head}${body ? `  ${body}` : ""}`
    })
    .join("\n")
}

interface WhoEntry {
  readonly sessionID: string
  readonly name?: string
  readonly project?: string
  readonly title?: string
  readonly state?: string
  readonly online: boolean
  readonly roles: readonly { role: string; project?: string }[]
}

export function whoText(entries: readonly WhoEntry[]): string {
  if (!entries.length) return "no sessions"
  return entries
    .map((e) => {
      const parts = [[e.name ? at(e.name) : undefined, e.sessionID].filter(Boolean).join(" "), e.online ? (e.state ?? "online") : "offline"]
      if (e.roles.length) parts.push(e.roles.map((r) => `@@${r.role}${r.project !== undefined ? `.${r.project}` : ""}`).join(" "))
      if (e.project) parts.push(e.project)
      if (e.title) parts.push(oneLine(e.title, 60))
      return parts.join("  ")
    })
    .join("\n")
}

/** A caller as whoami / status `you` report it. */
export interface Actor {
  readonly kind: string
  readonly sessionID?: string
  readonly machineID?: string
  readonly tokenID?: string
  readonly label?: string
  readonly scopes?: readonly string[]
  readonly deviceID?: string
}

export function whoamiText(body: { actor: Actor; user: { id: string; name?: string; email?: string; role?: string } }): string {
  const { actor, user } = body
  const lines: string[] = []
  if (actor.kind === "session") lines.push(`session ${actor.sessionID}${actor.machineID ? ` on machine ${actor.machineID}` : ""}`)
  else if (actor.kind === "app") lines.push(`app token ${actor.tokenID}${actor.label ? ` (${actor.label})` : ""}${actor.scopes?.length ? ` scopes ${actor.scopes.join(",")}` : ""}`)
  else lines.push(`user${actor.deviceID ? ` (device ${actor.deviceID})` : ""}`)
  const who = [user.name, user.email ? `<${user.email}>` : undefined].filter(Boolean).join(" ") || user.id
  lines.push(`user ${who}${user.role ? ` (${user.role})` : ""}`)
  return lines.join("\n")
}

export const roleText = (r: { role: string; project?: string }) => `@@${r.role}${r.project !== undefined ? `.${r.project}` : ""}`
export { at as atName }
