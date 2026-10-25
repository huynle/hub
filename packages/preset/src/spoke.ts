// The preset spoke (design §1.2 preset tier, decision fx04e42c point 6): a harness without a spoke of its own,
// described by a data-only preset and driven through a terminal pane (TerminalBackend: tmux). Built on HarnessSpoke.
//
// It announces only what a pasted terminal can do, and claims no more than it sees (evidence "screen"):
// - turn: the text is pasted into the pane and submitted; the hub is answered at once with outcome "timeout" and no
//   reply (the spoke cannot see the harness take the prompt nor finish it: unconfirmed, never "succeeded");
// - deliver: a hub message (wake) is pasted and submitted once per messageID and answered "queued"; without wake it
//   is "retained" (nothing is typed into the user's input line) and pasted ahead of the session's next turn or
//   message; a prompt (hubPrompt) goes in its provenance envelope;
// - interrupt and stop: Ctrl-C, only when the backend can send keys;
// - never permission, form or steer (a terminal paste can answer neither a dialog nor a running turn reliably);
// - never an event: no activity, and above all no idle, is inferred from the screen (the hub never treats screen
//   evidence as idle anyway). The screen is only sampled for the harness's native session ID (source screen) and the
//   pane's liveness: the session ends with its pane.
//
// Session IDs: each launch gets a fresh UUID, its hub ID is hubSessionID("pr", uuid). For a preset whose native ID is
// passed on the command line (source argv) that UUID is the native ID: reported, not observed (the spoke never sees
// the harness use it).
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { HarnessPreset, SessionInfo } from "../../protocol/src/index.ts"
import { deliverText, HarnessSpoke, hubSessionID, type Admission, type DeliverRequest, type HarnessSpokeOptions, type OpHandlers } from "../../spoke-sdk/src/index.ts"
import { launchArgv, nativeIDFromScreen } from "./presets.ts"
import type { TerminalBackend, TerminalPane } from "./tmux.ts"

/** The hub session ID namespace of preset sessions (ses_pr…). */
export const PRESET_SESSION_NAMESPACE = "pr"
export const SAMPLE_MS = 2000
/** Lines of screen searched for a native ID. */
export const CAPTURE_LINES = 200

export interface NativeID {
  readonly id: string
  /** How the spoke knows it: "read off the screen", or "reported, not observed (…)" when the hub passed it. */
  readonly how: string
}

export interface PresetSpokeOptions {
  readonly preset: HarnessPreset
  readonly backend: TerminalBackend
  readonly server: string
  /** The machine token (never logged). */
  readonly token: string
  readonly pluginVersion: string
  /** The spoke's directory (its hello). */
  readonly directory: string
  /** The harness's version, when known (default ""). */
  readonly harnessVersion?: string
  readonly newID?: () => string
  readonly now?: () => number
  readonly sampleMs?: number
  readonly log?: (line: string) => void
  readonly socket?: HarnessSpokeOptions["socket"]
  readonly backoff?: HarnessSpokeOptions["backoff"]
  readonly onState?: HarnessSpokeOptions["onState"]
}

export interface LaunchOptions {
  readonly cwd: string
  readonly args?: readonly string[]
  /** Resume this native session ID (the preset's resumeFlag). */
  readonly resume?: string
  readonly env?: Readonly<Record<string, string>>
}

export interface Launched {
  readonly sessionID: string
  readonly pane: TerminalPane
  readonly nativeID?: NativeID
  /** How to look at the pane. */
  readonly attach: string
}

interface Session {
  readonly id: string
  readonly pane: TerminalPane
  nativeID?: NativeID
  /** Hub messages admitted without waking, pasted ahead of the next submit. */
  readonly retained: Array<{ readonly messageID: string; readonly text: string }>
  /** Pastes into one pane run one after another. */
  chain: Promise<unknown>
}

const unsafeName = /[^A-Za-z0-9_-]/g

export class PresetSpoke {
  readonly spoke: HarnessSpoke
  readonly preset: HarnessPreset
  readonly evidence = "screen" as const

  readonly #backend: TerminalBackend
  readonly #sessions = new Map<string, Session>()
  readonly #newID: () => string
  readonly #now: () => number
  readonly #sampleMs: number
  readonly #log: (line: string) => void
  readonly #ended = new Set<(sessionID: string) => void>()
  #timer: ReturnType<typeof setInterval> | undefined
  #sampling = false

