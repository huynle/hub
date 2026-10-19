// The voice agent's task board: its background workers (child sessions) with their state, last activity and
// how long, built from the OpenCode events this process sees. The context hook adds the rendered board to every
// voice turn, so the agent can answer "what's running?" or "how's the deploy going?" without a tool call, and
// the stop tool (hub_task_stop) checks with it that a worker belongs to the session asking. Pure: time is
// passed in.
import { summarizeToolInput } from "../protocol"

/** Tasks shown on the board, and the longest line. */
export const TASK_BOARD_MAX = 8
export const TASK_LINE_MAX = 200
/** Tasks remembered in this process (finished ones are forgotten first). */
const TASK_LIMIT = 300
const TITLE_MAX = 60
const TEXT_MAX = 160
/** Tool call IDs remembered per task to name their activity. */
const TOOL_NAMES_MAX = 20

export type TaskState = "working" | "blocked" | "done" | "failed" | "stopped"

export interface Task {
  readonly id: string
  readonly parentID: string
  readonly title: string
  readonly state: TaskState
  /** ms epoch the current run started. */
  readonly started: number
  /** ms epoch the run ended (done, failed, stopped). */
  readonly ended?: number
  /** Since when it waits for the user (blocked). */
  readonly blockedAt?: number
  /** The latest tool it ran ("shell · bun test"). */
  readonly activity?: string
  /** Its latest assistant text (the result once done). */
  readonly result?: string
  readonly error?: string
  /** Why it is blocked ("needs permission: …", "has a question: …"). */
  readonly blocker?: string
}

interface Entry {
  id: string
  parentID: string
  title: string
  running: boolean
  outcome?: "done" | "failed" | "stopped"
  started: number
  ended?: number
  activity?: string
  result?: string
  error?: string
  /** Pending permission / form ID → its description, in order. */
  blockers: Map<string, { text: string; at: number }>
  tools: Map<string, string>
}

const record = (v: unknown): Record<string, any> => (typeof v === "object" && v !== null ? (v as Record<string, any>) : {})
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const LIVE = (e: Entry) => e.running || e.blockers.size > 0

export class TaskBoard {
  private readonly entries = new Map<string, Entry>()
  private readonly limit: number

  constructor({ limit = TASK_LIMIT }: { limit?: number } = {}) {
    this.limit = limit
  }

  observe(event: { type: string; data?: unknown }, now: number): void {
    const data = record(event.data)
    const sessionID = str(data.sessionID) ?? str(record(data.form).sessionID)
    if (!sessionID) return
    if (event.type === "session.created") {
      const parentID = str(data.parentID)
      if (!parentID) return
      this.entries.delete(sessionID)
      this.entries.set(sessionID, {
        id: sessionID,
        parentID,
        title: oneLine(str(data.title) ?? str(data.agent) ?? "worker", TITLE_MAX),
        running: false,
        started: now,
        blockers: new Map(),
        tools: new Map(),
      })
      this.prune()
      return
    }
    const entry = this.entries.get(sessionID)
    if (!entry) return
    switch (event.type) {
      case "session.renamed":
        if (str(data.title)) entry.title = oneLine(data.title, TITLE_MAX)
        return
      case "session.deleted":
        this.entries.delete(sessionID)
        return
      case "session.execution.started":
        if (!entry.running) entry.started = now
        entry.running = true
        entry.outcome = entry.ended = entry.error = undefined
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        entry.running = false
        entry.ended = now
        entry.blockers.clear()
        entry.outcome = event.type.endsWith("succeeded") ? "done" : event.type.endsWith("failed") ? "failed" : "stopped"
        if (entry.outcome === "failed") entry.error = oneLine(str(record(data.error).message) ?? "failed", TEXT_MAX)
        return
      case "session.tool.input.started": {
        const id = str(data.id)
        const name = str(data.name)
        if (!id || !name) return
        entry.tools.set(id, name)
        if (entry.tools.size > TOOL_NAMES_MAX) entry.tools.delete(entry.tools.keys().next().value!)
        entry.activity = name
        return
      }
      case "session.tool.called": {
        const name = entry.tools.get(str(data.id) ?? "") ?? str(data.name) ?? "tool"
        const summary = str(data.summary) ?? summarizeToolInput(data.input)
        entry.activity = oneLine(summary ? `${name} · ${summary}` : name, TEXT_MAX)
        return
      }
      case "session.text.ended":
        if (str(data.text)?.trim()) entry.result = oneLine(data.text, TEXT_MAX)
        return
      case "permission.asked": {
        const id = str(data.id)
        if (!id) return
        const what = [str(data.action), Array.isArray(data.resources) ? data.resources.filter((r: unknown) => typeof r === "string").join(", ") : ""].filter(Boolean).join(": ")
        entry.blockers.set(`per ${id}`, { text: oneLine(what ? `needs permission: ${what}` : "needs permission", TEXT_MAX), at: now })
        return
      }
      case "permission.replied":
        entry.blockers.delete(`per ${str(data.requestID)}`)
        return
      case "form.created": {
        const form = record(data.form)
        const id = str(form.id)
        if (!id) return
        entry.blockers.set(`frm ${id}`, { text: oneLine(str(form.title) ? `has a question: ${form.title}` : "has a question", TEXT_MAX), at: now })
        return
      }
      case "form.replied":
      case "form.cancelled":
        entry.blockers.delete(`frm ${str(data.id) ?? str(record(data.form).id)}`)
        return
    }
  }

