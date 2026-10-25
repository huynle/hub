// The per-user Claude Code spoke daemon (decision fx04e42c point 4): one process per user, connected to the hub with
// the machine token (read-only from the spoke's config.json) as the machine's claude-code hooks service (evidence
// "hooks", kind "service"), serving the hook bridges, the wrapper and the MCP pipes of every Claude Code session on
// the machine over a Unix socket in a private directory. ClaudeSessions holds the sessions' state; this file wires
// it to the hub (HarnessSpoke: ops permission and stop, deliver, prompt messages, reject messages) and to the socket.
//
// A `hub claude` run registers its pid ("launch"); the daemon checks it now and then and ends the run's sessions
// when the process is gone (Claude Code killed without SessionEnd), and at once when the wrapper reports its exit.
import { chmodSync, lstatSync, unlinkSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import path from "node:path"
import { HarnessSpoke, type HarnessSpokeOptions } from "../../spoke-sdk/src/index.ts"
import { parseHookInput } from "./hook-input.ts"
import { ensurePrivateDir, SOCKET_PATH_MAX } from "./paths.ts"
import { ClaudeSessions, type SessionsOptions } from "./sessions.ts"
import { ask, onLines, WIRE_VERSION } from "./wire.ts"

export const HARNESS = "claude-code"
const DEFAULT_LIVENESS_MS = 30_000
const LAUNCHES_MAX = 1000

export interface DaemonOptions {
  readonly socketPath: string
  readonly server: string
  /** The machine token (never logged). */
  readonly token: string
  readonly harnessVersion: string
  readonly pluginVersion: string
  readonly directory: string
  readonly tokenWaitMs?: number
  readonly permissionWaitMs?: number
  /** How often launches' processes are checked (default 30 s). */
  readonly livenessIntervalMs?: number
  readonly references?: SessionsOptions["references"]
  readonly log?: (line: string) => void
  readonly socket?: HarnessSpokeOptions["socket"]
  readonly backoff?: HarnessSpokeOptions["backoff"]
}

export interface ClaudeDaemon {
  readonly state: HarnessSpoke["state"]
  readonly spoke: HarnessSpoke
  readonly sessions: ClaudeSessions
  stop(): Promise<void>
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

/** Takes the socket path: refuses when a daemon answers there, removes a stale socket file. */
async function claimSocket(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) throw new Error(`The socket path ${socketPath} is too long for a Unix socket (at most ${SOCKET_PATH_MAX} bytes); set HUB_CLAUDE_SOCKET to a shorter one`)
  ensurePrivateDir(path.dirname(socketPath))
  let exists = false
  try {
    lstatSync(socketPath)
    exists = true
  } catch {}
  if (!exists) return
  const reply = (await ask(socketPath, { v: WIRE_VERSION, kind: "ping" }, { timeoutMs: 1000 })) as { ok?: unknown } | undefined
  if (reply?.ok === true) throw new Error(`A Claude Code spoke daemon is already running on ${socketPath}`)
  unlinkSync(socketPath)
}

export async function startDaemon(options: DaemonOptions): Promise<ClaudeDaemon> {
  await claimSocket(options.socketPath)
  const log = options.log ?? (() => {})
  let sessions!: ClaudeSessions
  const spoke = new HarnessSpoke({
    server: options.server,
    token: options.token,
    harness: HARNESS,
    harnessVersion: options.harnessVersion,
    evidence: "hooks",
    pluginVersion: options.pluginVersion,
    directory: options.directory,
    kind: "service",
    mode: "always",
    handlers: { permission: (req) => sessions.permission(req), stop: (req) => sessions.stop(req) },
    deliver: (req) => sessions.deliver(req),
    features: ["permissionMessage", "hubPrompt"],
    onState: (state, error) => log(`hub connection ${state}${error ? `: ${error}` : ""}`),
    ...(options.socket ? { socket: options.socket } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
  })
  sessions = new ClaudeSessions({
    spoke,
    ...(options.tokenWaitMs !== undefined ? { tokenWaitMs: options.tokenWaitMs } : {}),
    ...(options.permissionWaitMs !== undefined ? { permissionWaitMs: options.permissionWaitMs } : {}),
    ...(options.references ? { references: options.references } : {}),
  })

  const launches = new Map<string, number>()
  const connections = new Set<Socket>()
  const reply = (conn: Socket, body: unknown) => {
    if (!conn.destroyed) conn.end(`${JSON.stringify(body)}\n`)
  }

  async function request(conn: Socket, req: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    switch (req.kind) {
      case "ping":
        return reply(conn, { ok: true, pid: process.pid, state: spoke.state })
      case "hook": {
        const input = parseHookInput(req.input)
        if (!input) return reply(conn, {})
        const launch = str(req.launch)
        const waitMs = typeof req.waitMs === "number" && Number.isFinite(req.waitMs) && req.waitMs >= 0 ? req.waitMs : undefined
        const answer = await sessions.hook(input, { ...(launch ? { launch } : {}), ...(req.rewake === true ? { rewake: true } : {}), ...(waitMs !== undefined ? { waitMs } : {}), signal })
        return reply(conn, answer)
      }
      case "launch": {
        const launch = str(req.launch)
        if (!launch || !Number.isInteger(req.pid) || (req.pid as number) <= 0) return reply(conn, { ok: false, error: "launch needs a launch ID and a pid" })
        launches.delete(launch)
        launches.set(launch, req.pid as number)
        while (launches.size > LAUNCHES_MAX) launches.delete(launches.keys().next().value!)
        return reply(conn, { ok: true })
      }
      case "exit": {
        const launch = str(req.launch)
        if (launch) {
          sessions.endLaunch(launch)
          launches.delete(launch)
        }
        return reply(conn, { ok: true })
      }
      default:
        return reply(conn, { ok: false, error: "unknown request" })
    }
  }

  const server: Server = createServer((conn) => {
    connections.add(conn)
    const abort = new AbortController()
    conn.on("close", () => {
      connections.delete(conn)
      abort.abort()
    })
    conn.on("error", () => {})
    let first = true
    onLines(conn, (text) => {
      if (!first) return
      first = false
      let req: unknown
      try {
        req = JSON.parse(text)
      } catch {
        return reply(conn, { ok: false, error: "not JSON" })
      }
      if (typeof req !== "object" || req === null || (req as { v?: unknown }).v !== WIRE_VERSION) return reply(conn, { ok: false, error: "unsupported request" })
      request(conn, req as Record<string, unknown>, abort.signal).catch((cause) => {
        log(`request failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        reply(conn, {})
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  chmodSync(options.socketPath, 0o600)

  // A launch whose process is gone: its sessions end (checked again each round; Claude Code may report late).
  const liveness = setInterval(() => {
    for (const [launch, pid] of launches) if (!alive(pid)) sessions.endLaunch(launch)
  }, options.livenessIntervalMs ?? DEFAULT_LIVENESS_MS)
  liveness.unref?.()

  spoke.start()
  let stopped = false
  return {
    get state() {
      return spoke.state
    },
    spoke,
    sessions,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(liveness)
      spoke.stop()
      for (const conn of connections) conn.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        unlinkSync(options.socketPath)
      } catch {}
    },
  }
}
