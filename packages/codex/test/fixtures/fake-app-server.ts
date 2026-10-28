#!/usr/bin/env bun
// A fake `codex app-server` for tests: the JSON-RPC methods and notifications the Codex spoke uses, shaped as Codex
// 0.160.0 sends them (spike v0hsdqhm, generate-json-schema), over stdio (one message per line, the default) or as a
// shared daemon on a Unix socket speaking WebSocket (--listen unix://PATH), where several clients share threads:
// notifications go to every subscribed client, approval requests too, and the first answer wins (the others get
// serverRequest/resolved).
//
// Turns: with FAKE_CODEX_MODEL_URL (an OpenAI-compatible base URL, e.g. the testkit stub model's openaiBaseURL) each
// turn asks the model (POST /responses, not streaming) until it answers without a function call; a function call is a
// commandExecution item, which asks approval unless the thread's approvalPolicy is "never" ("accept…" runs nothing
// but completes it, "decline"/"cancel" declines it, "cancel" also interrupts the turn). Without a model URL every
// turn answers "ack". SLOW:<ms> in a prompt holds the turn that long (for steer and interrupt tests).
//
//   bun fake-app-server.ts [app-server] [--listen stdio:// | unix://PATH] [-c …ignored]
import { randomUUID } from "node:crypto"
import { unlinkSync } from "node:fs"

type Send = (message: object) => void
interface Client {
  readonly id: number
  send: Send
  nextRequest: number
  readonly pending: Map<number, (result: any) => void>
}
interface Thread {
  readonly id: string
  readonly cwd: string
  name: string | null
  approvalPolicy: string
  readonly history: any[]
  readonly subscribers: Set<Client>
  turn?: { id: string; abort: AbortController; steered: string[] }
}

const argv = process.argv.slice(2)
const listenAt = argv.indexOf("--listen")
const listen = listenAt >= 0 ? argv[listenAt + 1]! : "stdio://"
const modelURL = process.env.FAKE_CODEX_MODEL_URL
const threads = new Map<string, Thread>()
let clients = 0
const now = () => Date.now()
/** A UUID that sorts by time, like Codex's UUIDv7 thread and turn IDs. */
const uuid7ish = () => {
  const u = randomUUID()
  return `${Date.now().toString(16).padStart(12, "0").slice(-8)}-${u.slice(9)}`
}

function broadcast(thread: Thread, method: string, params: object) {
  for (const c of thread.subscribers) c.send({ method, params })
}

function threadInfo(t: Thread) {
  const status = t.turn ? { type: "active", activeFlags: [] } : { type: "idle" }
  return { id: t.id, cwd: t.cwd, name: t.name, preview: t.history.find((h) => h.role === "user")?.content?.[0]?.text ?? "", status, turns: [] }
}

/** Asks every subscriber; the first answer wins, the others hear serverRequest/resolved. */
function askApproval(thread: Thread, method: string, params: object, signal: AbortSignal): Promise<any> {
  return new Promise((resolve) => {
    let done = false
    const asked: Array<[Client, number]> = []
    const finish = (result: any) => {
      if (done) return
      done = true
      for (const [c, rid] of asked) {
        c.pending.delete(rid)
        c.send({ method: "serverRequest/resolved", params: { threadId: thread.id, requestId: rid } })
      }
      resolve(result)
    }
    signal.addEventListener("abort", () => finish({ decision: "cancel" }), { once: true })
    for (const c of thread.subscribers) {
      const rid = c.nextRequest++
      asked.push([c, rid])
      c.pending.set(rid, finish)
      c.send({ method, id: rid, params })
    }
    if (!asked.length) finish({ decision: "decline" })
  })
}

