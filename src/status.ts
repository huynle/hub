// Live status of a voice session and the subagent sessions it spawns, built from OpenCode events.

export type SessionState = "idle" | "working" | "blocked" | "error"

export interface Blocker {
  readonly kind: "permission" | "form"
  readonly id: string
  readonly summary: string
  /** form: asked by the agent's question tool (metadata.kind "question"). */
  readonly question?: true
  /** form: its fields, bounded, so a phone can render and answer it. */
  readonly fields?: readonly FormFieldSpec[]
}

export interface FormOptionSpec {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** One field of an OpenCode form (FormField), with only what a client needs to render and validate it. */
export interface FormFieldSpec {
  readonly key: string
  readonly type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly options?: readonly FormOptionSpec[]
  /** string/multiselect with options: free text allowed besides the options. */
  readonly custom?: boolean
  readonly placeholder?: string
  readonly default?: string | number | boolean | readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly format?: string
  readonly pattern?: string
  /** external: a link the user follows. */
  readonly url?: string
  /** Shown only when these conditions on other fields hold. */
  readonly when?: ReadonlyArray<{ readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }>
}

export const FORM_MAX_FIELDS = 20
export const FORM_MAX_OPTIONS = 50
const FORM_TEXT_MAX = 2000
const FORM_LABEL_MAX = 300
const FIELD_TYPES = new Set<FormFieldSpec["type"]>(["string", "number", "integer", "boolean", "multiselect", "external"])

const text = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function optionSpec(raw: any): FormOptionSpec | undefined {
  const value = text(raw?.value, FORM_LABEL_MAX)
  if (value === undefined) return undefined
  const description = text(raw.description, FORM_TEXT_MAX)
  return { value, label: text(raw.label, FORM_LABEL_MAX) ?? value, ...(description ? { description } : {}) }
}

/** The renderable part of an OpenCode form field; undefined for fields a client cannot show. */
export function formFieldSpec(raw: any): FormFieldSpec | undefined {
  const key = text(raw?.key, FORM_LABEL_MAX)
  if (!key || !FIELD_TYPES.has(raw.type)) return undefined
  const out: Record<string, unknown> = { key, type: raw.type }
  for (const name of ["title", "placeholder", "format", "pattern"] as const) if (text(raw[name], FORM_LABEL_MAX)) out[name] = text(raw[name], FORM_LABEL_MAX)
  if (text(raw.description, FORM_TEXT_MAX)) out.description = text(raw.description, FORM_TEXT_MAX)
  if (raw.type === "external") {
    const url = text(raw.url, FORM_TEXT_MAX)
    if (!url || !/^https?:\/\//.test(url)) return undefined
    out.url = url
  }
  if (raw.required === true) out.required = true
  if (raw.custom === true) out.custom = true
  if (Array.isArray(raw.options)) {
    const options = raw.options.slice(0, FORM_MAX_OPTIONS).map(optionSpec).filter(Boolean)
    if (options.length) out.options = options
  }
  for (const name of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) if (num(raw[name]) !== undefined) out[name] = raw[name]
  const d = raw.default
  if (typeof d === "boolean" || num(d) !== undefined) out.default = d
  else if (typeof d === "string") out.default = d.slice(0, FORM_TEXT_MAX)
  else if (Array.isArray(d)) out.default = d.filter((x: unknown) => typeof x === "string").slice(0, FORM_MAX_OPTIONS)
  if (Array.isArray(raw.when)) {
    const when = raw.when
      .filter((w: any) => typeof w?.key === "string" && (w.op === "eq" || w.op === "neq") && ["string", "number", "boolean"].includes(typeof w.value))
      .slice(0, 10)
      .map((w: any) => ({ key: w.key, op: w.op, value: w.value }))
    if (when.length) out.when = when
  }
  return out as unknown as FormFieldSpec
}

/** A form.created event's form as a blocker. */
function formBlocker(form: any): Blocker {
  const fields = Array.isArray(form.fields) ? form.fields.map(formFieldSpec).filter(Boolean).slice(0, FORM_MAX_FIELDS) : []
  return {
    kind: "form",
    id: form.id,
    summary: typeof form.title === "string" && form.title ? form.title.slice(0, FORM_LABEL_MAX) : "question",
    ...(form.metadata?.kind === "question" ? { question: true as const } : {}),
    ...(fields.length ? { fields } : {}),
  }
}

export interface SessionStatus {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly state: SessionState
  readonly detail?: string
  readonly blockers: ReadonlyArray<Blocker>
}

interface Entry {
  id: string
  parentID?: string
  title: string
  running: boolean
  error?: string
  blockers: Blocker[]
}

interface EventLike {
  readonly type: string
  readonly data?: unknown
}

export class StatusBoard {
  private readonly sessions = new Map<string, Entry>()

  constructor(rootID: string, title: string) {
    this.sessions.set(rootID, { id: rootID, title, running: false, blockers: [] })
  }

  /** Applies an event. Returns true when the visible status changed. */
  observe(event: EventLike): boolean {
    const data = (event.data ?? {}) as Record<string, any>
    switch (event.type) {
      case "session.created": {
        if (typeof data.parentID !== "string" || !this.sessions.has(data.parentID)) return false
        this.sessions.set(data.sessionID, {
          id: data.sessionID,
          parentID: data.parentID,
          title: data.title ?? data.agent ?? data.slug ?? "subagent",
          running: false,
          blockers: [],
        })
        return true
      }
      case "session.renamed":
        return this.update(data.sessionID, (entry) => (entry.title = data.title))
      case "session.deleted":
        return this.sessions.delete(data.sessionID)
      case "session.execution.started":
        return this.update(data.sessionID, (entry) => {
          entry.running = true
          entry.error = undefined
        })
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        return this.update(data.sessionID, (entry) => (entry.running = false))
      case "session.execution.failed":
        return this.update(data.sessionID, (entry) => {
          entry.running = false
          entry.error = String(data.error?.message ?? "failed")
        })
      case "permission.asked":
        return this.update(data.sessionID, (entry) => {
          if (entry.blockers.some((b) => b.id === data.id)) return
          entry.blockers.push({
            kind: "permission",
            id: data.id,
            summary: [data.action, (data.resources ?? []).join(", ")].filter(Boolean).join(": "),
          })
        })
      case "permission.replied":
        return this.unblock(data.sessionID, data.requestID)
      case "form.created":
        return this.update(data.form?.sessionID, (entry) => {
          if (entry.blockers.some((b) => b.id === data.form.id)) return
          entry.blockers.push(formBlocker(data.form))
        })
      case "form.replied":
      case "form.cancelled":
        return this.unblock(data.sessionID, data.id)
      default:
        return false
    }
  }

  get(id: string): SessionStatus | undefined {
    const entry = this.sessions.get(id)
    return entry && view(entry)
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  snapshot(): { sessions: SessionStatus[] } {
    return { sessions: [...this.sessions.values()].map(view) }
  }

  private update(id: unknown, change: (entry: Entry) => void): boolean {
    const entry = typeof id === "string" ? this.sessions.get(id) : undefined
    if (!entry) return false
    change(entry)
    return true
  }

  private unblock(sessionID: unknown, blockerID: unknown): boolean {
    return this.update(sessionID, (entry) => {
      entry.blockers = entry.blockers.filter((blocker) => blocker.id !== blockerID)
    })
  }
}

function view(entry: Entry): SessionStatus {
  const state: SessionState =
    entry.blockers.length > 0 ? "blocked" : entry.error ? "error" : entry.running ? "working" : "idle"
  return {
    id: entry.id,
    ...(entry.parentID ? { parentID: entry.parentID } : {}),
    title: entry.title,
    state,
    ...(entry.error && state === "error" ? { detail: entry.error } : {}),
    blockers: entry.blockers.map((blocker) => structuredClone(blocker)),
  }
}
