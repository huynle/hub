// A fake OpenCode host for the REAL OpenCode spoke (src/spoke/spoke.ts, the plugin's Spoke class): what the plugin
// context gives the spoke (SpokeHost), with OpenCode's event shapes. Sessions are created by the "local user"; a
// prompt (typed, or the spoke's turn) and a woken hub message (synthetic, resume) run a turn: session.inbox.delivered
// for the inbox item, execution started, busy, the model, execution succeeded, idle. With a model (an OpenAI chat
// completions base URL, e.g. the testkit stub's openaiBaseURL) every tool call the model makes asks permission
// (permission.asked with its tool as source) and runs on once/always (tool.called, tool.success) or fails on reject
// (tool.failed); without a model each turn answers "ack". Like OpenCode, a permission request answers once (then
// "gone") and its reply is announced (permission.replied). Records what the spoke asked of it.
import type { SpokeHost } from "../../src/spoke/spoke"
import { EventQueue } from "../../packages/testkit/src/index.ts"

export type HostEvent = { type: string; data: Record<string, unknown> }

interface Session {
  readonly id: string
  title: string
  readonly directory: string
  busy: boolean
  turn?: AbortController
  readonly queue: Array<{ inboxID: string; text: string }>
  /** The session's messages as OpenCode's context returns them. */
  readonly messages: unknown[]
}

type Decision = "once" | "always" | "reject"

