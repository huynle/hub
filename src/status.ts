// Live status of a voice session and the subagent sessions it spawns, built from OpenCode events.
import type { JobInfo } from "./protocol"

export type SessionState = "idle" | "working" | "blocked" | "error"

export interface Blocker {
  readonly kind: "permission" | "form"
  readonly id: string
  readonly summary: string
  /** permission: what OpenCode asks to do ("shell", "edit", "read", an MCP tool), when it said. */
  readonly action?: string
  /** permission: what it applies to (commands, paths), at most BLOCKER_MAX_RESOURCES, each shortened. */
  readonly resources?: readonly string[]
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

/**
 * What a permission request asks, as OpenCode sent it (permission.asked), kept so a policy can judge it.
 * metadata (diff previews and the like) is dropped. When anything had to be cut or dropped, `truncated` is
 * set: a judgement on what is left does not cover the whole request.
 */
export interface PermissionRequest {
  /** "shell", "read", "edit", "external_directory", an MCP tool ("<server>_<tool>"), … */
  readonly action: string
  /** What the action applies to (one per parsed shell command, paths, "*"). */
  readonly resources: readonly string[]
  /** The patterns an "always" reply would save as rules. */
  readonly save?: readonly string[]
  /** The tool call that asked. */
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string }
  readonly truncated?: true
}

/** Resources (and save patterns) kept per request, and the length kept of each. */
export const PERMISSION_MAX_RESOURCES = 100
export const PERMISSION_TEXT_MAX = 4000
/** Longest action kept; a longer one makes the request unusable (undefined). */
const PERMISSION_ACTION_MAX = 200
const SOURCE_ID_MAX = 200
/** Resources shown on a blocker (catalog and status go to every console), and the length of each. */
export const BLOCKER_MAX_RESOURCES = 10
const BLOCKER_RESOURCE_MAX = 500

/** Strings of `list`, bounded; `cut` is set when anything was dropped or shortened. */
function boundedStrings(list: unknown, maxItems: number, maxLength: number): { items: string[]; cut: boolean } {
  if (!Array.isArray(list)) return { items: [], cut: list !== undefined }
  const strings = list.filter((v): v is string => typeof v === "string")
  const items = strings.slice(0, maxItems).map((v) => v.slice(0, maxLength))
  const cut = strings.length !== list.length || strings.length > maxItems || strings.some((v) => v.length > maxLength)
  return { items, cut }
}

/** A permission.asked event's request, bounded; undefined without a usable action. */
export function permissionRequest(raw: any): PermissionRequest | undefined {
  const action = raw?.action
  if (typeof action !== "string" || !action || action.length > PERMISSION_ACTION_MAX) return undefined
  const resources = boundedStrings(raw.resources, PERMISSION_MAX_RESOURCES, PERMISSION_TEXT_MAX)
  const save = raw.save === undefined ? undefined : boundedStrings(raw.save, PERMISSION_MAX_RESOURCES, PERMISSION_TEXT_MAX)
  const src = raw.source
  const source =
    src?.type === "tool" && typeof src.messageID === "string" && typeof src.id === "string"
      ? { type: "tool" as const, messageID: src.messageID.slice(0, SOURCE_ID_MAX), id: src.id.slice(0, SOURCE_ID_MAX) }
      : undefined
  return {
    action,
    resources: resources.items,
    ...(save ? { save: save.items } : {}),
    ...(source ? { source } : {}),
    ...(resources.cut || save?.cut ? { truncated: true as const } : {}),
  }
}

/** A permission.asked event as a blocker: its summary, and what it asks (bounded for display). */
function permissionBlocker(data: Record<string, any>): Blocker {
  const action = typeof data.action === "string" && data.action ? data.action.slice(0, PERMISSION_ACTION_MAX) : undefined
  const resources = boundedStrings(data.resources, BLOCKER_MAX_RESOURCES, BLOCKER_RESOURCE_MAX).items
  return {
    kind: "permission",
    id: data.id,
    summary: [data.action, (data.resources ?? []).join(", ")].filter(Boolean).join(": "),
    ...(action ? { action } : {}),
    ...(resources.length ? { resources } : {}),
  }
}

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
  /** OpenCode is retrying the model request (state stays "working"). */
  readonly retry?: { readonly attempt?: number; readonly message?: string }
  /** Shells and terminals of the session: running ones, then the last few that ended (oldest first). */
  readonly jobs?: readonly JobInfo[]
}

/** Ended jobs kept per session (shown briefly with their exit code). */
export const ENDED_JOBS_KEPT = 5
/** Jobs kept per session at most (running ones beyond it are dropped oldest first). */
const JOBS_MAX = 50

interface Entry {
  id: string
  parentID?: string
  title: string
  running: boolean
  /** session.status: busy or retry (OpenCode's own view of the session). */
  busy: boolean
  retry?: { attempt?: number; message?: string }
  error?: string
  blockers: Blocker[]
  jobs: JobInfo[]
}

interface EventLike {
  readonly type: string
  readonly data?: unknown
}

export class StatusBoard {
  private readonly sessions = new Map<string, Entry>()

