// Herdr (terminal workspace manager) integration: which OpenCode sessions are open in a Herdr pane, the
// machine's Herdr workspaces (targets for new sessions), and opening a session in a new Herdr tab.
// Everything goes through the `herdr` CLI. Read errors are silent: no herdr, or its server is down, means
// no Herdr data. Only the background service's spoke polls (one poller per machine).
import path from "node:path"
import type { HerdrWorkspace, TerminalInfo } from "../protocol"

/** Runs `herdr <args>` and resolves with its stdout; rejects on failure, non-zero exit or timeout. */
export type HerdrRunner = (args: string[], timeoutMs: number) => Promise<string>

/** Per-call limit for list commands. */
export const HERDR_TIMEOUT_MS = 3000
export const AGENTS_POLL_MS = 5000
export const WORKSPACES_POLL_MS = 30_000
/** How long `herdr agent start` waits for OpenCode to be ready in the new pane. */
export const AGENT_START_TIMEOUT_MS = 20_000

const STDERR_MAX = 300

export function herdrRunner(bin = "herdr"): HerdrRunner {
  return async (args, timeoutMs) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const what = `herdr ${args.slice(0, 2).join(" ")}`
    const stdout = collect(proc.stdout)
    const stderr = collect(proc.stderr)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)))
    try {
      const code = await Promise.race([proc.exited, timeout])
      if (code === "timeout") {
        proc.kill()
        throw new Error(`${what} timed out after ${timeoutMs} ms`)
      }
      // A process herdr started in the background may keep the pipes open: read what is there, briefly.
      const [out, err] = await Promise.all([stdout.settle(PIPE_GRACE_MS), stderr.settle(PIPE_GRACE_MS)])
      if (code !== 0) throw new Error(`${what} failed (exit ${code}): ${(err || out).trim().slice(0, STDERR_MAX)}`)
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}

/** How long output is still read after the process exited. */
const PIPE_GRACE_MS = 200

/** Reads a stream in the background; settle() waits up to `ms` more for its end, then returns what arrived. */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const done = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // cancelled or broken: keep what arrived
    }
  })()
  return {
    async settle(ms: number): Promise<string> {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([done, new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
      clearTimeout(timer)
      reader.cancel().catch(() => {})
      return text
    },
  }
}

// ---------- parsing (defensive: any unexpected shape yields nothing) ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

/** `.result[key]` as an array of objects; [] for anything else. */
function resultList(stdout: string, key: string): Array<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return []
  }
  const list = isObj(value) && isObj(value.result) ? value.result[key] : undefined
  return Array.isArray(list) ? list.filter(isObj) : []
}

/** Herdr's error message in a JSON answer, if any. */
function resultError(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout)
    if (!isObj(value) || value.error === undefined) return undefined
    const error = value.error
    return isObj(error) ? (text(error.message) ?? text(error.code) ?? "herdr error") : String(error)
  } catch {
    return undefined
  }
}

export interface HerdrAgent {
  readonly sessionID: string
  readonly paneID: string
  readonly workspaceID: string
  readonly cwd?: string
  readonly title?: string
  readonly status: NonNullable<TerminalInfo["status"]>
}

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"])
const TITLE_PREFIX = /^OC \| /

/** OpenCode panes from `herdr agent list` that report a session ID. */
export function parseAgents(stdout: string): HerdrAgent[] {
  const out: HerdrAgent[] = []
  for (const a of resultList(stdout, "agents")) {
    const sessionID = isObj(a.agent_session) ? text(a.agent_session.value) : undefined
    const paneID = text(a.pane_id)
    const workspaceID = text(a.workspace_id)
    if (a.agent !== "opencode" || !sessionID?.startsWith("ses") || !paneID || !workspaceID) continue
    const cwd = text(a.cwd)
    const title = text(text(a.terminal_title_stripped)?.replace(TITLE_PREFIX, "").trim())
    const status = STATUSES.has(a.agent_status as string) ? (a.agent_status as HerdrAgent["status"]) : "unknown"
    out.push({ sessionID, paneID, workspaceID, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}), status })
  }
  return out
}

