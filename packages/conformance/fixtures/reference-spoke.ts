// The reference fake harness and its spoke, built on HarnessSpoke: what a hooks-evidence harness spoke that passes
// every conformance check looks like, and (with a fault) a spoke that breaks exactly one check.
//
// The fake harness is a tiny agent loop: a prompt (typed by the "local user" through the driver, or delivered by the
// hub) runs a turn against the stub model's OpenAI chat completions API; every tool call the model makes asks
// permission first (permission.asked), runs on once/always (tool.called, tool.success) or fails on reject
// (tool.failed), and the turn ends with the model's text (text.ended, execution.succeeded). It reports what a hooks
// spoke can see, never raw tool input or output, never a token.
//
// Faults (one per check; see FAULTS) are injected at the spoke, mostly through a socket wrapper below
// HarnessSpoke, so each breaks one promise and keeps every other.
import { MAX_FRAME, type HarnessEvent, type ServerRequest, type SessionInfo } from "../../protocol/src/index.ts"
import { HarnessSpoke, hubSessionID, type Admission, type DeliverRequest, type SocketLike } from "../../spoke-sdk/src/index.ts"

/** One fault per check id: the check it makes fail. */
export const FAULTS = ["hello", "features", "events", "deliver.idempotent", "deliver.modes", "permission", "tokens", "reconnect", "frames"] as const
export type Fault = (typeof FAULTS)[number]

export const REFERENCE_HARNESS = "conformance-fake"
export const REFERENCE_VERSION = "1.0.0"
/** The tool call that makes the fake harness ask permission (driver method permissionToolCall). */
export const PERMISSION_TOOL_CALL = { name: "shell", input: { command: "echo conformance" } } as const

export interface FakeHarnessOptions {
  readonly hubURL: string
  readonly token: string
  readonly directory: string
  /** The stub model's OpenAI-compatible base URL (…/v1). */
  readonly modelBaseURL: string
  readonly fault?: Fault
  /** Serve neither permission nor deliver (a spoke whose harness has no such hooks). */
  readonly minimal?: boolean
  /** Where the harness logs (stderr in the driver); never given a token, except by the "tokens" fault. */
  readonly log?: (line: string) => void
}

interface Session {
  readonly id: string
  readonly directory: string
  title: string
  busy: boolean
  turn?: AbortController
  /** Hub messages admitted behind the running turn (or without waking). */
  readonly queue: Array<{ text: string; inboxID: string }>
  readonly permissions: Map<string, (decision: "once" | "always" | "reject") => void>
}

type ChatMessage = Record<string, unknown>

