// The Codex app-server spoke (P7-T7a; decision fx04e42c point 5 as corrected by spike v0hsdqhm): one HarnessSpoke
// (harness "codex", evidence "rpc", announcing turnEvents: every turn's end is Codex's own turn/completed) over
// CodexSessions and up to two app-server connections, each as one client among others:
//
// - "own": `codex app-server --listen stdio://`, started on the first create, for the threads the hub starts
//   (thread/start). It is a child of the spoke: when the spoke stops, so do those threads.
// - "daemon": the shared daemon's Unix socket (CODEX_HOME/app-server-control/app-server-control.sock, WebSocket
//   framing), when present. The TUI and the desktop app keep their threads there; the spoke lists the loaded threads
//   every pollMs (and on thread/started) and subscribes to each new one (thread/resume, excludeTurns). The spoke
//   never starts the daemon: it connects when the socket answers and tries again every pollMs when it does not.
//
// Nothing here writes Codex's files (CODEX_HOME): configuration goes in as -c overrides (codexArgs) and environment.
import { HarnessSpoke, type HarnessSpokeOptions } from "../../spoke-sdk/src/index.ts"
import { openAppServer, type AppServerConnection } from "./app-server.ts"
import type { RpcID } from "./jsonrpc.ts"
import { CodexSessions, type ThreadDescription } from "./sessions.ts"
import { spawnStdioChannel } from "./stdio.ts"
import { connectUnixWebSocket } from "./websocket.ts"

/** The words that start Codex's app-server on stdio (the spoke's own app-server, and `hubctl setup verify`). */
export const CODEX_APP_SERVER_ARGS: readonly string[] = Object.freeze(["app-server", "--listen", "stdio://"])

export const HARNESS = "codex"
export const DEFAULT_POLL_MS = 2000
const LIST_PAGES_MAX = 20
const METHOD_NOT_FOUND = -32601

export interface CodexSpokeOptions {
  readonly server: string
  /** The machine token (never logged). */
  readonly token: string
  readonly harnessVersion: string
  readonly pluginVersion: string
  readonly directory: string
  /** The codex executable (default "codex" on PATH, see main.ts). */
  readonly codexBin: string
  /** Arguments before `app-server` (tests: the fake app-server's script). */
  readonly codexBinArgs?: readonly string[]
  /** Arguments after `app-server --listen stdio://` (e.g. -c overrides). */
  readonly codexArgs?: readonly string[]
  /** The own app-server's whole environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The shared daemon's socket; absent: no daemon attach. */
  readonly daemonSocket?: string
  readonly pollMs?: number
  readonly threadDefaults?: Readonly<Record<string, unknown>>
  readonly turnTimeoutMs?: number
  readonly log?: (line: string) => void
  readonly socket?: HarnessSpokeOptions["socket"]
  readonly backoff?: HarnessSpokeOptions["backoff"]
}

export interface CodexSpoke {
  readonly spoke: HarnessSpoke
  readonly sessions: CodexSessions
  readonly daemonConnected: boolean
  stop(): Promise<void>
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)

