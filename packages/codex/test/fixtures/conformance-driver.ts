#!/usr/bin/env bun
// The Codex spoke's conformance driver (testkit harness driver protocol). It starts a shared app-server daemon on a
// Unix socket in a throwaway directory and the Codex spoke in this process, attached to that daemon (as the per-user
// `hub codex-spoke serve` is). The driver then plays the local user's TUI on the daemon: createSession starts a
// thread there, prompt starts a turn, local interrupts it or answers its pending approval. The spoke finds the
// thread itself (thread/loaded/list → thread/resume), as it finds a real TUI's.
//
// By default the daemon and the spoke's own app-server are the fake (fake-app-server.ts) asking the suite's stub model
// (OpenAI Responses, through FAKE_CODEX_MODEL_URL). Nothing touches ~/.codex. stop and shutdown end every process
// this driver started.
//
//   hub-conformance spoke --driver "bun packages/codex/test/fixtures/conformance-driver.ts"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart, type LocalAction } from "../../../testkit/src/index.ts"
import { codexSessionID, codexThreadID } from "../../src/ids.ts"
import { JsonRpcPeer, type RpcID } from "../../src/jsonrpc.ts"
import { startCodexSpoke, type CodexSpoke } from "../../src/spoke.ts"
import { connectUnixWebSocket } from "../../src/websocket.ts"

const FAKE = path.join(import.meta.dir, "fake-app-server.ts")
const HARNESS_VERSION = "0.160.0"
/** What the spoke announces (spoke.ts). */
const FEATURES = ["actTokens", "create", "deliver", "hubPrompt", "interrupt", "launch", "permission", "sessionTokens", "steer", "stop", "turn", "turnEvents"]
/** The fake turns a function call into a commandExecution item, which asks approval on an "untrusted" thread. */
const PERMISSION_TOOL_CALL = { name: "exec_command", input: { cmd: "echo conformance" } }

const log = (line: string) => process.stderr.write(`[codex driver] ${line}\n`)

interface Running {
  readonly dir: string
  readonly daemon: ChildProcess
  readonly tui: JsonRpcPeer
  readonly spoke: CodexSpoke
  /** Active turn per thread (from turn/started, cleared on turn/completed). */
  readonly turns: Map<string, string>
  /** Approval requests the TUI saw and has not answered, per thread. */
  readonly approvals: Map<string, RpcID[]>
}

let running: Running | undefined
let stopping: Promise<void> | undefined

const started = () => {
  if (!running) throw new DriverError("not_started", "call start first")
  return running
}

async function startDaemon(dir: string, env: Record<string, string | undefined>): Promise<{ child: ChildProcess; socket: string }> {
  const socket = path.join(dir, "d.sock")
  const child = spawn(process.execPath, [FAKE, "app-server", "--listen", `unix://${socket}`], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
  child.stderr!.on("data", (d) => log(`daemon: ${String(d).trim()}`))
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve())
    child.once("exit", (code) => reject(new Error(`the fake daemon exited (${code})`)))
  })
  return { child, socket }
}

