// The spoke: one per OpenCode process. Watches the machine config, tracks this process's sessions,
// keeps the WebSocket to the central server, forwards exposed events, and executes the server's
// requests (voice turns, permission replies, context reads) through the plugin context.
import path from "node:path"
import { readConfig, setSession, withServer, writeConfig, type Mode, type VoiceConfig, explicitVariant, formatModelRef, parseModelRef, plainModelRef, type ModelRef } from "../config"
import { isLoopbackURL } from "../loopback"
import {
  compactActivity,
  FORWARDED_EVENTS,
  SEED_JOBS_MAX,
  type JobInfo,
  type HerdrWorkspace,
  type FormAnswer,
  type PermissionDecision,
  type ProcessKind,
  type PromptImage,
  type ResultFor,
  type ServerRequest,
  type SessionModelPrefs,
  type SpokeRequest,
  type TerminalInfo,
  type TurnResult,
} from "../protocol"
import { extractReply } from "../reply"
import { TurnTracker } from "../turns"
import { TimelineCache, boundedTimelinePart, newestPage, timelineFile, timelineItems } from "./timeline"
import { SpokeConnection, type Backoff, type ConnectionState } from "./client"
import { PROMPT_SOURCE, VOICE_AGENT } from "./conversation"
import { pollEnrollment, startEnrollment } from "./enroll"
import { HerdrWatcher, openInHerdr, type HerdrRunner } from "./herdr"
import type { LocalHubResult } from "./localhub"
import { PresenceBook } from "./presence"
import { changeStats, contextUsage, filePatch, mcpServers } from "./summary"
import { browserSessions, isExposed, isReported, SessionTracker, shouldForward, type EventLike, type SessionDetails } from "./tracker"
import { renderTaskBoard, TaskBoard } from "./taskboard"
import { watchConfig, type ConfigWatcher } from "./watch"

export type SpokeErrorName = "not_connected" | "not_enrolled" | "invalid" | "unreachable"

export class SpokeError extends Error {
  constructor(
    readonly name: SpokeErrorName,
    message: string,
  ) {
    super(message)
  }
}

/** The shared background service runs `opencode serve --service ...`; anything else is a standalone process. */
export function detectKind(argv: readonly string[]): ProcessKind {
  return argv.includes("--service") ? "service" : "standalone"
}

export interface HostSession {
  readonly id: string
  readonly title?: string
  readonly parentID?: string
  readonly location: { readonly directory: string }
  readonly time: { readonly updated: number }
  /** The session's selected agent; absent means the default agent. */
  readonly agent?: string
  /** The session's selected model; absent means the default model. */
  readonly model?: ModelRef
}

/** A prompt attachment as OpenCode's prompt input takes it; a `data:` URI is stored inline. */
export interface PromptFile {
  readonly uri: string
  readonly name?: string
}

/** Prompt images as OpenCode file attachments (base64 data URLs), or nothing without images. */
export function promptFiles(images: readonly PromptImage[] | undefined): { files?: PromptFile[] } {
  if (!images?.length) return {}
  return { files: images.map((image) => ({ uri: `data:${image.mime};base64,${image.data}`, ...(image.name ? { name: image.name } : {}) })) }
}

/** What the spoke needs from the plugin context (a fake in tests). */
export interface SpokeHost {
  readonly directory: string
  readonly opencodeVersion: string
  events(signal: AbortSignal): AsyncIterable<EventLike>
  prompt(input: { sessionID: string; text: string; files?: readonly PromptFile[]; metadata: Record<string, unknown>; delivery?: "steer" }): Promise<{ id: string }>
  context(sessionID: string): Promise<ReadonlyArray<unknown>>
  listModels?(): Promise<ReadonlyArray<unknown>>
  getSession(sessionID: string): Promise<HostSession>
  /**
   * Replies to a pending permission; "gone" when it is not pending here any more (answered, expired).
   * `directory` is the session's directory when known (permissions are pending per location).
   */
  replyPermission(input: { sessionID: string; requestID: string; decision: PermissionDecision; directory?: string }): Promise<unknown>
  /**
   * Answers or cancels a pending form through OpenCode's API: "gone" when it is not pending any more,
   * "unavailable" when this process cannot reach its own server (then a TUI relays it, see formActions).
   * Absent: always relayed.
   */
  replyForm?(input: FormAction): Promise<"replied" | "gone" | "unavailable">
  interrupt(sessionID: string): Promise<unknown>
  /** Changes a session's settings in OpenCode (session.update); only the title is used. */
  updateSession?(sessionID: string, input: { title?: string }): Promise<unknown>
  switchAgent(sessionID: string, agent: string): Promise<unknown>
  switchModel(sessionID: string, model: ModelRef): Promise<unknown>
  hasAgent(id: string): Promise<boolean>
  /** The agent a session without an explicit selection runs with. */
  defaultAgent(): Promise<string | undefined>
  /**
   * What runs right now, from this process's own OpenCode server: sessions with a run in progress
   * (session.active) and running shells in the given directories (shell.list). Used to show sessions that
   * were already running when this process started, or while its event stream was down.
   */
  activity?(directories: readonly string[]): Promise<{ readonly active: readonly string[]; readonly jobs: ReadonlyArray<JobInfo & { readonly sessionID: string }> }>
  /**
   * Recent root sessions from the local service with their workspace (service processes only): those in
   * the history window (`days`, at most `max`), plus `include` (always listed: open, running, ...).
   */
  listRecent?(options?: { days: number; max: number; include: readonly string[] }): Promise<Array<{ id: string } & SessionDetails>>
  /** Creates a session in a directory (service processes only). */
  createSession?(input: { directory: string; title?: string }): Promise<{ id: string }>
  /** MCP servers and their status for a directory (raw OpenCode McpServer list). */
  mcpList?(directory: string): Promise<ReadonlyArray<unknown>>
  /** Working-tree changes of a directory (raw OpenCode FileDiffInfo list). */
  vcsDiff?(directory: string): Promise<ReadonlyArray<unknown>>
  /** Current branch of a directory. */
  vcsBranch?(directory: string): Promise<string | undefined>
}

/** A form reply for OpenCode: an answer, or a cancel. */
export type FormAction =
  | { readonly sessionID: string; readonly formID: string; readonly answer: FormAnswer }
  | { readonly sessionID: string; readonly formID: string; readonly cancel: true }

/** A TUI that polled formActions within this window can relay form replies. */
const RELAY_WINDOW_MS = 30_000
/** How long a relayed form reply may take to show up as form.replied/cancelled. */
const RELAY_TIMEOUT_MS = 15_000
const ANSWER_IN_TERMINAL = "This OpenCode process cannot answer questions from the hub; answer it in the terminal"