  constructor(rootID: string, title: string) {
    this.sessions.set(rootID, { id: rootID, title, running: false, busy: false, blockers: [], jobs: [] })
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
          busy: false,
          blockers: [],
          jobs: [],
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
        return this.update(data.sessionID, (entry) => endRun(entry))
      case "session.execution.failed":
        return this.update(data.sessionID, (entry) => {
          endRun(entry)
          entry.error = String(data.error?.message ?? "failed")
        })
      case "permission.asked":
        return this.update(data.sessionID, (entry) => {
          if (entry.blockers.some((b) => b.id === data.id)) return
          entry.blockers.push(permissionBlocker(data))
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
      case "session.status":
        return this.update(data.sessionID, (entry) => setStatus(entry, data.status))
      case "session.seed":
        return this.update(data.sessionID, (entry) => {
          setStatus(entry, data.status)
          entry.jobs = entry.jobs.filter((job) => job.status !== "running")
          for (const job of Array.isArray(data.jobs) ? data.jobs : []) if (isJob(job)) upsertJob(entry, job)
        })
      case "shell.created":
      case "session.shell.started":
      case "pty.created":
      case "pty.updated":
      case "shell.exited":
      case "session.shell.ended":
      case "pty.exited":
        return this.update(data.sessionID, (entry) => {
          const job = jobOf(data, entry.jobs.find((j) => j.id === data.id))
          if (job) upsertJob(entry, job)
        })
      case "shell.deleted":
      case "pty.deleted":
        return this.update(data.sessionID, (entry) => {
          entry.jobs = entry.jobs.filter((job) => job.id !== data.id)
        })
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

  /**
   * True when nothing in the tree runs (no run, busy or retrying status), waits for an answer, or has a running
   * shell job. Terminals (pty) do not count: an open terminal is not work in progress.
   */
  settled(): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.running || entry.busy || entry.blockers.length) return false
      if (entry.jobs.some((job) => job.status === "running" && job.kind === "shell")) return false
    }
    return true
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

const JOB_STATUSES = new Set(["running", "exited", "timeout", "killed"])

function isJob(v: any): v is JobInfo {
  return typeof v?.id === "string" && v.id && (v.kind === "shell" || v.kind === "pty") && JOB_STATUSES.has(v.status)
}

/** A job event's data (compact, see compactActivity) merged over what is known of the job. */
function jobOf(data: Record<string, any>, known: JobInfo | undefined): JobInfo | undefined {
  if (typeof data.id !== "string" || !JOB_STATUSES.has(data.status)) return undefined
  const kind = data.kind === "pty" ? "pty" : "shell"
  const ended = data.status !== "running"
  const at = num(data.at)
  const command = text(data.command, 200) ?? known?.command
  const exit = num(data.exit) ?? (ended ? known?.exit : undefined)
  const started = known?.started ?? (!ended ? at : undefined)
  return {
    id: data.id,
    kind,
    ...(command ? { command } : {}),
    status: data.status,
    ...(exit !== undefined ? { exit } : {}),
    ...(data.background === true || known?.background ? { background: true as const } : {}),
    ...(started !== undefined ? { started } : {}),
    ...(ended && at !== undefined ? { ended: at } : {}),
  }
}

function upsertJob(entry: Entry, job: JobInfo): void {
  const rest = entry.jobs.filter((j) => j.id !== job.id)
  rest.push({ ...job })
  const running = rest.filter((j) => j.status === "running")
  const endedJobs = rest.filter((j) => j.status !== "running").slice(-ENDED_JOBS_KEPT)
  const keep = new Set([...running.slice(-JOBS_MAX), ...endedJobs])
  entry.jobs = rest.filter((j) => keep.has(j))
}

/** A run ended: OpenCode v2 sends no idle status, so a busy or retrying status (e.g. seeded) ends with it. */
function endRun(entry: Entry): void {
  entry.running = false
  entry.busy = false
  entry.retry = undefined
}

function setStatus(entry: Entry, status: any): void {
  const type = status?.type
  if (type !== "idle" && type !== "busy" && type !== "retry") return
  entry.busy = type !== "idle"
  if (type === "retry") {
    const attempt = num(status.attempt)
    const message = text(status.message, 200)
    entry.retry = { ...(attempt !== undefined ? { attempt } : {}), ...(message ? { message } : {}) }
  } else entry.retry = undefined
  if (type === "busy") entry.error = undefined
}

function view(entry: Entry): SessionStatus {
  const working = entry.running || entry.busy || entry.jobs.some((job) => job.status === "running")
  const state: SessionState =
    entry.blockers.length > 0 ? "blocked" : entry.error && !working ? "error" : working ? "working" : "idle"
  const retry = entry.retry && state === "working" ? entry.retry : undefined
  const detail = state === "error" ? entry.error : retry ? (retry.message ? `Retrying: ${retry.message}` : "Retrying") : undefined
  return {
    id: entry.id,
    ...(entry.parentID ? { parentID: entry.parentID } : {}),
    title: entry.title,
    state,
    ...(detail ? { detail } : {}),
    blockers: entry.blockers.map((blocker) => structuredClone(blocker)),
    ...(retry ? { retry: { ...retry } } : {}),
    ...(entry.jobs.length ? { jobs: entry.jobs.map((job) => ({ ...job })) } : {}),
  }
}
