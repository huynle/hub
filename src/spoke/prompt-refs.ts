// Prompt references (design §2.4): hub addresses typed into a prompt get context, never routing.
import { HubClient, type AgentMessage, type DirectoryEntry, type Status } from "../../packages/sdk/src/index.ts"
import { sanitizeLabel } from "../central/agent/envelope"
import { parseAddress } from "../central/agent/names"
import { isHubPrompt } from "./conversation"
import type { HubToolSpoke } from "./hub-tool"

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

/** The longest a prompt waits for the hub (design §2.4: ≤ 1.5 s); then it goes on without context. */
export const PROMPT_REF_TIMEOUT_MS = 1500
/** How long one session's lookup (or failure) is reused. */
export const PROMPT_REF_TTL_MS = 10_000
/** Cached sessions at most (expired ones are dropped first). */
const CACHE_MAX = 200

export const REFERENCE_FILE_NAME = "hub-references.txt"
const REFERENCE_FILE_DESCRIPTION = "hub: the sessions this prompt's @addresses name (context from the hub plugin)"

/** OpenCode's prompt hook event (plugin SessionPrompt), the parts used here. */
export interface PromptEvent {
  readonly sessionID: string
  readonly messageID?: string
  readonly delivery?: string
  metadata?: Record<string, unknown>
  prompt: {
    text: string
    files?: { uri: string; name?: string; description?: string; mention?: Mention }[]
    agents?: { name: string; mention?: Mention }[]
    skills?: { name?: string; mention?: Mention }[]
  }
}

export interface PromptReferencesOptions {
  readonly timeoutMs?: number
  readonly ttlMs?: number
  readonly now?: () => number
}

/** The hook: adds hub context for @name / @@role addresses as one text file; never changes the prompt text. */
export class PromptReferences {
  readonly #spoke: () => HubToolSpoke | undefined
  readonly #timeoutMs: number
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #cache = new Map<string, { at: number; snapshot: Promise<ReferenceSnapshot | undefined> }>()

  constructor(spoke: () => HubToolSpoke | undefined, options: PromptReferencesOptions = {}) {
    this.#spoke = spoke
    this.#timeoutMs = Math.min(options.timeoutMs ?? PROMPT_REF_TIMEOUT_MS, PROMPT_REF_TIMEOUT_MS)
    this.#ttlMs = options.ttlMs ?? PROMPT_REF_TTL_MS
    this.#now = options.now ?? Date.now
  }

  /** Never throws and never waits longer than the timeout (fail open). */
  async onPrompt(event: PromptEvent): Promise<void> {
    try {
      const prompt = event?.prompt
      if (!prompt || typeof prompt.text !== "string" || isHubPrompt(event.metadata)) return
      const addresses = findReferences(prompt)
      if (!addresses.length) return
      const spoke = this.#spoke()
      const identity = spoke?.shellIdentity(event.sessionID)
      if (!spoke || !identity?.token || !identity.url) return
      const { token, url } = identity
      const snapshot = await this.#snapshot(event.sessionID, () => this.#fetch({ token, url }, spoke.hubSupports("messaging")))
      if (!snapshot) return
      const refs = resolveReferences(addresses, snapshot, event.sessionID)
      if (!refs.length) return
      prompt.files = [...(prompt.files ?? []), referenceFile(renderReferences(refs))]
    } catch {
      // Fail open: the prompt goes on without context.
    }
  }

  #snapshot(sessionID: string, load: () => Promise<ReferenceSnapshot | undefined>): Promise<ReferenceSnapshot | undefined> {
    const now = this.#now()
    const cached = this.#cache.get(sessionID)
    if (cached && now - cached.at <= this.#ttlMs) return cached.snapshot
    for (const [key, value] of this.#cache) if (now - value.at > this.#ttlMs) this.#cache.delete(key)
    // Still full: drop the oldest (Map keeps insertion order).
    while (this.#cache.size >= CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!)
    const snapshot = load().catch(() => undefined)
    this.#cache.set(sessionID, { at: now, snapshot })
    return snapshot
  }

  /** who (required), status and inbox (optional details), in parallel, all within the timeout. */
  async #fetch(identity: { token: string; url: string }, messaging: boolean): Promise<ReferenceSnapshot | undefined> {
    const client = new HubClient({ url: identity.url, token: identity.token })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        abort.abort()
        resolve(undefined)
      }, this.#timeoutMs)
    })
    const signal = { signal: abort.signal }
    const optional = <T>(promise: Promise<T>) => promise.catch(() => undefined)
    const lookup = Promise.all([client.who(signal), optional(client.status(signal)), messaging ? optional(client.inbox(signal)) : undefined]).then(
      ([who, status, inbox]): ReferenceSnapshot => ({ who: who.sessions, ...(status ? { status } : {}), ...(inbox ? { waiting: inbox.waiting } : {}) }),
    )
    try {
      return await Promise.race([lookup, deadline])
    } finally {
      clearTimeout(timer)
      lookup.catch(() => undefined)
    }
  }
}

/** The context as an inline text file (the spike's mechanism: the model sees it inside the same user message). */
export function referenceFile(text: string): { uri: string; name: string; description: string } {
  return { uri: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`, name: REFERENCE_FILE_NAME, description: REFERENCE_FILE_DESCRIPTION }
}