async function start(params: DriverStart): Promise<object> {
  if (running) throw new DriverError("started", "already started")
  if (params.model.format !== "responses") throw new DriverError("unsupported", `model format ${params.model.format}`)
  const dir = mkdtempSync(path.join(tmpdir(), "cx-conf-"))
  const env: Record<string, string | undefined> = { ...process.env, ...params.env, FAKE_CODEX_MODEL_URL: params.model.baseURL, CODEX_HOME: path.join(dir, "codex-home") }
  const { child: daemon, socket } = await startDaemon(dir, env)
  const turns = new Map<string, string>()
  const approvals = new Map<string, RpcID[]>()
  const tui = new JsonRpcPeer(await connectUnixWebSocket(socket), {
    onRequest(id, _method, p: any) {
      // The local user does not answer: the hub does (or local approve/deny does).
      const list = approvals.get(p?.threadId) ?? []
      list.push(id)
      approvals.set(p?.threadId, list)
    },
    onNotification(method, p: any) {
      if (method === "turn/started" && p?.turn?.id) turns.set(p.threadId, p.turn.id)
      if (method === "turn/completed") turns.delete(p?.threadId)
      if (method === "serverRequest/resolved") for (const [t, ids] of approvals) approvals.set(t, ids.filter((x) => x !== p?.requestId))
    },
  })
  await tui.request("initialize", { clientInfo: { name: "conformance-tui", version: "0" }, capabilities: { experimentalApi: true } })
  tui.notify("initialized")
  const spoke = startCodexSpoke({
    server: params.hubURL,
    token: params.token,
    harnessVersion: HARNESS_VERSION,
    pluginVersion: "conformance",
    directory: params.directory,
    codexBin: process.execPath,
    codexBinArgs: [FAKE],
    env,
    daemonSocket: socket,
    pollMs: 100,
    threadDefaults: { approvalPolicy: "untrusted" },
    backoff: { minMs: 50, maxMs: 200 },
    log,
  })
  running = { dir, daemon, tui, spoke, turns, approvals }
  return {}
}

function thread(sessionID: string): string {
  const id = codexThreadID(sessionID)
  if (!id) throw new DriverError("not_found", `${sessionID} is not a Codex session`)
  return id
}

async function local(sessionID: string, action: LocalAction): Promise<object> {
  const r = started()
  const threadID = thread(sessionID)
  if (action === "interrupt") {
    const turnId = r.turns.get(threadID)
    if (turnId) await r.tui.request("turn/interrupt", { threadId: threadID, turnId })
  } else if (action === "approve" || action === "deny") {
    const id = r.approvals.get(threadID)?.shift()
    if (id === undefined) throw new DriverError("not_found", "no pending approval")
    r.tui.respond(id, { decision: action === "approve" ? "accept" : "decline" })
  } else if (action === "exit") {
    await r.tui.request("thread/unsubscribe", { threadId: threadID }).catch(() => undefined)
  }
  return {}
}

function stop(): Promise<void> {
  stopping ??= (async () => {
    const r = running
    running = undefined
    if (!r) return
    await r.spoke.stop()
    r.tui.close()
    if (r.daemon.exitCode === null && r.daemon.signalCode === null) {
      const gone = new Promise((resolve) => r.daemon.once("exit", resolve))
      r.daemon.kill("SIGTERM")
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3000))])
      if (r.daemon.exitCode === null && r.daemon.signalCode === null) r.daemon.kill("SIGKILL")
    }
    rmSync(r.dir, { recursive: true, force: true })
  })().finally(() => (stopping = undefined))
  return stopping
}

serveDriver({
  describe: () => ({ protocol: DRIVER_PROTOCOL_VERSION, harness: "codex", harnessVersion: HARNESS_VERSION, evidence: "rpc", features: FEATURES, models: ["responses"] }),
  start,
  async createSession(params) {
    const r = started()
    const res: any = await r.tui.request("thread/start", { cwd: params?.directory ?? process.cwd(), approvalPolicy: "untrusted" })
    const threadID = res?.thread?.id
    if (typeof threadID !== "string") throw new DriverError("failed", "thread/start returned no thread")
    if (params?.prompt) await r.tui.request("turn/start", { threadId: threadID, input: [{ type: "text", text: params.prompt, text_elements: [] }] })
    return { sessionID: codexSessionID(threadID) }
  },
  async prompt(params) {
    const r = started()
    await r.tui.request("turn/start", { threadId: thread(params.sessionID), input: [{ type: "text", text: params.text, text_elements: [] }] })
    return {}
  },
  local: (params) => local(params.sessionID, params.action),
  permissionToolCall: () => PERMISSION_TOOL_CALL,
  stop: async () => (await stop(), {}),
  shutdown: () => stop(),
})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop().finally(() => process.exit(0)))