  /** The workers a session started: live ones first (newest first), then finished ones (latest first). */
  children(parentID: string): Task[] {
    const mine = [...this.entries.values()].filter((e) => e.parentID === parentID)
    const live = mine.filter(LIVE).sort((a, b) => b.started - a.started)
    const finished = mine.filter((e) => !LIVE(e)).sort((a, b) => (b.ended ?? b.started) - (a.ended ?? a.started))
    return [...live, ...finished].map(view)
  }

  get(id: string): Task | undefined {
    const entry = this.entries.get(id)
    return entry && view(entry)
  }

  /** The session that started a known worker. */
  parentOf(id: string): string | undefined {
    return this.entries.get(id)?.parentID
  }

  private prune(): void {
    while (this.entries.size > this.limit) {
      const finished = [...this.entries.values()].filter((e) => !LIVE(e)).sort((a, b) => (a.ended ?? a.started) - (b.ended ?? b.started))[0]
      this.entries.delete(finished?.id ?? this.entries.keys().next().value!)
    }
  }
}

function view(entry: Entry): Task {
  const blocker = [...entry.blockers.values()][0]
  const state: TaskState = blocker ? "blocked" : entry.running ? "working" : (entry.outcome ?? "working")
  return {
    id: entry.id,
    parentID: entry.parentID,
    title: entry.title,
    state,
    started: entry.started,
    ...(entry.ended !== undefined && !entry.running ? { ended: entry.ended } : {}),
    ...(blocker ? { blocker: blocker.text, blockedAt: blocker.at } : {}),
    ...(entry.activity ? { activity: entry.activity } : {}),
    ...(entry.result ? { result: entry.result } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }
}

/** "45s", "2m 10s", "1h 5m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`
}

function line(task: Task, now: number): string {
  const head = `- "${task.title}" (sessionID ${task.id}): `
  let rest: string
  switch (task.state) {
    case "blocked":
      rest = `blocked ${duration(now - (task.blockedAt ?? task.started))}, ${task.blocker}`
      break
    case "working":
      rest = `working ${duration(now - task.started)}${task.activity ? `, last: ${task.activity}` : ""}`
      break
    case "done":
      rest = `done ${duration(now - (task.ended ?? now))} ago (took ${duration((task.ended ?? now) - task.started)})${task.result ? `: ${task.result}` : ""}`
      break
    case "failed":
      rest = `failed ${duration(now - (task.ended ?? now))} ago${task.error ? `: ${task.error}` : ""}`
      break
    case "stopped":
      rest = `stopped ${duration(now - (task.ended ?? now))} ago`
      break
  }
  const text = head + rest
  return text.length > TASK_LINE_MAX ? `${text.slice(0, TASK_LINE_MAX - 1)}…` : text
}

/** The board for the voice agent's system prompt; undefined when it started no workers. */
export function renderTaskBoard(tasks: readonly Task[], now: number, { max = TASK_BOARD_MAX }: { max?: number } = {}): string | undefined {
  if (!tasks.length) return undefined
  const shown = tasks.slice(0, max)
  return [
    "Task board: your background workers right now (live; answer questions about them from this, no tool call needed; use a sessionID to continue or stop that worker):",
    ...shown.map((task) => line(task, now)),
    ...(tasks.length > shown.length ? [`(${tasks.length - shown.length} older tasks not shown)`] : []),
  ].join("\n")
}