  constructor(options: PresetSpokeOptions) {
    this.preset = options.preset
    this.#backend = options.backend
    this.#newID = options.newID ?? randomUUID
    this.#now = options.now ?? Date.now
    this.#sampleMs = options.sampleMs ?? SAMPLE_MS
    this.#log = options.log ?? (() => {})
    const handlers: OpHandlers = {
      turn: async (req) => {
        if (req.images?.length) throw new Error(`The ${this.preset.name} preset spoke pastes text into a terminal: it cannot send images`)
        await this.#submit(this.#session(req.sessionID), req.text)
        return { outcome: "timeout", reply: "" }
      },
      ...(this.#backend.canSendKeys
        ? {
            interrupt: async (req: { sessionID: string }) => (await this.#interrupt(req.sessionID), {}),
            stop: async (req: { sessionID: string }) => (await this.#interrupt(req.sessionID), { stopped: [req.sessionID] }),
          }
        : {}),
    }
    this.spoke = new HarnessSpoke({
      server: options.server,
      token: options.token,
      harness: options.preset.name,
      harnessVersion: options.harnessVersion ?? "",
      evidence: "screen",
      pluginVersion: options.pluginVersion,
      directory: options.directory,
      kind: "standalone",
      mode: "always",
      handlers,
      deliver: (req) => this.#deliver(req),
      features: ["hubPrompt"],
      ...(options.socket ? { socket: options.socket } : {}),
      ...(options.backoff ? { backoff: options.backoff } : {}),
      ...(options.onState ? { onState: options.onState } : {}),
    })
  }

  /** Connects to the hub and samples the panes now and then. */
  start(): void {
    this.spoke.start()
    if (this.#timer || this.#sampleMs <= 0) return
    this.#timer = setInterval(() => void this.sample(), this.#sampleMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.spoke.stop()
  }

  /** Starts the preset's harness in a new pane and reports it as a session. */
  async launch(options: LaunchOptions): Promise<Launched> {
    const uuid = this.#newID()
    const { argv, nativeID } = launchArgv(this.preset, { ...(options.args ? { args: options.args } : {}), ...(options.resume !== undefined ? { resume: options.resume } : {}), newID: () => uuid })
    const name = `hub-${this.preset.name.replace(unsafeName, "_")}-${uuid.replace(unsafeName, "").slice(0, 8)}`
    const pane = await this.#backend.launch({ argv, cwd: options.cwd, name, ...(options.env ? { env: options.env } : {}) })
    const id = hubSessionID(PRESET_SESSION_NAMESPACE, uuid)
    const known: NativeID | undefined =
      nativeID === undefined
        ? undefined
        : options.resume !== undefined
          ? { id: nativeID, how: `reported, not observed (resumed with ${this.preset.resumeFlag})` }
          : { id: nativeID, how: `reported, not observed (passed with ${(this.preset.nativeID as { flag: string }).flag})` }
    this.#sessions.set(id, { id, pane, ...(known ? { nativeID: known } : {}), retained: [], chain: Promise.resolve() })
    const info: SessionInfo = { id, title: `${this.preset.name} · ${path.basename(options.cwd) || options.cwd}`, directory: options.cwd, updated: this.#now(), owned: true, open: true }
    this.spoke.upsertSession(info)
    return { sessionID: id, pane, ...(known ? { nativeID: known } : {}), attach: this.#backend.attachHint(pane) }
  }

  /** The session's native ID, when known. */
  nativeID(sessionID: string): NativeID | undefined {
    return this.#sessions.get(sessionID)?.nativeID
  }

  pane(sessionID: string): TerminalPane | undefined {
    return this.#sessions.get(sessionID)?.pane
  }

  /** Calls `listener` with each session that ended (its pane is gone). */
  onEnd(listener: (sessionID: string) => void): void {
    this.#ended.add(listener)
  }

  /** One sampling round: ends sessions whose pane is gone, reads native IDs off the screen. Never sends an event. */
  async sample(): Promise<void> {
    if (this.#sampling) return
    this.#sampling = true
    try {
      for (const session of [...this.#sessions.values()]) {
        if (!(await this.#backend.alive(session.pane).catch(() => false))) {
          this.#end(session.id)
          continue
        }
        this.spoke.touch(session.id)
        if (session.nativeID || this.preset.nativeID.source !== "screen") continue
        const screen = await this.#backend.capture(session.pane, CAPTURE_LINES).catch(() => "")
        const id = nativeIDFromScreen(this.preset, screen)
        if (id) {
          session.nativeID = { id, how: "read off the screen" }
          this.#log(`session ${session.id}: native ID ${id} (read off the screen)`)
        }
      }
    } finally {
      this.#sampling = false
    }
  }

  #end(sessionID: string): void {
    if (!this.#sessions.delete(sessionID)) return
    this.spoke.endSession(sessionID)
    for (const listener of this.#ended) listener(sessionID)
  }

  #session(sessionID: string): Session {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error(`Unknown session ${sessionID}`)
    return session
  }

  /** Pastes the retained messages and `text`, then Enter; one paste at a time per pane. */
  #submit(session: Session, text: string): Promise<void> {
    const run = session.chain.then(async () => {
      const ahead = session.retained.splice(0).map((m) => m.text)
      await this.#backend.paste(session.pane, [...ahead, text].join("\n\n"), { submit: true })
    })
    session.chain = run.catch(() => {})
    return run
  }

  async #deliver(req: DeliverRequest): Promise<Admission> {
    const session = this.#session(req.sessionID)
    const text = deliverText(req)
    if (!req.wake) {
      session.retained.push({ messageID: req.messageID, text })
      return { result: { delivered: "retained" }, resumed: false }
    }
    // A retry that wakes a message first retained: it goes now, not again later.
    const at = session.retained.findIndex((m) => m.messageID === req.messageID)
    if (at >= 0) session.retained.splice(at, 1)
    await this.#submit(session, text)
    return { result: { delivered: "queued" }, resumed: true }
  }

  async #interrupt(sessionID: string): Promise<void> {
    await this.#backend.interrupt(this.#session(sessionID).pane)
  }
}