let counter = 0
const nextID = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36)}`

export interface FakeOpenCodeOptions {
  readonly directory: string
  readonly version?: string
  /** OpenAI chat completions base URL (…/v1); absent: every turn answers "ack". */
  readonly modelBaseURL?: string
}

export class FakeOpenCode {
  readonly events = new EventQueue<HostEvent>()
  readonly host: SpokeHost
  readonly sessions = new Map<string, Session>()
  /** Pending permission requests. */
  readonly permissions = new Map<string, { sessionID: string; resolve: (d: Decision) => void }>()
  readonly replies: Array<{ sessionID: string; requestID: string; decision: string; message?: string }> = []
  readonly admitted: Array<{ sessionID: string; id: string; text: string; resume: boolean; delivery: string }> = []
  readonly prompts: Array<{ sessionID: string; text: string }> = []
  readonly interrupts: string[] = []

  constructor(private readonly options: FakeOpenCodeOptions) {
    this.host = {
      directory: options.directory,
      opencodeVersion: options.version ?? "2.0.26",
      events: (signal) => this.events.iterate(signal),
      prompt: async (input) => {
        this.prompts.push({ sessionID: input.sessionID, text: input.text })
        const inboxID = input.id ?? nextID("msg")
        this.enqueue(input.sessionID, inboxID, input.text)
        return { id: inboxID }
      },
      synthetic: async (input) => {
        this.admitted.push({ sessionID: input.sessionID, id: input.id, text: input.text, resume: input.resume, delivery: input.delivery })
        const s = this.session(input.sessionID)
        if (input.resume && !s.busy) this.enqueue(input.sessionID, input.id, input.text)
        else {
          // Admitted now (OpenCode puts it in the inbox); the model sees it at its next step or turn.
          this.push("session.inbox.delivered", { sessionID: input.sessionID, inboxID: input.id })
          s.messages.push({ type: "user", text: input.text })
        }
        return { id: input.id }
      },
      context: async (sessionID) => this.session(sessionID).messages,
      getSession: async (id) => {
        const s = this.session(id)
        return { id, title: s.title, location: { directory: s.directory }, time: { updated: Date.now() } }
      },
      replyPermission: async (input) => {
        const pending = this.permissions.get(input.requestID)
        if (!pending || pending.sessionID !== input.sessionID) return "gone"
        this.permissions.delete(input.requestID)
        this.replies.push({ sessionID: input.sessionID, requestID: input.requestID, decision: input.decision, ...(input.message !== undefined ? { message: input.message } : {}) })
        pending.resolve(input.decision)
        return "replied"
      },
      interrupt: async (sessionID) => {
        this.interrupts.push(sessionID)
        this.sessions.get(sessionID)?.turn?.abort()
      },
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      hasAgent: async () => true,
      defaultAgent: async () => "build",
    }
  }

  push(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, data })
  }

  session(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }

  /** The local user opens a session (OpenCode's session.created). */
  createSession(options: { id?: string; title?: string; directory?: string } = {}): string {
    const id = options.id ?? `ses_oc${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
    const directory = options.directory ?? this.options.directory
    const title = options.title ?? "OpenCode session"
    this.sessions.set(id, { id, title, directory, busy: false, queue: [], messages: [] })
    this.push("session.created", { sessionID: id, title, location: { directory }, slug: id })
    return id
  }

  /** The local user types a prompt in the TUI. */
  type(sessionID: string, text: string): void {
    this.enqueue(sessionID, nextID("msg"), text)
  }

  /** OpenCode asks permission in the session (before a tool runs); the decision resolves once it is answered. */
  ask(sessionID: string, resource: string, source?: { messageID: string; id: string }): { id: string; decision: Promise<Decision> } {
    const id = nextID("per")
    const decision = new Promise<Decision>((resolve) => {
      this.permissions.set(id, { sessionID, resolve })
      this.push("permission.asked", { sessionID, id, action: "shell", resources: [resource], ...(source ? { source: { type: "tool", ...source } } : {}) })
    })
    void decision.then((reply) => this.push("permission.replied", { sessionID, requestID: id, reply }))
    return { id, decision }
  }

  /**
   * OpenCode schedules a retry of the session's run (OpenCode 2.2 publishes no session.status: only this, with the
   * provider's error, response body included, and when the next attempt runs).
   */
  retry(sessionID: string, options: { attempt?: number; at?: number; error?: Record<string, unknown> } = {}): void {
    this.push("session.retry.scheduled", {
      sessionID,
      assistantMessageID: nextID("msg"),
      attempt: options.attempt ?? 1,
      at: options.at ?? Date.now() + 5000,
      error: options.error ?? { type: "provider.rate-limit", message: "Rate limit reached", status: 429, response: { body: '{"error":"rate_limited"}' }, retryAfterMs: 5000 },
    })
  }

  /** The session's run fails with an OpenCode error (default: an exhausted quota, response body included). */
  fail(sessionID: string, error: Record<string, unknown> = { type: "provider.quota", message: "You exceeded your current quota", status: 429, response: { body: '{"error":"insufficient_quota"}' } }): void {
    this.push("session.execution.failed", { sessionID, error })
  }

  private enqueue(sessionID: string, inboxID: string, text: string): void {
    const s = this.session(sessionID)
    if (s.busy) {
      s.queue.push({ inboxID, text })
      return
    }
    void this.turn(s, inboxID, text)
  }

  private async turn(s: Session, inboxID: string, text: string): Promise<void> {
    const sessionID = s.id
    const abort = new AbortController()
    s.busy = true
    s.turn = abort
    this.push("session.inbox.delivered", { sessionID, inboxID })
    this.push("session.execution.started", { sessionID })
    this.push("session.status", { sessionID, status: { type: "busy" } })
    s.messages.push({ type: "user", id: inboxID, text })
    try {
      const answer = this.options.modelBaseURL ? await this.modelLoop(s, text, abort.signal) : "ack"
      const assistantMessageID = nextID("msg")
      this.push("session.text.ended", { sessionID, assistantMessageID, text: answer })
      s.messages.push({ type: "assistant", id: assistantMessageID, parentID: inboxID, content: [{ type: "text", text: answer }] })
      this.push("session.execution.succeeded", { sessionID })
    } catch (cause) {
      if (abort.signal.aborted) this.push("session.execution.interrupted", { sessionID, message: "Interrupted" })
      else this.push("session.execution.failed", { sessionID, error: { message: String(cause instanceof Error ? cause.message : cause).slice(0, 500) } })
    } finally {
      s.busy = false
      s.turn = undefined
      for (const [id, p] of this.permissions) {
        if (p.sessionID !== sessionID) continue
        this.permissions.delete(id)
        p.resolve("reject")
      }
      this.push("session.status", { sessionID, status: { type: "idle" } })
    }
    const next = s.queue.shift()
    if (next) void this.turn(s, next.inboxID, next.text)
  }

  private async modelLoop(s: Session, text: string, signal: AbortSignal): Promise<string> {
    const messages: Record<string, unknown>[] = [{ role: "user", content: text }]
    for (let step = 0; step < 8; step++) {
      const res = await fetch(`${this.options.modelBaseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer stub" },
        body: JSON.stringify({ model: "stub", stream: false, messages, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }] }),
        signal,
      })
      if (!res.ok) throw new Error(`model answered ${res.status}`)
      const reply = ((await res.json()) as any)?.choices?.[0]?.message
      const calls: any[] = Array.isArray(reply?.tool_calls) ? reply.tool_calls : []
      if (!calls.length) return typeof reply?.content === "string" ? reply.content : ""
      messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls })
      const messageID = nextID("msg")
      for (const call of calls) {
        let input: any = {}
        try {
          input = JSON.parse(call.function?.arguments ?? "{}")
        } catch {}
        const command = typeof input.command === "string" ? input.command : JSON.stringify(input)
        const id = String(call.id)
        const asked = this.ask(s.id, command, { messageID, id })
        const decision = await new Promise<Decision>((resolve, reject) => {
          void asked.decision.then(resolve)
          signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true })
        })
        if (decision === "reject") {
          this.push("session.tool.failed", { sessionID: s.id, id, error: "The user rejected permission to use this specific tool call." })
          messages.push({ role: "tool", tool_call_id: call.id, content: "rejected" })
          continue
        }
        this.push("session.tool.called", { sessionID: s.id, id, assistantMessageID: messageID, tool: "bash", input })
        this.push("session.tool.success", { sessionID: s.id, id, output: `ran: ${command}` })
        messages.push({ role: "tool", tool_call_id: call.id, content: `ran: ${command}` })
      }
    }
    return ""
  }
}
