// The daemon-backed MCP server (decision fx04e42c point 4): the plugin's .mcp.json runs `hub claude-code mcp`, a pipe
// between Claude Code's stdio and the daemon. The daemon answers with the hub CLI's MCP tools (packages/cli mcp.ts)
// as the session the `hub claude` run is in (HUB_CLAUDE_LAUNCH → its current session): act verbs (approve, deny,
// answer, prompt, stop) with the session's act token, every other verb with its session token. Both tokens stay in
// the daemon's memory: the MCP process never sees one. Without a daemon the pipe still speaks MCP and answers every
// tool call with an error, so Claude Code's MCP client does not hang or retry.
import { Socket } from "node:net"
import { createMcpServer, serveMcp, type McpServer } from "../../cli/src/mcp.ts"
import { CliError, EXIT } from "../../cli/src/http.ts"
import type { Credentials } from "../../cli/src/credentials.ts"
import { onLines, WIRE_VERSION, type BridgeRequest } from "./wire.ts"

type Token = { readonly token: string; readonly url?: string } | undefined

/** The pipe's last line: stdin ended (not JSON-RPC: it has no jsonrpc field). */
export const MCP_END = { hub: "end" } as const

/** Tools that act on another session: they need the act token (HUB_TOOL_ACT_VERBS in the OpenCode spoke). */
export const ACT_TOOLS: ReadonlySet<string> = new Set(["approve", "deny", "answer", "prompt", "stop"])

export interface McpRouterOptions {
  readonly version: string
  /** The hub session the MCP client belongs to, when known. */
  sessionID(): string | undefined
  sessionToken(sessionID: string): Token
  actToken(sessionID: string): Token
}

export interface McpRouter {
  handle(message: unknown): Promise<unknown>
  close(): void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** One MCP connection's handler in the daemon: two hub CLI MCP servers, one per credential, picked per tool call. */
export function createMcpRouter(options: McpRouterOptions): McpRouter {
  const credentials = (pick: (id: string) => Token, what: string) => (): Credentials => {
    const sessionID = options.sessionID()
    const token = sessionID === undefined ? undefined : pick(sessionID)
    if (!token?.url) throw new CliError(EXIT.unauthorized, `no ${what} for this Claude Code session: it is not a hub session (yet)`, "Start Claude Code with `hub claude` on an enrolled machine")
    return { url: token.url, token: token.token, source: "env" }
  }
  const shell: McpServer = createMcpServer({ version: options.version, credentials: credentials(options.sessionToken, "hub session token") })
  const act: McpServer = createMcpServer({ version: options.version, credentials: credentials(options.actToken, "hub session act token") })
  return {
    async handle(message) {
      if (isObject(message) && message.method === "tools/call" && isObject(message.params) && ACT_TOOLS.has(message.params.name as string)) return act.handle(message)
      if (isObject(message) && !("id" in message)) void act.handle(message) // notifications (cancellations) reach both
      return shell.handle(message)
    },
    close() {
      shell.close()
      act.close()
    },
  }
}

export interface McpPipeOptions {
  readonly input: AsyncIterable<Uint8Array | string>
  write(s: string): void
  readonly socketPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly version: string
  readonly signal?: AbortSignal
}

function connectTo(socketPath: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = new Socket()
    socket.once("error", () => resolve(undefined))
    socket.once("connect", () => resolve(socket))
    try {
      socket.connect(socketPath)
    } catch {
      resolve(undefined)
    }
  })
}

/** `hub claude-code mcp`: pipes stdio to the daemon until stdin ends (and the daemon answered) or the signal aborts. */
export async function runMcpPipe(options: McpPipeOptions): Promise<void> {
  const socket = await connectTo(options.socketPath)
  if (!socket) {
    const offline = (): Credentials => {
      throw new CliError(EXIT.unavailable, "the Claude Code spoke daemon is not running", "Start Claude Code with `hub claude` (it starts the daemon)")
    }
    await serveMcp({ input: options.input, write: options.write, log: () => {}, credentials: offline, version: options.version, ...(options.signal ? { signal: options.signal } : {}) })
    return
  }
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  socket.on("error", () => {})
  const launch = options.env.HUB_CLAUDE_LAUNCH
  const hello: BridgeRequest = { v: WIRE_VERSION, kind: "mcp", ...(launch ? { launch } : {}) }
  socket.write(`${JSON.stringify(hello)}\n`)
  onLines(socket, (line) => options.write(`${line}\n`))
  options.signal?.addEventListener("abort", () => socket.destroy(), { once: true })
  const iterator = options.input[Symbol.asyncIterator]()
  const stopped = new Promise<"stopped">((resolve) => socket.once("close", () => resolve("stopped")))
  for (;;) {
    const next = await Promise.race([iterator.next(), stopped])
    if (next === "stopped" || next.done) break
    if (!socket.destroyed) socket.write(next.value)
  }
  // Bun closes a half-closed Unix socket at once, so the end of stdin is a line of its own: the daemon answers the
  // calls in flight, then closes.
  if (!socket.destroyed) socket.write(`${JSON.stringify(MCP_END)}\n`)
  await closed
}
