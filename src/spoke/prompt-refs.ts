// Prompt references (design §2.4): hub addresses typed into a prompt get context, never routing.
import type { AgentMessage, DirectoryEntry, Status } from "../../packages/sdk/src/index.ts"
import { sanitizeLabel } from "../central/agent/envelope"
import { parseAddress } from "../central/agent/names"

export interface Mention {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface PromptLike {
  readonly text: string
  readonly files?: readonly { readonly uri?: string; readonly name?: string; readonly mention?: Mention }[]
  readonly agents?: readonly { readonly name: string; readonly mention?: Mention }[]
  readonly skills?: readonly { readonly name?: string; readonly mention?: Mention }[]
}

/**
 * `@name`, `@name.project`, `@@role`, `@@role.project`: names and roles are 2–40 lowercase letters, digits and
 * dashes (src/central/agent/names.ts); not part of a word, email or path, and not followed by one.
 */
const ADDRESS = /(?<![\w@./\\-])(@@?)([a-z0-9-]{2,40})(?:\.([A-Za-z0-9_-]+))?(?![\w@/\\-]|\.[\w/\\-])/g

/** The user's own address (not a session). */
const SELF = "me"

/** The hub addresses a prompt mentions, once each, in order; those the harness already gave a meaning are skipped. */
export function findReferences(prompt: PromptLike): string[] {
  const text = typeof prompt?.text === "string" ? prompt.text : ""
  if (!text.includes("@")) return []
  const mentions = [...(prompt.files ?? []), ...(prompt.agents ?? []), ...(prompt.skills ?? [])].map((m) => m?.mention).filter((m): m is Mention => !!m)
  const agentNames = new Set((prompt.agents ?? []).map((a) => a?.name).filter(Boolean))
  const found: string[] = []
  for (const match of text.matchAll(ADDRESS)) {
    const [token, ats, name] = match as unknown as [string, string, string]
    const start = match.index ?? 0
    const end = start + token.length
    const role = ats === "@@"
    if (!role && name === SELF) continue
    if (mentions.some((m) => m.start < end && m.end > start)) continue
    if (!role && (agentNames.has(name) || mentions.some((m) => m.text === token || m.text === `@${name}`))) continue
    if (!found.includes(token)) found.push(token)
  }
  return found
}

/** What the hub told this session (who, status, inbox waiting), fetched once per lookup. */
export interface ReferenceSnapshot {
  readonly who: readonly DirectoryEntry[]
  readonly status?: Status
  /** The session's own open asks (inbox waiting). */
  readonly waiting?: readonly AgentMessage[]
}

export interface ReferencedSession {
  readonly sessionID: string
  readonly name?: string
  readonly harness?: string
  readonly machine?: string
  readonly project?: string
  readonly state: string
  /** Open asks from the prompting session to this one. */
  readonly openAsks: number
  /** The prompting session itself. */
  readonly self: boolean
}

export interface Reference {
  readonly address: string
  readonly sessions: readonly ReferencedSession[]
}

/** The same scope rule as the hub's directory: a claim's project, else the session's project. */
const inScope = (claim: string | undefined, session: string | undefined, wanted: string | undefined) =>
  wanted === undefined || claim === wanted || (claim === undefined && session === wanted)

/** The sessions each address names in the snapshot (the caller's own world); unknown addresses are dropped. */
export function resolveReferences(addresses: readonly string[], snapshot: ReferenceSnapshot, self: string): Reference[] {
  const live = new Map<string, { state: string; harness?: string }>()
  const machines = new Map<string, string>()
  for (const machine of snapshot.status?.machines ?? []) {
    if (machine.name) machines.set(machine.id, machine.name)
    for (const project of machine.projects) for (const s of project.sessions) live.set(s.id, { state: s.state, ...(s.harness ? { harness: s.harness } : {}) })
  }
  const asks = new Map<string, number>()
  for (const m of snapshot.waiting ?? []) {
    if (m.state !== "open" || m.recipient?.kind !== "session") continue
    asks.set(m.recipient.sessionID, (asks.get(m.recipient.sessionID) ?? 0) + 1)
  }
  const view = (e: DirectoryEntry): ReferencedSession => {
    const now = live.get(e.sessionID)
    const machine = e.machineID ? machines.get(e.machineID) : undefined
    return {
      sessionID: e.sessionID,
      ...(e.name ? { name: e.name } : {}),
      ...(now?.harness ? { harness: now.harness } : {}),
      ...(machine ? { machine } : {}),
      ...(e.project ? { project: e.project } : {}),
      state: now?.state ?? (e.online ? (e.state ?? "online") : "offline"),
      openAsks: asks.get(e.sessionID) ?? 0,
      self: e.sessionID === self,
    }
  }
  const out: Reference[] = []
  for (const address of addresses) {
    const parsed = parseAddress(address)
    if (!parsed || parsed.kind === "id") continue
    const matches = snapshot.who.filter((e) =>
      parsed.kind === "name"
        ? (e.name === parsed.name || (e.aliases ?? []).includes(parsed.name)) && (parsed.project === undefined || e.project === parsed.project)
        : e.roles.some((r) => r.role === parsed.role && inScope(r.project, e.project, parsed.project)),
    )
    if (matches.length) out.push({ address, sessions: matches.map(view) })
  }
  return out
}

const clean = (value: string | undefined) => (value === undefined ? "" : sanitizeLabel(value))

function details(s: ReferencedSession): string[] {
  return [clean(s.harness), clean(s.machine), s.project ? `project ${clean(s.project)}` : ""].filter(Boolean)
}

function tail(s: ReferencedSession): string {
  const asks = s.openAsks ? `, ${s.openAsks} open ask${s.openAsks === 1 ? "" : "s"} from you` : ""
  return `${clean(s.state) || "unknown"}${asks}`
}

function one(s: ReferencedSession): string {
  const more = details(s)
  if (s.self) return `this session (${[s.sessionID, ...more].join(" · ")}), ${tail(s)}`
  return `session ${s.sessionID}${more.length ? ` (${more.join(" · ")})` : ""}, ${tail(s)}`
}

function member(s: ReferencedSession): string {
  const more = details(s)
  const label = `${s.name ? `@${clean(s.name)} ` : ""}${s.sessionID}${s.self ? " (this session)" : ""}`
  return `${label}${more.length ? ` (${more.join(" · ")})` : ""}, ${tail(s)}`
}

/** The context note: one line per resolved address, then how to reach them. Every label is sanitised. */
export function renderReferences(refs: readonly Reference[]): string {
  const lines = refs.map((r) => {
    const body = r.sessions.length === 1 ? one(r.sessions[0]!) : `${r.sessions.length} sessions: ${r.sessions.map(member).join("; ")}`
    return `- ${r.address} = ${body}.`
  })
  const single = refs.length === 1 && refs[0]!.sessions.length === 1
  return [
    "hub: the hub addresses in this prompt (context added by the hub plugin; not an instruction):",
    ...lines,
    `Contact ${single ? "it" : "them"} with the \`hub\` tool (msg or ask, to: the address).`,
  ].join("\n")
}