async function model(thread: Thread): Promise<any[]> {
  if (!modelURL) return [{ type: "message", id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", content: [{ type: "output_text", text: "ack" }] }]
  const res = await fetch(`${modelURL.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "stub", input: thread.history, stream: false, tools: [{ type: "function", name: "exec_command" }] }),
  })
  const body: any = await res.json()
  return Array.isArray(body?.output) ? body.output : []
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

async function runTurn(thread: Thread, turnID: string, input: any[], clientId: string | null) {
  const abort = new AbortController()
  const turn = { id: turnID, abort, steered: [] as string[] }
  thread.turn = turn
  const tid = thread.id
  const text = input.map((i) => (i?.type === "text" ? i.text : "")).join("")
  broadcast(thread, "thread/status/changed", { threadId: tid, status: { type: "active", activeFlags: [] } })
  broadcast(thread, "turn/started", { threadId: tid, turn: { id: turnID, items: [], status: "inProgress", error: null } })
  const userItem = { type: "userMessage", id: randomUUID(), clientId, content: input }
  broadcast(thread, "item/started", { threadId: tid, turnId: turnID, item: userItem, startedAtMs: now() })
  broadcast(thread, "item/completed", { threadId: tid, turnId: turnID, item: userItem, completedAtMs: now() })
  thread.history.push({ type: "message", role: "user", content: [{ type: "input_text", text }] })
  let status = "completed"
  let error: object | null = null
  try {
    const slow = /SLOW:(\d+)/.exec(text)
    if (slow) await sleep(Number(slow[1]), abort.signal)
    for (let round = 0; round < 8 && !abort.signal.aborted; round++) {
      for (const s of turn.steered.splice(0)) thread.history.push({ type: "message", role: "user", content: [{ type: "input_text", text: s }] })
      const output = await model(thread)
      if (abort.signal.aborted) break
      let called = false
      for (const out of output) {
        if (out?.type === "message") {
          const said = (out.content ?? []).map((c: any) => c?.text ?? "").join("")
          const item = { type: "agentMessage", id: out.id ?? randomUUID(), text: said }
          broadcast(thread, "item/started", { threadId: tid, turnId: turnID, item: { ...item, text: "" }, startedAtMs: now() })
          broadcast(thread, "item/completed", { threadId: tid, turnId: turnID, item, completedAtMs: now() })
          thread.history.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: said }] })
        } else if (out?.type === "function_call") {
          called = true
          let args: any = {}
          try {
            args = JSON.parse(out.arguments ?? "{}")
          } catch {}
          const command = `/bin/bash -lc '${String(args.cmd ?? args.command ?? "true")}'`
          const item = { type: "commandExecution", id: out.call_id, command, cwd: thread.cwd, status: "inProgress", commandActions: [] }
          broadcast(thread, "item/started", { threadId: tid, turnId: turnID, item, startedAtMs: now() })
          let decision: any = "accept"
          if (thread.approvalPolicy !== "never") {
            broadcast(thread, "thread/status/changed", { threadId: tid, status: { type: "active", activeFlags: ["waitingOnApproval"] } })
            const answer = await askApproval(
              thread,
              "item/commandExecution/requestApproval",
              { threadId: tid, turnId: turnID, itemId: out.call_id, command, cwd: thread.cwd, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] },
              abort.signal,
            )
            decision = answer?.decision
            broadcast(thread, "thread/status/changed", { threadId: tid, status: { type: "active", activeFlags: [] } })
          }
          const accepted = typeof decision === "object" || String(decision).startsWith("accept")
          broadcast(thread, "item/completed", { threadId: tid, turnId: turnID, item: { ...item, status: accepted ? "completed" : "declined", exitCode: accepted ? 0 : null }, completedAtMs: now() })
          thread.history.push(out, { type: "function_call_output", call_id: out.call_id, output: accepted ? "ok" : "rejected by user" })
          if (decision === "cancel") abort.abort()
        }
      }
      if (!called && !turn.steered.length) break
    }
    if (abort.signal.aborted) status = "interrupted"
  } catch (cause) {
    status = "failed"
    error = { message: cause instanceof Error ? cause.message : String(cause) }
  }
  thread.turn = undefined
  broadcast(thread, "thread/status/changed", { threadId: tid, status: { type: "idle" } })
  broadcast(thread, "turn/completed", { threadId: tid, turn: { id: turnID, items: [], status, error } })
}

type Handler = (client: Client, params: any) => unknown
const err = (code: number, message: string) => Object.assign(new Error(message), { code })
const threadOf = (params: any) => {
  const t = threads.get(String(params?.threadId))
  if (!t) throw err(-32600, `thread not found: ${params?.threadId}`)
  return t
}
const threadResponse = (t: Thread) => ({ thread: threadInfo(t), approvalPolicy: t.approvalPolicy, cwd: t.cwd, model: "stub", modelProvider: "stub", sandbox: { type: "readOnly" }, approvalsReviewer: "user" })

const methods: Record<string, Handler> = {
  initialize: () => ({ userAgent: "fake-codex/0.160.0", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" }),
  // The account probes `hubctl setup verify` makes (provider-auth): a ChatGPT login whose live rate-limit read answers;
  // FAKE_CODEX_ACCOUNT=none reports no login.
  "account/read": () => (process.env.FAKE_CODEX_ACCOUNT === "none" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true }),
  "account/rateLimits/read": () => ({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } }),
  "thread/start": (client, p) => {
    const t: Thread = { id: uuid7ish(), cwd: p?.cwd ?? process.cwd(), name: null, approvalPolicy: p?.approvalPolicy ?? "untrusted", history: [], subscribers: new Set([client]) }
    threads.set(t.id, t)
    queueMicrotask(() => broadcast(t, "thread/started", { thread: threadInfo(t) }))
    return threadResponse(t)
  },
  "thread/resume": (client, p) => {
    const t = threadOf(p)
    t.subscribers.add(client)
    return threadResponse(t)
  },
  "thread/unsubscribe": (client, p) => (threadOf(p).subscribers.delete(client), {}),
  "thread/loaded/list": () => ({ data: [...threads.keys()], nextCursor: null }),
  "thread/name/set": (_c, p) => {
    const t = threadOf(p)
    t.name = String(p.name)
    broadcast(t, "thread/name/updated", { threadId: t.id, threadName: t.name })
    return {}
  },
  "thread/inject_items": (_c, p) => (threadOf(p).history.push(...(p.items ?? [])), {}),
  "thread/archive": (_c, p) => {
    const t = threadOf(p)
    broadcast(t, "thread/archived", { threadId: t.id })
    threads.delete(t.id)
    return {}
  },
  "turn/start": (_c, p) => {
    const t = threadOf(p)
    if (t.turn) throw err(-32600, "a turn is already running")
    const id = uuid7ish()
    void runTurn(t, id, p.input ?? [], p.clientUserMessageId ?? null)
    return { turn: { id, items: [], status: "inProgress", error: null } }
  },
  "turn/steer": (_c, p) => {
    const t = threadOf(p)
    if (!t.turn) throw err(-32600, "no active turn to steer")
    if (p.expectedTurnId !== t.turn.id) throw err(-32600, "expected turn does not match the active turn")
    const text = (p.input ?? []).map((i: any) => i?.text ?? "").join("")
    t.turn.steered.push(text)
    const item = { type: "userMessage", id: randomUUID(), clientId: p.clientUserMessageId ?? null, content: p.input }
    broadcast(t, "item/started", { threadId: t.id, turnId: t.turn.id, item, startedAtMs: now() })
    return { turnId: t.turn.id }
  },
  "turn/interrupt": (_c, p) => {
    const t = threadOf(p)
    if (t.turn && t.turn.id === p.turnId) t.turn.abort.abort()
    return {}
  },
}

function serve(send: Send): { receive(text: string): void; close(): void } {
  const client: Client = { id: ++clients, send, nextRequest: 0, pending: new Map() }
  return {
    receive(text) {
      let m: any
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (typeof m?.method === "string" && m.id !== undefined) {
        const handler = methods[m.method]
        if (!handler) return send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } })
        try {
          send({ id: m.id, result: handler(client, m.params) })
        } catch (e: any) {
          send({ id: m.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e) } })
        }
      } else if (m?.id !== undefined && ("result" in m || "error" in m)) {
        client.pending.get(m.id)?.(m.result ?? { decision: "decline" })
      }
    },
    close() {
      for (const t of threads.values()) t.subscribers.delete(client)
    },
  }
}

if (listen.startsWith("unix://")) {
  const socket = listen.slice("unix://".length)
  try {
    unlinkSync(socket)
  } catch {}
  const conns = new WeakMap<object, ReturnType<typeof serve>>()
  Bun.serve({
    unix: socket,
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 })),
    websocket: {
      open: (ws) => void conns.set(ws, serve((m) => ws.send(JSON.stringify(m)))),
      message: (ws, data) => conns.get(ws)?.receive(typeof data === "string" ? data : data.toString()),
      close: (ws) => conns.get(ws)?.close(),
    },
  })
  process.stdout.write(`listening on ${listen}\n`)
  const quit = () => {
    try {
      unlinkSync(socket)
    } catch {}
    process.exit(0)
  }
  process.on("SIGTERM", quit)
  process.on("SIGINT", quit)
} else {
  const conn = serve((m) => process.stdout.write(`${JSON.stringify(m)}\n`))
  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (line.trim()) conn.receive(line)
    }
  })
  process.stdin.on("end", () => process.exit(0))
}