export function startCodexSpoke(options: CodexSpokeOptions): CodexSpoke {
  const log = options.log ?? (() => {})
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  let stopped = false
  let own: Promise<AppServerConnection> | undefined
  let daemon: AppServerConnection | undefined
  let connecting = false
  let discovering = false
  const resuming = new Set<string>()

  const sessions: CodexSessions = new CodexSessions({
    spoke: { upsertSession: (info) => spoke.upsertSession(info), endSession: (id) => spoke.endSession(id), emit: (event) => spoke.emit(event) },
    createServer: () => ownServer(),
    ...(options.threadDefaults ? { threadDefaults: options.threadDefaults } : {}),
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    log,
  })

  const spoke = new HarnessSpoke({
    server: options.server,
    token: options.token,
    harness: HARNESS,
    harnessVersion: options.harnessVersion,
    evidence: "rpc",
    pluginVersion: options.pluginVersion,
    directory: options.directory,
    kind: "service",
    mode: "always",
    handlers: {
      turn: (req) => sessions.turn(req),
      steer: (req) => sessions.steer(req),
      interrupt: (req) => sessions.interrupt(req),
      stop: (req) => sessions.stop(req),
      permission: (req) => sessions.permission(req),
      create: (req) => sessions.create(req),
    },
    deliver: (req) => sessions.deliver(req),
    features: ["hubPrompt", "launch", "turnEvents"],
    onState: (state, error) => log(`hub connection ${state}${error ? `: ${error}` : ""}`),
    ...(options.socket ? { socket: options.socket } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
  })

  /** Routes a connection's notifications and server requests (`conn` is set once initialize answered). */
  function handlers(get: () => AppServerConnection | undefined, onThreadStarted?: (thread: unknown) => void) {
    return {
      onNotification(method: string, params: unknown) {
        const conn = get()
        if (!conn) return
        if (method === "thread/started" && onThreadStarted) onThreadStarted(isObj(params) ? params.thread : undefined)
        sessions.notification(conn, method, params)
      },
      onRequest(id: RpcID, method: string, params: unknown) {
        const conn = get()
        if (!conn) return
        if (sessions.serverRequest(conn, id, method, params)) return
        // On its own app-server the spoke is the only client: nobody else would answer.
        if (conn.name === "own") conn.peer.respondError(id, METHOD_NOT_FOUND, `The hub's Codex spoke does not handle ${method}`)
      },
    }
  }

  function ownServer(): Promise<AppServerConnection> {
    if (stopped) return Promise.reject(new Error("The Codex spoke is stopping"))
    own ??= (async () => {
      const child = spawnStdioChannel({
        command: options.codexBin,
        args: [...(options.codexBinArgs ?? []), ...CODEX_APP_SERVER_ARGS, ...(options.codexArgs ?? [])],
        env: options.env,
        log: (line) => log(`codex app-server: ${line}`),
      })
      let conn: AppServerConnection | undefined
      try {
        conn = await openAppServer(child.channel, { name: "own", clientVersion: options.pluginVersion, ...handlers(() => conn) })
      } catch (cause) {
        own = undefined
        child.channel.close()
        throw new Error(`Cannot start codex app-server (${options.codexBin}): ${message(cause)}`)
      }
      const opened = conn
      void opened.closed.then((reason) => {
        log(`own app-server closed: ${reason}`)
        sessions.connectionClosed(opened)
        own = undefined
      })
      return opened
    })()
    return own
  }

  async function resume(conn: AppServerConnection, threadID: string): Promise<void> {
    if (resuming.has(threadID) || sessions.hasThread(threadID)) return
    resuming.add(threadID)
    try {
      const res = await conn.request("thread/resume", { threadId: threadID, excludeTurns: true })
      const thread = isObj(res) && isObj(res.thread) ? (res.thread as unknown as ThreadDescription) : undefined
      if (thread && typeof thread.id === "string" && !conn.isClosed && daemon === conn) sessions.attach(conn, { ...thread, cwd: thread.cwd ?? (isObj(res) ? res.cwd : undefined) })
    } catch (cause) {
      log(`thread/resume ${threadID}: ${message(cause)}`)
    } finally {
      resuming.delete(threadID)
    }
  }

  async function discover(conn: AppServerConnection): Promise<void> {
    if (discovering) return
    discovering = true
    try {
      let cursor: string | undefined
      for (let page = 0; page < LIST_PAGES_MAX; page++) {
        const res = await conn.request("thread/loaded/list", cursor ? { cursor } : {})
        const ids: unknown[] = isObj(res) && Array.isArray(res.data) ? res.data : []
        await Promise.all(ids.filter((id): id is string => typeof id === "string").map((id) => resume(conn, id)))
        cursor = isObj(res) && typeof res.nextCursor === "string" ? res.nextCursor : undefined
        if (!cursor) break
      }
    } catch (cause) {
      if (!conn.isClosed) log(`thread/loaded/list: ${message(cause)}`)
    } finally {
      discovering = false
    }
  }

  async function connectDaemon(socketPath: string): Promise<void> {
    if (daemon || connecting || stopped) return
    connecting = true
    try {
      const channel = await connectUnixWebSocket(socketPath, { timeoutMs: Math.max(1000, pollMs) })
      let conn: AppServerConnection | undefined
      conn = await openAppServer(channel, {
        name: "daemon",
        clientVersion: options.pluginVersion,
        ...handlers(
          () => conn,
          (thread) => {
            if (conn && isObj(thread) && typeof thread.id === "string") void resume(conn, thread.id)
          },
        ),
      })
      if (stopped) return conn.close()
      const opened = conn
      daemon = opened
      log(`attached to the Codex daemon at ${socketPath}`)
      void opened.closed.then((reason) => {
        log(`Codex daemon connection closed: ${reason}`)
        sessions.connectionClosed(opened)
        if (daemon === opened) daemon = undefined
      })
    } catch {
      // No daemon (yet): try again at the next poll.
    } finally {
      connecting = false
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  if (options.daemonSocket) {
    const socketPath = options.daemonSocket
    const tick = async () => {
      await connectDaemon(socketPath)
      if (daemon && !stopped) await discover(daemon)
    }
    timer = setInterval(() => void tick(), pollMs)
    timer.unref?.()
    void tick()
  }

  spoke.start()
  return {
    spoke,
    sessions,
    get daemonConnected() {
      return daemon !== undefined
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      spoke.stop()
      daemon?.close()
      const pending = own
      own = undefined
      if (pending) {
        const conn = await pending.catch(() => undefined)
        conn?.close()
        if (conn) await Promise.race([conn.closed, new Promise((r) => setTimeout(r, 3000))])
      }
    },
  }
}