export interface SpokeOptions {
  readonly configFile: string
  readonly machineName: string
  readonly kind: ProcessKind
  readonly processID: string
  readonly pid: number
  readonly pluginVersion: string
  readonly turnTimeoutMs?: number
  readonly snapshotDebounceMs?: number
  readonly snapshotIntervalMs?: number
  readonly seedIntervalMs?: number
  /** Delay before re-listing the service's sessions after a session event (default 2 s). */
  readonly seedDebounceMs?: number
  readonly pollMs?: number
  readonly backoff?: Backoff
  /**
   * Starts a local hub for a loopback server nothing answers on (ensureLocalHub). Without it the spoke
   * never starts one. Used when the connection fails (service process at once, standalone processes
   * after localHubDelayMs) and when enrolling (at once).
   */
  readonly localHub?: (server: string) => Promise<LocalHubResult>
  /** Grace period before a standalone process tries, so the service process goes first (default 8 s). */
  readonly localHubDelayMs?: number
  /** Minimum time between attempts; doubles after each failure up to 15 min (default 30 s). */
  readonly localHubRetryMs?: number
  /**
   * Runs the `herdr` CLI. Only the service process reads Herdr (one reader per machine; standalone
   * processes never do), and only while the machine config's `herdr` is on.
   */
  readonly herdr?: HerdrRunner
  /** Herdr poll intervals (default 5 s agents, 30 s workspaces). */
  readonly herdrPollMs?: { readonly agents?: number; readonly workspaces?: number }
  /** Pause between creating a Herdr tab and starting OpenCode in it (default 500 ms). */
  readonly herdrSettleMs?: number
  /** How often expired TUI presence is checked (default 5 s). */
  readonly presenceCheckMs?: number
}

export type EnrollmentState = "pending" | "approved" | "denied" | "expired" | "error"

export interface SpokeStatus {
  readonly server: string
  readonly mode: Mode
  readonly enrolled: boolean
  readonly connection: ConnectionState
  readonly lastError?: string
  readonly sessionExposed?: boolean
  /** Conversation mode is on for the session in this process. */
  readonly conversation?: boolean
  readonly enrollment?: EnrollmentState
  readonly machineName: string
  readonly kind: ProcessKind
  /** Why the local hub could not be started (auto-start), until the connection succeeds. */
  readonly localHub?: string
}

export interface EnrollResult {
  readonly userCode: string
  readonly approveURL: string
  /** The local hub approved this machine without confirmation (first machine). */
  readonly autoApproved?: boolean
  /** A local hub was started (or found starting) for this enrollment. */
  readonly localHub?: "started" | "running" | "busy"
}

const MODES: readonly Mode[] = ["off", "always", "session"]
const INFO_RETRY_MS = 60_000
const CONTEXT_LIMIT = 20

type Message = { id?: string; type?: string; text?: unknown; content?: ReadonlyArray<{ type?: string; text?: unknown }> | null }