let counter = 0
const nextID = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36)}`
const SUMMARY_MAX = 160

/** Features the reference spoke announces (from a spoke that is never started). */
export function referenceFeatures(minimal = false): readonly string[] {
  return new FakeHarness({ hubURL: "http://127.0.0.1:1", token: "unused", directory: "/", modelBaseURL: "http://127.0.0.1:1/v1", minimal }).spoke.features
}

export class FakeHarness {
  readonly spoke: HarnessSpoke
  readonly #sessions = new Map<string, Session>()
  readonly #options: FakeHarnessOptions
  readonly #log: (line: string) => void

  constructor(options: FakeHarnessOptions) {
    this.#options = options
    this.#log = options.log ?? (() => {})
    const fault = options.fault
    this.spoke = new HarnessSpoke({
      server: options.hubURL,
      token: options.token,
      harness: REFERENCE_HARNESS,
      harnessVersion: REFERENCE_VERSION,
      evidence: "hooks",
      pluginVersion: "0.0.1",
      directory: options.directory,
      handlers: {
        ...(options.minimal ? {} : { permission: (req: Extract<ServerRequest, { op: "permission" }>) => this.#permission(req) }),
        interrupt: (req) => (this.#interrupt(req.sessionID), {}),
        stop: (req) => (this.#interrupt(req.sessionID), { stopped: [req.sessionID] }),
        form: () => ({ gone: true }),
        rename: (req) => this.#rename(req.sessionID, req.title),
      },
      ...(options.minimal ? {} : { deliver: (req: DeliverRequest) => this.#deliver(req) }),
      backoff: fault === "reconnect" ? { minMs: 60_000, maxMs: 60_000 } : { minMs: 500, maxMs: 5000 },
      socket: faultySocket(fault, () => [...this.#sessions.keys()][0]),
    })
  }

  start(): void {
    this.spoke.start()
    this.#log(`[fake] spoke connecting to ${this.#options.hubURL}`)
  }

  stop(): void {
    for (const s of this.#sessions.values()) s.turn?.abort()
    this.spoke.stop()
  }

  /** Opens a session as the local user would; returns its hub session ID. */
  createSession(directory = this.#options.directory): string {
    const id = hubSessionID("cf", crypto.randomUUID())
    const session: Session = { id, directory, title: "Fake session", busy: false, queue: [], permissions: new Map() }
    this.#sessions.set(id, session)
    this.spoke.upsertSession(this.#info(session))
    this.#emit({ type: "session.created", data: { sessionID: id, title: session.title } })
    this.#log(`[fake] session ${id} created`)
    return id
  }

  /** The local user types a prompt: it runs now, or after the running turn. */
  prompt(sessionID: string, text: string): void {
    const session = this.#session(sessionID)
    const inboxID = nextID("inb")
    this.#emit({ type: "session.inbox.delivered", data: { sessionID, inboxID, origin: "user" } })
    if (session.busy) session.queue.push({ text, inboxID })
    else void this.#turn(session, text)
  }

  /** The local user acts in the harness UI. */
  local(sessionID: string, action: string): void {
    const session = this.#session(sessionID)
    if (action === "interrupt") this.#interrupt(sessionID)
    else if (action === "approve" || action === "deny") {
      for (const [id, resolve] of [...session.permissions]) {
        session.permissions.delete(id)
        resolve(action === "approve" ? "once" : "reject")
      }
    } else if (action === "exit") {
      this.#interrupt(sessionID)
      this.#sessions.delete(sessionID)
      this.spoke.endSession(sessionID)
      this.#emit({ type: "session.deleted", data: { sessionID } })
    } else throw new Error(`unknown local action ${action}`)
  }

  #session(sessionID: string): Session {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error(`unknown session ${sessionID}`)
    return session
  }

  #info(s: Session): SessionInfo {
    return { id: s.id, title: s.title, directory: s.directory, updated: Date.now(), owned: true }
  }

  #emit(event: HarnessEvent): void {
    this.spoke.emit(event)
  }

  #permission(req: Extract<ServerRequest, { op: "permission" }>): { gone?: true } {
    const session = this.#session(req.sessionID)
    const resolve = session.permissions.get(req.requestID)
    if (!resolve) return { gone: true }
    session.permissions.delete(req.requestID)
    resolve(req.decision)
    return {}
  }

  #interrupt(sessionID: string): void {
    this.#sessions.get(sessionID)?.turn?.abort()
  }

  #rename(sessionID: string, title: string): { title: string } {
    const session = this.#session(sessionID)
    const trimmed = title.trim().slice(0, 200)
    if (!trimmed) throw new Error("A title needs 1–200 characters")
    session.title = trimmed
    this.spoke.upsertSession(this.#info(session))
    this.#emit({ type: "session.renamed", data: { sessionID, title: trimmed } })
    return { title: trimmed }
  }

  async #deliver(req: DeliverRequest): Promise<Admission> {
    const session = this.#session(req.sessionID)
    const inboxID = nextID("inb")
    if (this.#options.fault === "deliver.modes") return { result: { delivered: "steer", inboxID }, resumed: true }
    if (!req.wake || session.busy) {
      session.queue.push({ text: req.text, inboxID })
      return { result: { delivered: "queued", inboxID }, resumed: req.wake }
    }
    // Idle and asked to wake: the message starts a turn now, confirmed (as a hook would) before answering.
    this.#emit({ type: "session.inbox.delivered", data: { sessionID: session.id, inboxID, origin: "hub" } })
    void this.#turn(session, req.text)
    return { result: { delivered: "turn", inboxID }, resumed: true }
  }

  async #turn(session: Session, text: string): Promise<void> {
    const sessionID = session.id
    const abort = new AbortController()
    session.busy = true
    session.turn = abort
    const turnID = nextID("trn")
    this.#emit({ type: "session.execution.started", data: { sessionID, turnID } })
    this.#emit({ type: "session.status", data: { sessionID, status: { type: "busy" } } })
    if (this.#options.fault === "tokens") this.#log(`[fake] turn ${turnID} with session token ${this.spoke.sessionToken(sessionID)?.token ?? "(none)"}`)
    else this.#log(`[fake] turn ${turnID} started`)
    const messages: ChatMessage[] = [{ role: "user", content: text }]
    try {
      for (let step = 0; step < 8; step++) {
        const reply = await this.#model(messages, abort.signal)
        const assistantMessageID = nextID("msg")
        const calls: any[] = Array.isArray(reply?.tool_calls) ? reply.tool_calls : []
        if (!calls.length) {
          const answer = typeof reply?.content === "string" ? reply.content : ""
          this.#emit({ type: "session.text.ended", data: { sessionID, assistantMessageID, ordinal: 0, text: answer.slice(0, 16_000) } })
          break
        }
        messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls })
        for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: await this.#tool(session, assistantMessageID, call, abort.signal) })
      }
      this.#emit({ type: "session.execution.succeeded", data: { sessionID, turnID } })
    } catch (e) {
      if (abort.signal.aborted) this.#emit({ type: "session.execution.interrupted", data: { sessionID, turnID } })
      else this.#emit({ type: "session.execution.failed", data: { sessionID, turnID, error: { message: String(e instanceof Error ? e.message : e).slice(0, 1000) } } })
    } finally {
      session.busy = false
      session.turn = undefined
      for (const resolve of session.permissions.values()) resolve("reject")
      session.permissions.clear()
      this.#emit({ type: "session.status", data: { sessionID, status: { type: "idle" } } })
    }
    const next = session.queue.shift()
    if (next && this.#sessions.has(sessionID)) {
      this.#emit({ type: "session.inbox.delivered", data: { sessionID, inboxID: next.inboxID, origin: "hub" } })
      void this.#turn(session, next.text)
    }
  }

  async #model(messages: ChatMessage[], signal: AbortSignal): Promise<any> {
    const res = await fetch(`${this.#options.modelBaseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer stub" },
      body: JSON.stringify({ model: "stub", stream: false, messages, tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }] }),
      signal,
    })
    if (!res.ok) throw new Error(`model answered ${res.status}`)
    const body: any = await res.json()
    return body?.choices?.[0]?.message
  }

  /** Asks permission for a tool call, then runs or refuses it; returns the tool result for the model. */
  async #tool(session: Session, assistantMessageID: string, call: any, signal: AbortSignal): Promise<string> {
    const sessionID = session.id
    const id = String(call.id)
    let input: any = {}
    try {
      input = JSON.parse(call.function?.arguments ?? "{}")
    } catch {}
    const command = typeof input.command === "string" ? input.command : JSON.stringify(input)
    const requestID = nextID("per")
    const decision = await new Promise<"once" | "always" | "reject">((resolve) => {
      session.permissions.set(requestID, resolve)
      signal.addEventListener("abort", () => resolve("reject"), { once: true })
      this.#emit({
        type: "permission.asked",
        data: { sessionID, id: requestID, action: "shell", resources: [command.slice(0, 4000)], source: { type: "tool", messageID: assistantMessageID, id } },
      })
    })
    if (signal.aborted) throw new Error("interrupted")
    if (this.#options.fault !== "permission") this.#emit({ type: "permission.replied", data: { sessionID, requestID, reply: decision } })
    if (decision === "reject") {
      this.#emit({ type: "session.tool.failed", data: { sessionID, id, error: "rejected by the user" } })
      return "The user rejected this tool call."
    }
    this.#emit({ type: "session.tool.called", data: { sessionID, id, assistantMessageID, summary: command.slice(0, SUMMARY_MAX) } })
    const output = `$ ${command}\n${"conformance output line\n".repeat(200)}`
    if (this.#options.fault === "events") this.spoke.emit({ type: "session.tool.success", data: { sessionID, id, output } } as unknown as HarnessEvent)
    else this.#emit({ type: "session.tool.success", data: { sessionID, id } })
    return output
  }
}

// ---- faults below HarnessSpoke ---------------------------------------------------------------------------------

/** The default WebSocket, wrapped so a fault can rewrite or answer frames; no fault: a plain pass-through. */
function faultySocket(fault: Fault | undefined, firstSession: () => string | undefined): (url: string, headers: Record<string, string>) => SocketLike {
  return (url, headers) => {
    const ws = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(url, { headers })
    let deliverRetry = 0
    let oversizeSent = false
    const wrapped: SocketLike = {
      get readyState() {
        return ws.readyState
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        if (fault === "hello" && data.includes('"t":"hello"')) data = data.replace('"evidence":"hooks"', '"evidence":"guess"')
        ws.send(data)
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason)
      },
    }
    ws.onopen = (ev) => wrapped.onopen?.(ev)
    ws.onerror = (ev) => wrapped.onerror?.(ev)
    ws.onclose = (ev) => wrapped.onclose?.({ code: ev.code, reason: ev.reason })
    ws.onmessage = (ev) => {
      let data = String(ev.data)
      if (data.length <= MAX_FRAME) {
        const frame = JSON.parse(data)
        if (fault === "features" && frame.t === "req" && frame.req?.op === "diff") return ws.send(JSON.stringify({ t: "res", id: frame.id, ok: true, result: {} }))
        if (fault === "deliver.idempotent" && frame.t === "req" && frame.req?.op === "deliver") {
          frame.req.messageID = `${frame.req.messageID}.${++deliverRetry}`
          data = JSON.stringify(frame)
        }
        if (fault === "reconnect" && frame.t === "bye") return
        if (fault === "frames" && frame.t === "welcome" && !oversizeSent) {
          oversizeSent = true
          wrapped.onmessage?.({ data })
          const sessionID = firstSession() ?? "ses_cf0"
          return ws.send(JSON.stringify({ t: "event", event: { type: "session.status", data: { sessionID, status: { type: "idle" }, pad: "x".repeat(MAX_FRAME) } } }))
        }
      }
      wrapped.onmessage?.({ data })
    }
    return wrapped
  }
}