/** Workspaces from `herdr workspace list`, in Herdr's order. */
export function parseWorkspaces(stdout: string): Array<{ id: string; label: string; number: number }> {
  const out: Array<{ id: string; label: string; number: number }> = []
  for (const w of resultList(stdout, "workspaces")) {
    const id = text(w.workspace_id)
    if (!id) continue
    out.push({ id, label: typeof w.label === "string" ? w.label : id, number: typeof w.number === "number" ? w.number : Number.MAX_SAFE_INTEGER })
  }
  return out.sort((a, b) => a.number - b.number)
}

/** Pane folders from `herdr pane list`. */
export function parsePanes(stdout: string): Array<{ workspaceID: string; cwd: string }> {
  const out: Array<{ workspaceID: string; cwd: string }> = []
  for (const p of resultList(stdout, "panes")) {
    const workspaceID = text(p.workspace_id)
    const cwd = text(p.cwd)
    if (workspaceID && cwd?.startsWith("/")) out.push({ workspaceID, cwd })
  }
  return out
}

const AGENT_NAME_MAX = 48

/** Herdr agent name for a session: a slug of its title plus the end of its ID (unique enough, readable). */
export function agentName(title: string | undefined, sessionID: string): string {
  const suffix = sessionID.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "") || "new"
  const slug =
    (title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, AGENT_NAME_MAX - suffix.length - 1)
      .replace(/-+$/g, "") || "opencode"
  return `${slug}-${suffix}`
}

// ---------- polling ----------

export interface HerdrWatcherOptions {
  readonly run: HerdrRunner
  /** Called when the open sessions or the workspaces changed. */
  readonly onChange: () => void
  readonly agentsMs?: number
  readonly workspacesMs?: number
  readonly timeoutMs?: number
}

const normalizeDir = (directory: string) => path.posix.resolve(directory)

/** Polls Herdr for open OpenCode sessions (every 5 s) and workspaces with their pane folders (every 30 s). */
export class HerdrWatcher {
  private agents: HerdrAgent[] = []
  private spaces?: Array<{ id: string; label: string }>
  private panes: Array<{ workspaceID: string; cwd: string }> = []
  private key = ""
  private timers: Array<ReturnType<typeof setInterval>> = []
  private busy = { agents: false, workspaces: false }
  private running = false