function contextMessages(messages: ReadonlyArray<unknown>): ResultFor["context"]["messages"] {
  const out: Array<{ role: "user" | "assistant"; text: string }> = []
  for (const raw of messages) {
    const m = raw as Message
    if (m?.type === "user" && typeof m.text === "string" && m.text.trim()) out.push({ role: "user", text: m.text.trim() })
    if (m?.type === "assistant") {
      const text = (m.content ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("")
        .trim()
      if (text) out.push({ role: "assistant", text })
    }
  }
  return out.slice(-CONTEXT_LIMIT)
}

const FALLBACK_AGENT = "build"
const LOCAL_HUB_MAX_RETRY_MS = 15 * 60_000
const ENROLL_RETRY_MS = 500
const NOT_SHARED = "This session is not shared with voice"
/** Longest session title the hub sets (OpenCode's own titles are shorter). */
export const MAX_TITLE_CHARS = 200
const UNKNOWN_SESSION = "Unknown session"
/** Events after which the service re-lists its sessions (other processes' sessions appear, change, go). */
const LISTING_EVENTS = new Set(["session.created", "session.renamed", "session.deleted"])

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export class Spoke {
  private config: VoiceConfig
  private watcher?: ConfigWatcher
  private connection?: SpokeConnection
  private connectionKey = ""
  private readonly tracker = new SessionTracker()
  /** The background workers each session started (the voice agent's task board). */
  private readonly tasks = new TaskBoard()
  private readonly turns = new TurnTracker()
  /** Timeline rows of sessions being paged through (30 s, dropped on any event of the session). */
  private readonly timelines = new TimelineCache()
  private readonly voiceTurns = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly infoTried = new Map<string, number>()
  /** Sessions in conversation mode → the agent to restore when it ends (undefined: the default agent). */
  private readonly conversations = new Map<string, { previous?: string; previousModel?: ModelRef; voiceModel?: ModelRef }>()
  /** Per-session selections supplied by the hub; the hub persists them per user. */
  private readonly modelPrefs = new Map<string, SessionModelPrefs>()
  /** Per session with a Voice override applied: the model to restore when it is cleared, and the override. */
  private readonly voiceOverrides = new Map<string, { readonly previous?: ModelRef; readonly applied: ModelRef }>()
  /**
   * Session → its current model as last seen (getSession, our switchModel, OpenCode's session.model.selected),
   * so an utterance needs no getSession round trip. Cleared when the event stream restarts (events may be lost).
   */
  private readonly sessionModels = new Map<string, { readonly model?: ModelRef }>()
  private conversationChain: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  private snapshotTimer?: ReturnType<typeof setTimeout>
  private seedTimer?: ReturnType<typeof setTimeout>
  private intervals: Array<ReturnType<typeof setInterval>> = []
  private enrollment?: { state: EnrollmentState; abort: AbortController }
  private started = false
  /** A seedActivity call is in flight. */
  private seeding = false
  /** Sessions shown by OpenCode TUIs (voice.presence). */
  private readonly presenceBook = new PresenceBook()
  /** Form replies waiting for a TUI to carry them out (when the plugin cannot reach its own server). */
  private readonly relay = {
    actions: [] as FormAction[],
    polls: new Set<() => void>(),
    lastPoll: -Infinity,
    /** formID → resolves when OpenCode reports the form replied or cancelled. */
    settled: new Map<string, () => void>(),
  }
  /** Herdr reader (service process only, while config.herdr is on). */
  private herdr?: HerdrWatcher
  /** Open sessions as last reported, to notice changes. */
  private openKey = ""
  /** The last terminals frame sent on the current connection. */
  private terminalsKey = ""
  /** Local hub auto-start: one attempt at a time, spaced by a cooldown. */
  private readonly hub: {
    pending: boolean
    timer?: ReturnType<typeof setTimeout>
    nextAt: number
    cooldown: number
    message?: string
    /** A hub was just started while a connection attempt was in flight: retry as soon as that attempt fails. */
    retryOnError?: boolean
  }

  constructor(
    private readonly host: SpokeHost,
    private readonly options: SpokeOptions,
  ) {
    this.config = readConfig(options.configFile, options.machineName)
    this.hub = { pending: false, nextAt: 0, cooldown: options.localHubRetryMs ?? 30_000 }
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      this.watcher = watchConfig(this.options.configFile, this.options.machineName, (c) => this.apply(c), { pollMs: this.options.pollMs })
      this.config = this.watcher.current()
    } catch (cause) {
      console.error("[hub] config watch failed", cause)
    }
    void this.listen()
    this.apply(this.config)
    this.every(this.options.snapshotIntervalMs ?? 30_000, () => this.sendSnapshot())
    this.every(this.options.presenceCheckMs ?? 5000, () => this.checkOpen())
    if (this.options.kind === "service" && this.host.listRecent) {
      void this.seed()
      this.every(this.options.seedIntervalMs ?? 60_000, () => void this.seed())
    }
  }

  stop(): void {
    this.started = false
    this.abort.abort()
    this.watcher?.stop()
    this.enrollment?.abort.abort()
    clearTimeout(this.hub.timer)
    this.hub.pending = false
    for (const interval of this.intervals) clearInterval(interval)
    this.intervals = []
    clearTimeout(this.snapshotTimer)
    clearTimeout(this.seedTimer)
    this.seedTimer = undefined
    this.herdr?.stop()
    this.herdr = undefined
    this.connection?.stop()
    this.connection = undefined
    this.connectionKey = ""
  }

  isVoiceTurn(sessionID: string): boolean {
    return (this.voiceTurns.get(sessionID) ?? 0) > 0
  }

  inConversation(sessionID: string): boolean {
    return this.conversations.has(sessionID)
  }

  /** The agent the voice orchestrator delegates to (per-machine config). */
  /** The model subagents should work on for a session in conversation mode, as "provider/model[#variant]". */
  workModelFor(sessionID: string): string | undefined {
    const selected = this.modelPrefs.get(sessionID)?.worker
    if (selected) return formatModelRef({ providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) })
    const entry = this.conversations.get(sessionID)
    if (!entry?.voiceModel) return undefined
    return this.config.workModel ?? (entry.previousModel ? formatModelRef(entry.previousModel) : undefined)
  }

  /** The rendered task board of a session's workers (for the voice agent's context); undefined without any. */
  taskBoard(sessionID: string): string | undefined {
    return renderTaskBoard(this.tasks.children(sessionID), Date.now())
  }

  /**
   * hub_task_stop: interrupts one of `callerID`'s workers (a session below it), or all its running workers, and
   * whatever runs below them, deepest first. Never the caller itself, nor a session outside its tree.
   */
  async stopWorkers(callerID: string, input: { sessionID?: unknown; all?: unknown }): Promise<{ stopped: string[]; text: string }> {
    let targets: string[]
    if (input.all === true) {
      targets = this.tasks
        .children(callerID)
        .filter((t) => t.state === "working" || t.state === "blocked")
        .map((t) => t.id)
      if (!targets.length) return { stopped: [], text: "None of your workers is running." }
    } else if (typeof input.sessionID === "string" && input.sessionID) {
      const id = input.sessionID
      if (id === callerID || !this.tracker.lineage(id).slice(1).includes(callerID)) {
        return { stopped: [], text: `${id} is not one of your workers; use a sessionID from your task board.` }
      }
      targets = [id]
    } else return { stopped: [], text: "Pass the worker's sessionID from your task board, or all: true for every worker." }
    const stopped: string[] = []
    for (const target of targets) {
      for (const id of [...this.tracker.runningBelow(target), target]) {
        if (id === callerID) continue
        try {
          await this.host.interrupt(id)
          stopped.push(id)
        } catch {
          // already settled
        }
      }
    }
    const names = targets.map((id) => `"${this.tasks.get(id)?.title ?? id}"`)
    return { stopped, text: `Stopped ${names.join(", ")}.` }
  }

  subagent(): string {
    return this.config.subagent
  }

  /**
   * TUI presence (RPC voice.presence): the sessions a TUI shows right now (its route and open tabs).
   * `reporter` identifies the TUI; its report replaces its previous one.
   */
  presence(sessionIDs: readonly string[], reporter?: string): void {
    this.presenceBook.report(sessionIDs, Date.now(), reporter)
    this.checkOpen()
  }

  /** Where a session is open right now: a Herdr pane wins over a TUI. */
  private terminal(sessionID: string, tui = this.presenceBook.open(Date.now())): TerminalInfo | undefined {
    return this.herdr?.open().get(sessionID) ?? (tui.has(sessionID) ? { source: "tui" } : undefined)
  }

  /** Open sessions → where. */
  private openSessions(): Map<string, TerminalInfo> {
    const out = new Map(this.herdr?.open() ?? [])
    for (const id of this.presenceBook.open(Date.now())) if (!out.has(id)) out.set(id, { source: "tui" })
    return out
  }

  /** Re-reports sessions when what is open changed; brings in open sessions this process does not know yet. */
  private checkOpen(): void {
    const open = this.openSessions()
    const key = JSON.stringify([...open])
    if (key === this.openKey) return
    this.openKey = key
    const unknown = [...open.keys()].filter((id) => !this.tracker.has(id))
    if (unknown.length && this.options.kind === "service" && this.host.listRecent) this.scheduleSeed()
    else if (unknown.length) {
      for (const id of unknown) this.tracker.ensure(id, Date.now())
      void this.fetchInfo()
    }
    this.scheduleSnapshot()
  }

  /** Sessions the listing must keep regardless of its window. */
  private keep(): Set<string> {
    return new Set([
      ...this.openSessions().keys(),
      ...this.tracker.active(),
      ...this.conversations.keys(),
      ...(this.config.mode === "session" ? this.config.sessions : []),
    ])
  }

  /** Starts or stops the Herdr reader to match the config (service process with a runner only). */
  private applyHerdr(config: VoiceConfig): void {
    const run = this.options.herdr
    const wanted = this.started && this.options.kind === "service" && run !== undefined && config.herdr
    if (wanted && !this.herdr) {
      this.herdr = new HerdrWatcher({
        run: run!,
        agentsMs: this.options.herdrPollMs?.agents,
        workspacesMs: this.options.herdrPollMs?.workspaces,
        onChange: () => {
          this.checkOpen()
          this.sendTerminals()
        },
      })
      this.herdr.start()
    } else if (!wanted && this.herdr) {
      this.herdr.stop()
      this.herdr = undefined
      this.checkOpen()
      this.sendTerminals()
    }
  }

  /** The machine's terminal context (service process only); unchanged frames are not re-sent. */
  private sendTerminals(force = false): void {
    if (this.options.kind !== "service" || !this.options.herdr) return
    const workspaces = this.herdr?.workspaces()
    const frame = { t: "terminals" as const, ...(workspaces ? { herdr: { workspaces: limitWorkspaces(workspaces) } } : {}) }
    const key = JSON.stringify(frame)
    if (!force && key === this.terminalsKey) return
    if (this.connection?.state !== "connected") return
    this.terminalsKey = key
    this.connection.send(frame)
  }

  /**
   * Turns conversation mode on or off for a session in this process. On: switch to the "voice"
   * agent (remembering the previous one) or, without that agent, let the context hook add the
   * orchestrator prompt. Off: restore the previous agent unless the user picked another meanwhile.
   * Calls are serialized so a re-sent "on" cannot race an "off".
   */
  setConversation(sessionID: string, on: boolean): Promise<ResultFor["conversation"]> {
    if (!isExposed(this.config, this.tracker, sessionID)) return Promise.reject(new SpokeError("invalid", NOT_SHARED))
    const run = () => (on ? this.conversationOn(sessionID) : this.conversationOff(sessionID))
    const result = this.conversationChain.then(run, run)
    this.conversationChain = result.catch(() => undefined)
    return result
  }

  // ---------- RPC-facing API ----------

  /**
   * RPC hub.formActions (TUI): form replies to carry out through the TUI's client, waiting up to `waitMs`
   * for one. While a TUI polls, the spoke relays form replies it cannot make itself.
   */
  formActions(waitMs: number): Promise<{ actions: FormAction[] }> {
    this.relay.lastPoll = Date.now()
    const take = () => ({ actions: this.relay.actions.splice(0) })
    if (this.relay.actions.length || waitMs <= 0) return Promise.resolve(take())
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.relay.polls.delete(done)
        this.relay.lastPoll = Date.now()
        resolve(take())
      }
      const timer = setTimeout(done, waitMs)
      this.relay.polls.add(done)
    })
  }

  status(sessionID?: string): SpokeStatus {
    const connection = this.connection?.state ?? "off"
    const lastError = this.connection?.lastError
    return {
      server: this.config.server,
      mode: this.config.mode,
      enrolled: Boolean(this.config.token),
      connection,
      ...(lastError && connection !== "connected" ? { lastError } : {}),
      ...(sessionID ? { sessionExposed: isExposed(this.config, this.tracker, sessionID), conversation: this.inConversation(sessionID) } : {}),
      ...(this.enrollment ? { enrollment: this.enrollment.state } : {}),
      machineName: this.config.machineName,
      kind: this.options.kind,
      ...(this.hub.message && connection !== "connected" ? { localHub: this.hub.message } : {}),
    }
  }

  setServer(server: string): void {
    const trimmed = server.trim().replace(/\/+$/, "")
    if (!/^https?:\/\/[^\s/]+[^\s]*$/.test(trimmed)) throw new SpokeError("invalid", "Server must be an http(s) URL")
    this.write(withServer(this.current(), trimmed))
  }

  setMode(mode: Mode): void {
    if (!MODES.includes(mode)) throw new SpokeError("invalid", `Mode must be one of ${MODES.join(", ")}`)
    this.write({ ...this.current(), mode })
  }

  setSession(sessionID: string, on: boolean): void {
    if (!sessionID.startsWith("ses")) throw new SpokeError("invalid", "Not a session ID")
    this.write(setSession(this.current(), sessionID, on))
  }

  /** Starts device enrollment; polling continues in the background and stores the token on approval. */
  async enroll(): Promise<EnrollResult> {
    const { server, machineName, autoStartLocalHub } = this.current()
    this.enrollment?.abort.abort()
    const abort = new AbortController()
    const unreachable = (cause: unknown) => new SpokeError("unreachable", `Could not reach ${server}: ${errorText(cause)}`)
    let start
    let localHub: EnrollResult["localHub"]
    try {
      start = await startEnrollment(server, machineName, { signal: abort.signal })
    } catch (cause) {
      // Nothing answers on a local server: start the hub (user-initiated, so any process may), then retry.
      const starter = this.options.localHub
      if (!starter || !autoStartLocalHub || !isLoopbackURL(server)) throw unreachable(cause)
      const result = await starter(server)
      if (result.status === "failed") throw new SpokeError("unreachable", `Could not start a local hub for ${server}: ${result.error}`)
      if (result.status === "skipped") throw unreachable(cause)
      localHub = result.status
      start = await this.retryEnrollment(server, machineName, abort.signal, result.status === "busy" ? 30 : 4).catch((again) => {
        throw unreachable(again)
      })
    }
    const enrollment = { state: "pending" as EnrollmentState, abort }
    this.enrollment = enrollment
    void pollEnrollment(server, start, { signal: abort.signal })
      .then((outcome) => {
        if (this.enrollment !== enrollment || outcome.status === "cancelled") return
        if (outcome.status !== "approved") {
          enrollment.state = outcome.status
          return
        }
        const latest = this.current()
        if (latest.server !== server) return
        this.write({ ...latest, token: outcome.machineToken, machineID: outcome.machineID })
        enrollment.state = "approved"
      })
      .catch((cause) => {
        enrollment.state = "error"
        console.error("[hub] enrollment failed", cause)
      })
    return {
      userCode: start.userCode,
      approveURL: start.approveURL,
      ...(start.autoApproved === true ? { autoApproved: true } : {}),
      ...(localHub ? { localHub } : {}),
    }
  }

  private async retryEnrollment(server: string, machineName: string, signal: AbortSignal, attempts: number) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await startEnrollment(server, machineName, { signal })
      } catch (cause) {
        if (attempt >= attempts || signal.aborted) throw cause
        await new Promise((resolve) => setTimeout(resolve, ENROLL_RETRY_MS))
      }
    }
  }

  pairCode(): Promise<ResultFor["pairCode"]> {
    return this.ask({ op: "pairCode" })
  }

  handoff(sessionID: string): Promise<ResultFor["handoff"]> {
    return this.ask({ op: "handoff", sessionID })
  }

  /** A one-time sign-in link to the session's page, or to the home page without a session. */
  openLink(sessionID?: string, voice = false): Promise<ResultFor["openLink"]> {
    return this.ask(sessionID ? { op: "openLink", sessionID, ...(voice ? { voice: true } : {}) } : { op: "openLink" })
  }

  /**
   * Starts the local hub for the configured loopback server now (the user asked: "Open hub"), even
   * with autoStartLocalHub off, and reconnects at once when it answers.
   */
  async startLocalHub(): Promise<{ status: "started" | "running" | "busy" }> {
    const { server } = this.current()
    const starter = this.options.localHub
    if (!isLoopbackURL(server)) throw new SpokeError("invalid", `${server} is not a local hub`)
    if (!starter) throw new SpokeError("invalid", "This OpenCode process cannot start a local hub")
    let result: LocalHubResult
    try {
      result = await starter(server)
    } catch (cause) {
      result = { status: "failed", error: errorText(cause) }
    }
    if (result.status === "failed") {
      this.hub.message = result.error
      throw new SpokeError("unreachable", `Could not start a local hub for ${server}: ${result.error}`)
    }
    if (result.status === "skipped") throw new SpokeError("invalid", `Cannot start a local hub for ${server}: ${result.reason}`)
    this.hub.message = undefined
    const connection = this.connection
    if (connection && connection.state !== "connected" && (result.status === "started" || result.status === "running")) {
      this.hub.retryOnError = true // retryNow() is a no-op while an attempt is in flight
      connection.retryNow()
    }
    return { status: result.status }
  }

  // ---------- internals ----------

  private async ask<R extends SpokeRequest>(req: R): Promise<ResultFor[R["op"]]> {
    const connection = this.connection
    if (!connection || connection.state !== "connected") {
      const hint = !this.config.token
        ? "This machine is not connected to a hub yet"
        : this.config.mode === "off"
          ? "Voice is off for this machine"
          : `Not connected to ${this.config.server}`
      throw new SpokeError("not_connected", hint)
    }
    return connection.request(req)
  }

  private current(): VoiceConfig {
    return this.watcher?.refresh() ?? readConfig(this.options.configFile, this.options.machineName)
  }

  private write(config: VoiceConfig): void {
    writeConfig(this.options.configFile, config)
    if (this.watcher) this.watcher.refresh()
    else this.apply(readConfig(this.options.configFile, this.options.machineName))
  }

  private apply(config: VoiceConfig): void {
    const previous = this.config
    this.config = config
    if (!this.started) return
    const active = config.mode !== "off" && Boolean(config.token)
    const key = active ? JSON.stringify([config.server, config.token, config.mode]) : ""
    if (key !== this.connectionKey) {
      this.connection?.stop()
      this.connection = undefined
      this.connectionKey = key
      if (active) this.connect(config)
    }
    if (previous.sessions.join() !== config.sessions.join()) this.scheduleSnapshot()
    this.applyHerdr(config)
    if (previous.list.days !== config.list.days || previous.list.max !== config.list.max) this.scheduleSeed()
  }

  private connect(config: VoiceConfig): void {
    const connection = new SpokeConnection({
      server: config.server,
      token: config.token!,
      backoff: this.options.backoff,
      hello: () => ({
        processID: this.options.processID,
        kind: this.options.kind,
        directory: this.host.directory,
        pid: this.options.pid,
        mode: this.config.mode === "session" ? "session" : "always",
        opencodeVersion: this.host.opencodeVersion,
        pluginVersion: this.options.pluginVersion,
      }),
      handle: (req) => this.handle(req),
      onWelcome: () => {
        this.sendSnapshot()
        this.sendTerminals(true)
        void this.seedActivity()
      },
      onState: (state, error) => {
        if (state === "revoked") console.error("[hub] this machine was revoked by the hub")
        else if (state === "error" && error) console.error(`[hub] ${error}; retrying`)
        if (state === "error" && this.hub.retryOnError) {
          this.hub.retryOnError = false
          setTimeout(() => this.connection?.retryNow(), 0)
        } else if (state === "error") this.maybeStartLocalHub(config.server)
        if (state === "connected") {
          this.hub.message = undefined
          this.hub.retryOnError = false
          this.hub.cooldown = this.options.localHubRetryMs ?? 30_000
        }
      },
    })
    this.connection = connection
    connection.start()
  }

  /** After a failed connection to a loopback server: maybe start the local hub (see SpokeOptions.localHub). */
  private maybeStartLocalHub(server: string): void {
    const starter = this.options.localHub
    if (!starter || !this.config.autoStartLocalHub || !isLoopbackURL(server)) return
    if (this.hub.pending || Date.now() < this.hub.nextAt) return
    this.hub.pending = true
    const delay = this.options.kind === "service" ? 0 : (this.options.localHubDelayMs ?? 8000)
    this.hub.timer = setTimeout(() => void this.autoStartHub(server, starter), delay)
  }

  private async autoStartHub(server: string, starter: (server: string) => Promise<LocalHubResult>): Promise<void> {
    try {
      const connection = this.connection
      if (!this.started || !connection || connection.state === "connected" || this.config.server !== server) return
      let result: LocalHubResult
      try {
        result = await starter(server)
      } catch (cause) {
        result = { status: "failed", error: errorText(cause) }
      }
      // Whatever happened, the next attempt waits for the cooldown, so a hub that answers but refuses
      // this machine (or keeps crashing) is not restarted in a loop. The connection stays in its error
      // state meanwhile (no new state change), so check again once the cooldown is over.
      const wait = this.hub.cooldown
      this.hub.nextAt = Date.now() + wait
      this.hub.timer = setTimeout(() => {
        // The cooldown is over when this fires. Timers can fire slightly before Date.now() reaches
        // nextAt (seen on Linux); re-checking the clock would drop the retry for good, because the
        // connection reports no new state change while it stays in error.
        this.hub.nextAt = 0
        if (this.connection && this.connection.state !== "connected") this.maybeStartLocalHub(server)
      }, wait)
      ;(this.hub.timer as { unref?: () => void }).unref?.()
      if (result.status === "failed") {
        this.hub.message = result.error
        this.hub.cooldown = Math.min(this.hub.cooldown * 2, LOCAL_HUB_MAX_RETRY_MS)
        console.error(`[hub] could not start a local hub for ${server}: ${result.error}`)
        return
      }
      this.hub.message = undefined
      if (result.status === "started") console.log(`[hub] started a local hub for ${server} (pid ${result.pid})`)
      if (result.status === "started" || result.status === "running") this.connection?.retryNow()
    } finally {
      this.hub.pending = false
    }
  }

  private async conversationOn(sessionID: string): Promise<ResultFor["conversation"]> {
    const entry = this.conversations.get(sessionID)
    const session = await this.host.getSession(sessionID)
    this.rememberModel(sessionID, session.model)
    const current = session.agent
    const models = await this.voiceModelOn(sessionID, session, entry)
    if (!(await this.host.hasAgent(VOICE_AGENT))) {
      this.conversations.set(sessionID, { ...entry, ...models })
      return { agent: current ?? (await this.defaultAgent()) }
    }
    const previous = entry ? entry.previous : current === VOICE_AGENT ? undefined : current
    this.conversations.set(sessionID, { ...(previous ? { previous } : {}), ...models })
    if (current !== VOICE_AGENT) await this.host.switchAgent(sessionID, VOICE_AGENT)
    return { agent: VOICE_AGENT }
  }

  /** Switches to the configured fast model, remembering the session's model for subagent work and for restoring. */
  private async voiceModelOn(
    sessionID: string,
    session: HostSession,
    entry: { previousModel?: ModelRef; voiceModel?: ModelRef } | undefined,
  ): Promise<{ previousModel?: ModelRef; voiceModel?: ModelRef }> {
    const selected = this.modelPrefs.get(sessionID)?.voice
    const voiceModel = selected
      ? { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) }
      : this.config.voiceModel
        ? parseModelRef(this.config.voiceModel)
        : undefined
    if (!voiceModel) return {}
    const current = session.model
    const onVoice = current !== undefined && sameModel(current, voiceModel)
    const previousModel = entry?.voiceModel ? entry.previousModel : onVoice || !current ? undefined : plainModelRef(current)
    if (!onVoice) await this.switchModel(sessionID, voiceModel)
    return { voiceModel, ...(previousModel ? { previousModel } : {}) }
  }

  private async conversationOff(sessionID: string): Promise<ResultFor["conversation"]> {
    const entry = this.conversations.get(sessionID)
    this.conversations.delete(sessionID)
    const session = await this.host.getSession(sessionID)
    this.rememberModel(sessionID, session.model)
    // Restore the model only if the session is still on the voice model (the user may have picked another).
    if (entry?.voiceModel && entry.previousModel && session.model && sameModel(session.model, entry.voiceModel)) {
      await this.switchModel(sessionID, entry.previousModel)
    }
    const current = session.agent
    if (current !== VOICE_AGENT) return { agent: current ?? (await this.defaultAgent()) }
    let target = entry?.previous ?? (await this.defaultAgent())
    if (target === VOICE_AGENT) target = FALLBACK_AGENT
    await this.host.switchAgent(sessionID, target)
    return { agent: target }
  }

  private async defaultAgent(): Promise<string> {
    try {
      return (await this.host.defaultAgent()) ?? FALLBACK_AGENT
    } catch {
      return FALLBACK_AGENT
    }
  }

  private async handle(req: ServerRequest): Promise<unknown> {
    // Session browser ops are not gated by exposure: they are how a session gets exposed.
    if (req.op === "expose") return this.expose(req.sessionID, req.on)
    if (req.op === "create") return this.create(req.directory, req.title, req.herdrWorkspace)
    // Inspection and control need a session this process knows; Voice (conversation) is gated separately.
    if (!isReported(this.config, this.tracker, req.sessionID) && !(await this.adopt(req.sessionID))) throw new Error(UNKNOWN_SESSION)
    switch (req.op) {
      case "turn":
        return this.turn(req.sessionID, req.text, req.voiceStyle, req.images)
      case "permission": {
        const directory = this.tracker.directoryOf(req.sessionID)
        const outcome = await this.host.replyPermission({ sessionID: req.sessionID, requestID: req.requestID, decision: req.decision, ...(directory ? { directory } : {}) })
        return outcome === "gone" ? { gone: true } : {}
      }
      case "form":
        return this.form("cancel" in req ? { sessionID: req.sessionID, formID: req.formID, cancel: true } : { sessionID: req.sessionID, formID: req.formID, answer: req.answer })
      case "context":
        return { messages: contextMessages(await this.host.context(req.sessionID)) }
      case "models": {
        const raw = await this.host.listModels?.() ?? []
        return {
          models: raw.flatMap((value: any) => {
            // `id` is OpenCode's catalog key (what switchModel takes); `modelID` is the id sent upstream, which
            // differs for aliased models (a gateway's "claude-opus-5-5" → "claude/claude-opus-5-5").
            const id = typeof value?.id === "string" && value.id ? value.id : value?.modelID
            if (!value || typeof value.providerID !== "string" || typeof id !== "string") return []
            return [{
              providerID: value.providerID,
              modelID: id,
              name: typeof value.name === "string" ? value.name : id,
              enabled: value.enabled !== false,
              status: typeof value.status === "string" ? value.status : "active",
              variants: Array.isArray(value.variants) ? value.variants.flatMap((v: any) => typeof v?.id === "string" ? [v.id] : []) : [],
            }]
          }),
        } satisfies ResultFor["models"]
      }
      case "modelPrefs":
        return this.modelPrefsResult(req.sessionID)
      case "setModelPrefs": {
        const next: { voice?: any; worker?: any } = { ...this.modelPrefs.get(req.sessionID) }
        for (const key of ["voice", "worker"] as const) {
          if (!(key in req)) continue
          if (req[key] === null) delete next[key]
          else if (req[key] !== undefined) next[key] = req[key]
        }
        if (next.voice || next.worker) this.modelPrefs.set(req.sessionID, next)
        else this.modelPrefs.delete(req.sessionID)
        if (!next.voice && this.voiceOverrides.has(req.sessionID)) await this.applyVoiceModel(req.sessionID)
        return this.modelPrefsResult(req.sessionID)
      }
      case "timeline": {
        // A first page reads OpenCode (it shows the newest state); following pages reuse those rows briefly.
        const first = req.cursor === undefined && req.before === undefined
        const items = await this.timelines.get(req.sessionID, async () => timelineItems(req.sessionID, await this.host.context(req.sessionID)), first)
        if (req.before !== undefined || req.order === "desc") return newestPage(items, req.limit ?? 50, req.before) satisfies ResultFor["timeline"]
        const offset = req.cursor === undefined ? 0 : Number(req.cursor)
        if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid timeline cursor")
        const page = items.slice(offset, offset + (req.limit ?? 50))
        const next = offset + page.length
        return { items: page, ...(next < items.length ? { cursor: String(next) } : {}) }
      }
      case "timelinePart":
        return { detail: boundedTimelinePart(await this.host.context(req.sessionID), req.messageID, req.partID) }
      case "timelineFile":
        return timelineFile(await this.host.context(req.sessionID), req.messageID, req.index) satisfies ResultFor["timelineFile"]
      case "steer": {
        const voice = isExposed(this.config, this.tracker, req.sessionID)
        if (voice) await this.applyVoiceModel(req.sessionID)
        const inbox = await this.host.prompt({
          sessionID: req.sessionID,
          text: req.text,
          ...promptFiles(req.images),
          delivery: "steer",
          metadata: { source: PROMPT_SOURCE, mode: voice ? "conversation" : "remote" },
        })
        return { inboxID: inbox.id } satisfies ResultFor["steer"]
      }
      case "interrupt":
        await this.host.interrupt(req.sessionID)
        return {}
      case "rename":
        return this.rename(req.sessionID, req.title)
      case "stop":
        return this.stopTree(req.sessionID)
      case "summary":
        return this.summary(req.sessionID)
      case "diff": {
        const diffs = await this.host.vcsDiff?.(this.directoryOf(req.sessionID))
        const patch = diffs && filePatch(diffs, req.file)
        return patch ? { patch } : {}
      }
      case "conversation":
        return this.setConversation(req.sessionID, req.on)
    }
  }

  /**
   * Renames a session in OpenCode and reports the new title at once (the snapshot goes out before the reply,
   * on the same socket), without waiting for OpenCode's session.renamed event.
   */
  private async rename(sessionID: string, raw: string): Promise<ResultFor["rename"]> {
    const title = raw.trim()
    if (!title) throw new Error("Title is empty")
    if (title.length > MAX_TITLE_CHARS) throw new Error(`Title is longer than ${MAX_TITLE_CHARS} characters`)
    if (!this.host.updateSession) throw new Error("This OpenCode process cannot rename sessions")
    await this.host.updateSession(sessionID, { title })
    if (this.tracker.observe({ type: "session.renamed", data: { sessionID, title } }, Date.now())) this.sendSnapshot()
    return { title }
  }

  /** Answers a pending form through OpenCode, or through a polling TUI when this process cannot. */
  private async form(action: FormAction): Promise<ResultFor["form"]> {
    if (!this.tracker.formPending(action.formID)) return { gone: true }
    const outcome = this.host.replyForm ? await this.host.replyForm(action) : "unavailable"
    if (outcome === "gone") return { gone: true }
    if (outcome !== "unavailable") return {}
    const relaying = this.relay.polls.size > 0 || Date.now() - this.relay.lastPoll <= RELAY_WINDOW_MS
    if (!relaying) throw new Error(ANSWER_IN_TERMINAL)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relay.settled.delete(action.formID)
        reject(new Error(`No terminal took the answer in time. ${ANSWER_IN_TERMINAL}`))
      }, RELAY_TIMEOUT_MS)
      this.relay.settled.set(action.formID, () => {
        clearTimeout(timer)
        resolve()
      })
      this.relay.actions.push(action)
      for (const poll of [...this.relay.polls]) poll()
    })
    return {}
  }

  /**
   * A subagent session this process has not seen yet (e.g. created before it started): known once OpenCode
   * says it descends from a session this process reports. Adds the chain to the tracker.
   */
  private async adopt(sessionID: string): Promise<boolean> {
    if (this.config.mode === "off") return false
    const chain: HostSession[] = []
    let current = sessionID
    for (let depth = 0; depth < 8; depth++) {
      let session: HostSession
      try {
        session = await this.host.getSession(current)
      } catch {
        return false
      }
      chain.push(session)
      const parentID = session.parentID
      if (!parentID || chain.some((s) => s.id === parentID)) return false
      if (!isReported(this.config, this.tracker, parentID)) {
        current = parentID
        continue
      }
      const now = Date.now()
      for (const s of chain) {
        this.tracker.ensure(s.id, now)
        this.tracker.setInfo(s.id, {
          title: s.title ?? "",
          directory: s.location?.directory ?? "",
          ...(s.parentID ? { parentID: s.parentID } : {}),
          updated: s.time?.updated ?? now,
        })
      }
      this.scheduleSnapshot()
      return true
    }
    return false
  }

  private modelDefaults(): SessionModelPrefs {
    const convert = (value: string | undefined) => {
      const ref = value ? parseModelRef(value) : undefined
      return ref && { providerID: ref.providerID, modelID: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
    }
    return { ...(convert(this.config.voiceModel) ? { voice: convert(this.config.voiceModel)! } : {}), ...(convert(this.config.workModel) ? { worker: convert(this.config.workModel)! } : {}) }
  }

  private modelPrefsResult(sessionID: string): ResultFor["modelPrefs"] {
    return { prefs: structuredClone(this.modelPrefs.get(sessionID) ?? {}), defaults: this.modelDefaults() }
  }

  private directoryOf(sessionID: string): string {
    return this.tracker.directoryOf(sessionID) || this.host.directory
  }

  /** Right-rail data; each part is read independently and left out when it fails or is unsupported. */
  private async summary(sessionID: string): Promise<ResultFor["summary"]> {
    const directory = this.directoryOf(sessionID)
    const optional = async <T>(read: (() => Promise<T | undefined>) | undefined): Promise<T | undefined> => {
      if (!read) return undefined
      try {
        return await read()
      } catch {
        return undefined
      }
    }
    const host = this.host
    const [messages, models, mcp, diffs, branch] = await Promise.all([
      optional(() => host.context(sessionID)),
      optional(host.listModels && (() => host.listModels!())),
      optional(host.mcpList && (() => host.mcpList!(directory))),
      optional(host.vcsDiff && (() => host.vcsDiff!(directory))),
      optional(host.vcsBranch && (() => host.vcsBranch!(directory))),
    ])
    const context = messages && contextUsage(messages, models ?? [])
    return {
      directory,
      ...(branch ? { branch } : {}),
      ...(context ? { context } : {}),
      ...(mcp ? { mcp: mcpServers(mcp) } : {}),
      ...(diffs ? { changes: changeStats(diffs) } : {}),
    }
  }

  /**
   * Stops a whole session tree: running descendants deepest first, then the root (always, so a pending
   * retry or queued run is cancelled too). A descendant that already settled is not an error.
   */
  private async stopTree(sessionID: string): Promise<ResultFor["stop"]> {
    const root = this.tracker.rootOf(sessionID)
    const order = [...this.tracker.runningBelow(root), root]
    for (const id of order) {
      try {
        await this.host.interrupt(id)
      } catch (cause) {
        if (id === root) throw cause
      }
    }
    return { stopped: order }
  }

  /** Applies a saved Voice override at the boundary before the next turn; never changes a running tree. */
  /**
   * A cleared override switches back to the model the session had before the first override, unless the
   * user picked another model meanwhile.
   */
  private async applyVoiceModel(sessionID: string): Promise<void> {
    const selected = this.modelPrefs.get(sessionID)?.voice
    const override = this.voiceOverrides.get(sessionID)
    if ((!selected && !override) || this.tracker.active().includes(this.tracker.rootOf(sessionID))) return
    const current = await this.currentModel(sessionID)
    const onOverride = override !== undefined && current !== undefined && sameModel(current, override.applied)
    if (!selected) {
      this.voiceOverrides.delete(sessionID)
      if (onOverride && override.previous) await this.switchModel(sessionID, override.previous)
      return
    }
    const target = { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) }
    if (current && sameModel(current, target)) {
      if (override) this.voiceOverrides.set(sessionID, { ...override, applied: target })
      return
    }
    const previous = onOverride ? override.previous : current ? plainModelRef(current) : undefined
    this.voiceOverrides.set(sessionID, { ...(previous ? { previous } : {}), applied: target })
    await this.switchModel(sessionID, target)
  }

  /** The session's current model: remembered, else asked from OpenCode (and remembered). */
  private async currentModel(sessionID: string): Promise<ModelRef | undefined> {
    const known = this.sessionModels.get(sessionID)
    if (known) return known.model
    const { model } = await this.host.getSession(sessionID)
    this.rememberModel(sessionID, model)
    return model
  }

  private rememberModel(sessionID: string, model: ModelRef | undefined): void {
    this.sessionModels.delete(sessionID)
    this.sessionModels.set(sessionID, model ? { model } : {})
    if (this.sessionModels.size > SESSION_MODELS_LIMIT) this.sessionModels.delete(this.sessionModels.keys().next().value!)
  }

  private async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    try {
      await this.host.switchModel(sessionID, model)
      this.rememberModel(sessionID, model)
    } catch (cause) {
      this.sessionModels.delete(sessionID) // unknown now: ask next time
      throw cause
    }
  }

  /** Enables or disables voice for a session this process reported (mode "session" only). */
  private expose(sessionID: string, on: boolean): ResultFor["expose"] {
    if (!this.tracker.has(sessionID)) throw new Error("Unknown session")
    if (this.config.mode === "session") this.setSession(sessionID, on)
    this.sendSnapshot()
    return { exposed: isExposed(this.config, this.tracker, sessionID) }
  }

  /**
   * Creates a session in a workspace or session directory this (service) process reported, or a folder
   * of a Herdr pane. With `herdrWorkspace`, also opens it in a new tab of that Herdr workspace; if that
   * fails the session still exists and the result carries a warning instead of `openedIn`.
   */
  private async create(directory: string, title?: string, herdrWorkspace?: string): Promise<ResultFor["create"] & { warning?: string }> {
    if (this.options.kind !== "service" || !this.host.createSession) {
      throw new Error("Only the background service creates sessions")
    }
    const target = path.resolve(directory)
    const workspace =
      this.workspaces().get(target) ?? (this.herdr?.hasDirectory(target) ? { project: target, projectName: path.basename(target) || target } : undefined)
    if (!workspace) throw new Error("unknown workspace")
    const session = await this.host.createSession({ directory: target, ...(title ? { title } : {}) })
    const now = Date.now()
    this.tracker.observe({ type: "session.created", data: { sessionID: session.id, title: title ?? "", location: { directory: target } } }, now)
    this.tracker.setInfo(session.id, { title: title ?? "", directory: target, updated: now, ...workspace })
    if (this.config.mode === "session") this.setSession(session.id, true)
    this.sendSnapshot()
    if (!herdrWorkspace) return { sessionID: session.id }
    const warning = await this.openInHerdr(herdrWorkspace, target, session.id, title)
    return warning ? { sessionID: session.id, warning } : { sessionID: session.id, openedIn: "herdr" }
  }

  /** Opens a session in a new Herdr tab; returns a warning when that did not work. */
  private async openInHerdr(workspaceID: string, directory: string, sessionID: string, title?: string): Promise<string | undefined> {
    const herdr = this.herdr
    const run = this.options.herdr
    if (!herdr || !run) return "Herdr is not available on this machine; the session was created but not opened"
    if (!herdr.hasWorkspace(workspaceID)) return `Herdr workspace ${workspaceID} not found; the session was created but not opened`
    try {
      await openInHerdr(run, { workspaceID, directory, sessionID, ...(title ? { title } : {}) }, { settleMs: this.options.herdrSettleMs })
      void herdr.refresh()
      return undefined
    } catch (cause) {
      console.error(`[hub] could not open ${sessionID} in Herdr`, errorText(cause))
      return `Could not open the session in Herdr: ${errorText(cause)}`
    }
  }

  /** Normalized workspace roots and session directories this process knows → their workspace. */
  private workspaces(): Map<string, { project: string; projectName: string }> {
    const out = new Map<string, { project: string; projectName: string }>()
    for (const s of this.tracker.snapshot(Date.now())) {
      if (!s.directory.startsWith("/")) continue
      const project = s.project ?? path.resolve(s.directory)
      const workspace = { project, projectName: s.projectName ?? path.basename(project) }
      if (!out.has(project)) out.set(project, workspace)
      out.set(path.resolve(s.directory), workspace)
    }
    return out
  }

  private async turn(sessionID: string, text: string, voiceStyle: boolean, images?: readonly PromptImage[]): Promise<TurnResult> {
    if (this.running.has(sessionID)) throw new Error("A turn is already running for this session")
    if (isExposed(this.config, this.tracker, sessionID)) await this.applyVoiceModel(sessionID)
    this.running.add(sessionID)
    if (voiceStyle) this.voiceTurns.set(sessionID, (this.voiceTurns.get(sessionID) ?? 0) + 1)
    try {
      const inbox = await this.host.prompt({ sessionID, text, ...promptFiles(images), metadata: { source: PROMPT_SOURCE } })
      const result = await this.turns.wait(inbox.id, { timeoutMs: this.options.turnTimeoutMs ?? 10 * 60_000 })
      let reply = ""
      try {
        reply = extractReply((await this.host.context(sessionID)) as Parameters<typeof extractReply>[0], inbox.id)
      } catch {
        // reply stays empty; the outcome still matters
      }
      if (result.outcome === "succeeded" || result.outcome === "timeout") return { outcome: result.outcome, reply }
      return { outcome: result.outcome, message: result.message, reply }
    } finally {
      this.running.delete(sessionID)
      if (voiceStyle) {
        const left = (this.voiceTurns.get(sessionID) ?? 1) - 1
        if (left > 0) this.voiceTurns.set(sessionID, left)
        else this.voiceTurns.delete(sessionID)
      }
    }
  }

  private async listen(): Promise<void> {
    while (!this.abort.signal.aborted) {
      // Model changes may have been missed while the stream was down: ask OpenCode again.
      this.sessionModels.clear()
      try {
        // Events may have been missed while the stream was down (or before it opened): ask what runs now.
        if (this.connection?.state === "connected") void this.seedActivity()
        for await (const event of this.host.events(this.abort.signal)) this.observe(event)
      } catch (cause) {
        if (this.abort.signal.aborted) return
        console.error("[hub] event stream failed, retrying", cause)
      }
      if (this.abort.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private observe(event: EventLike): void {
    try {
      const sessionID = (event.data as Record<string, unknown> | undefined)?.sessionID
      if (typeof sessionID === "string") this.timelines.invalidate(sessionID)
      this.turns.observe(event)
      this.observeModel(event)
      if (event.type === "form.replied" || event.type === "form.cancelled") {
        const formID = (event.data as Record<string, unknown> | undefined)?.id
        if (typeof formID === "string") {
          this.relay.settled.get(formID)?.()
          this.relay.settled.delete(formID)
        }
      }
      this.tasks.observe(event, Date.now())
      if (this.tracker.observe(event, Date.now())) this.scheduleSnapshot()
      if (this.options.kind === "service" && this.host.listRecent && LISTING_EVENTS.has(event.type) && !(event.data as any)?.parentID) {
        this.scheduleSeed()
      }
      void this.fetchInfo()
      if (this.connection?.state === "connected" && FORWARDED_EVENTS.has(event.type)) {
        // Activity events go out compact: tool inputs become a short summary, outputs are dropped; job exits
        // get their session from the job.
        const compact = compactActivity({ type: event.type, data: (event.data ?? {}) as Record<string, unknown> }, (id) => this.tracker.jobSession(id))
        if (compact && shouldForward(this.config, this.tracker, compact)) this.connection.send({ t: "event", event: compact })
      }
    } catch (cause) {
      console.error("[hub] event handling failed", cause)
    }
  }

  /** Keeps the remembered session models current from OpenCode's events. */
  private observeModel(event: EventLike): void {
    const data = (event.data ?? {}) as { sessionID?: unknown; model?: unknown }
    if (typeof data.sessionID !== "string") return
    if (event.type === "session.deleted") this.sessionModels.delete(data.sessionID)
    else if (event.type === "session.model.selected") {
      const model = data.model as Partial<ModelRef> | undefined
      if (model && typeof model.providerID === "string" && typeof model.id === "string") this.rememberModel(data.sessionID, model as ModelRef)
      else this.sessionModels.delete(data.sessionID)
    }
  }

  private async fetchInfo(): Promise<void> {
    const now = Date.now()
    for (const id of this.tracker.needsInfo()) {
      const tried = this.infoTried.get(id)
      if (tried !== undefined && now - tried < INFO_RETRY_MS) continue
      this.infoTried.set(id, now)
      try {
        const session = await this.host.getSession(id)
        this.tracker.setInfo(id, {
          title: session.title ?? "",
          directory: session.location?.directory ?? "",
          ...(session.parentID ? { parentID: session.parentID } : {}),
          updated: session.time?.updated ?? now,
        })
        this.infoTried.delete(id)
        this.scheduleSnapshot()
      } catch {
        // retried after INFO_RETRY_MS
      }
    }
  }

  /**
   * Sends each running (or formerly running) session's current status and running jobs as a session.seed event,
   * from the host's snapshot. Sessions the tracker thought working that are not active any more are seeded idle.
   */
  private async seedActivity(): Promise<void> {
    const activity = this.host.activity
    if (!activity || this.seeding) return
    this.seeding = true
    try {
      const snapshot = await activity.call(this.host, this.tracker.directories(SEED_DIRECTORIES))
      const active = new Set(snapshot.active)
      const ids = new Set([...snapshot.active, ...snapshot.jobs.map((j) => j.sessionID), ...this.tracker.working()])
      const now = Date.now()
      for (const id of ids) {
        if (active.has(id)) this.tracker.ensure(id, now)
        if (!this.tracker.has(id)) continue
        const jobs = snapshot.jobs
          .filter((j) => j.sessionID === id && j.status === "running")
          .slice(0, SEED_JOBS_MAX)
          .map(({ sessionID: _, ...job }) => job)
        const status = active.has(id) ? "busy" : "idle"
        this.tracker.seed(id, { status, jobs })
        const event = { type: "session.seed", data: { sessionID: id, status: { type: status }, jobs } }
        if (this.connection?.state === "connected" && shouldForward(this.config, this.tracker, event)) this.connection.send({ t: "event", event })
      }
      void this.fetchInfo()
      this.scheduleSnapshot()
    } catch (cause) {
      console.error("[hub] could not read running sessions", errorText(cause))
    } finally {
      this.seeding = false
    }
  }

  private async seed(): Promise<void> {
    try {
      const keep = this.keep()
      const { days, max } = this.config.list
      const sessions = (await this.host.listRecent?.({ days, max, include: [...keep] })) ?? []
      if (this.tracker.applyListing(sessions, Date.now(), keep)) this.scheduleSnapshot()
    } catch (cause) {
      console.error("[hub] could not list recent sessions", errorText(cause))
    }
  }

  private scheduleSeed(): void {
    if (this.seedTimer || !this.started) return
    this.seedTimer = setTimeout(() => {
      this.seedTimer = undefined
      void this.seed()
    }, this.options.seedDebounceMs ?? 2000)
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      this.sendSnapshot()
    }, this.options.snapshotDebounceMs ?? 500)
  }

  private sendSnapshot(): void {
    const tui = this.presenceBook.open(Date.now())
    this.connection?.send({ t: "sessions", sessions: browserSessions(this.config, this.tracker, Date.now(), { terminal: (id) => this.terminal(id, tui) }) })
  }

  private every(ms: number, run: () => void): void {
    const interval = setInterval(run, ms)
    ;(interval as { unref?: () => void }).unref?.()
    this.intervals.push(interval)
  }
}

/** Directories whose shells are listed when seeding. */
const SEED_DIRECTORIES = 20

/** Keeps the terminals frame within the protocol's limits. */
function limitWorkspaces(workspaces: readonly HerdrWorkspace[]): HerdrWorkspace[] {
  return workspaces.slice(0, 200).map((w) => ({ id: w.id, label: w.label, directories: w.directories.slice(0, 20) }))
}

/** Sessions whose current model is remembered. */
const SESSION_MODELS_LIMIT = 500

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id && (explicitVariant(a) ?? "") === (explicitVariant(b) ?? "")
}