  constructor(private readonly options: HerdrWatcherOptions) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.refresh()
    this.every(this.options.agentsMs ?? AGENTS_POLL_MS, () => void this.pollAgents())
    this.every(this.options.workspacesMs ?? WORKSPACES_POLL_MS, () => void this.pollWorkspaces())
  }

  stop(): void {
    this.running = false
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.agents = []
    this.spaces = undefined
    this.panes = []
    this.key = ""
  }

  /** Reads agents and workspaces now. */
  async refresh(): Promise<void> {
    await Promise.all([this.pollWorkspaces(false), this.pollAgents(false)])
    this.changed()
  }

  /** Sessions open in a Herdr pane → where. */
  open(): Map<string, TerminalInfo> {
    const labels = new Map((this.spaces ?? []).map((w) => [w.id, w.label]))
    const out = new Map<string, TerminalInfo>()
    for (const a of this.agents) {
      if (out.has(a.sessionID)) continue
      const label = labels.get(a.workspaceID)
      out.set(a.sessionID, {
        source: "herdr",
        workspaceID: a.workspaceID,
        ...(label !== undefined ? { workspace: label } : {}),
        ...(a.title ? { title: a.title } : {}),
        status: a.status,
      })
    }
    return out
  }

  /** Herdr workspaces with their pane folders, most used first; undefined without Herdr. */
  workspaces(): HerdrWorkspace[] | undefined {
    if (!this.spaces) return undefined
    const folders = [...this.panes, ...this.agents.flatMap((a) => (a.cwd ? [{ workspaceID: a.workspaceID, cwd: a.cwd }] : []))]
    return this.spaces.map((w) => {
      const counts = new Map<string, number>()
      for (const f of folders) if (f.workspaceID === w.id) counts.set(normalizeDir(f.cwd), (counts.get(normalizeDir(f.cwd)) ?? 0) + 1)
      const directories = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([dir]) => dir)
      return { id: w.id, label: w.label, directories }
    })
  }

  /** True when a Herdr pane (or OpenCode agent) is in the directory. */
  hasDirectory(directory: string): boolean {
    if (!directory.startsWith("/")) return false
    const target = normalizeDir(directory)
    return (this.workspaces() ?? []).some((w) => w.directories.includes(target))
  }

  hasWorkspace(id: string): boolean {
    return (this.spaces ?? []).some((w) => w.id === id)
  }

  private async pollAgents(notify = true): Promise<void> {
    if (this.busy.agents) return
    this.busy.agents = true
    try {
      this.agents = parseAgents(await this.options.run(["agent", "list"], this.timeout()))
    } catch {
      this.agents = []
    } finally {
      this.busy.agents = false
    }
    if (notify) this.changed()
  }

  private async pollWorkspaces(notify = true): Promise<void> {
    if (this.busy.workspaces) return
    this.busy.workspaces = true
    try {
      const [spaces, panes] = await Promise.all([
        this.options.run(["workspace", "list"], this.timeout()).then(parseWorkspaces),
        this.options.run(["pane", "list"], this.timeout()).then(parsePanes, () => []),
      ])
      this.spaces = spaces.map(({ id, label }) => ({ id, label }))
      this.panes = panes
    } catch {
      this.spaces = undefined
      this.panes = []
    } finally {
      this.busy.workspaces = false
    }
    if (notify) this.changed()
  }

  private timeout(): number {
    return this.options.timeoutMs ?? HERDR_TIMEOUT_MS
  }

  private changed(): void {
    const key = JSON.stringify([[...this.open()], this.workspaces() ?? null])
    if (key === this.key) return
    this.key = key
    try {
      this.options.onChange()
    } catch (cause) {
      console.error("[opencode-voice] herdr change handler failed", cause)
    }
  }

  private every(ms: number, run: () => void): void {
    const timer = setInterval(run, ms)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.push(timer)
  }
}

// ---------- opening a session ----------

export interface OpenInHerdrInput {
  readonly workspaceID: string
  readonly directory: string
  readonly sessionID: string
  readonly title?: string
}

/**
 * Opens a session in a new tab of a Herdr workspace: `herdr tab create --workspace <id> --cwd <dir>`, then
 * `herdr agent start <name> --kind opencode --pane <root pane> -- --session <id>` in its root pane.
 */
export async function openInHerdr(run: HerdrRunner, input: OpenInHerdrInput, options: { settleMs?: number } = {}): Promise<void> {
  const label = input.title?.trim() ? ["--label", input.title.trim().slice(0, 80)] : []
  const tab = await run(["tab", "create", "--workspace", input.workspaceID, "--cwd", input.directory, ...label, "--no-focus"], HERDR_TIMEOUT_MS * 2)
  const tabError = resultError(tab)
  if (tabError) throw new Error(`herdr tab create: ${tabError}`)
  let paneID: string | undefined
  try {
    const value = JSON.parse(tab)
    paneID = isObj(value) && isObj(value.result) && isObj(value.result.root_pane) ? text(value.result.root_pane.pane_id) : undefined
  } catch {
    // no pane
  }
  if (!paneID) throw new Error("herdr tab create returned no pane")
  // The new pane's shell needs a moment to reach its prompt.
  if ((options.settleMs ?? 500) > 0) await Bun.sleep(options.settleMs ?? 500)
  const started = await run(
    ["agent", "start", agentName(input.title, input.sessionID), "--kind", "opencode", "--pane", paneID, "--timeout", String(AGENT_START_TIMEOUT_MS), "--", "--session", input.sessionID],
    AGENT_START_TIMEOUT_MS + 5000,
  )
  const startError = resultError(started)
  if (startError) throw new Error(`herdr agent start: ${startError}`)
}
