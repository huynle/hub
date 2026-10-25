// The local protocol between the hook bridge (and the wrapper and the MCP pipe) and the per-user daemon: one JSON
// object per line over the daemon's Unix socket (in a 0700 directory, the socket itself 0600; no TCP, no HTTP).
// A client sends one request line; the daemon answers one reply line and closes, except for "mcp", after which both
// sides exchange JSON-RPC lines until either closes.
import { Socket } from "node:net"

export const WIRE_VERSION = 1
/** Longest line either side accepts (hook stdin can carry large tool inputs). */
export const MAX_LINE = 4 * 1024 * 1024

export type BridgeRequest =
  /** A hook: its stdin JSON, the `hub claude` run it belongs to, and how the hook was registered. */
  | { readonly v: 1; readonly kind: "hook"; readonly input: unknown; readonly launch?: string; readonly rewake?: true; readonly waitMs?: number }
  /** Is the daemon there? → {ok: true, pid, state}. */
  | { readonly v: 1; readonly kind: "ping" }
  /** A `hub claude` run started (its pid, checked for liveness) or ended. */
  | { readonly v: 1; readonly kind: "launch"; readonly launch: string; readonly pid: number }
  | { readonly v: 1; readonly kind: "exit"; readonly launch: string }
  /** The MCP pipe of a `hub claude` run: JSON-RPC lines follow in both directions. */
  | { readonly v: 1; readonly kind: "mcp"; readonly launch?: string }

/** Splits a stream into lines; a line longer than MAX_LINE ends the connection. */
export function onLines(socket: Socket, line: (text: string) => void, max = MAX_LINE): void {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (text.trim()) line(text)
    }
    if (buffer.length > max) socket.destroy()
  })
}

/**
 * Sends one request and resolves with the daemon's reply (parsed JSON), or undefined when there is no daemon, it
 * closed without a reply, answered something that is not JSON, or took longer than `timeoutMs`. Never rejects.
 */
export function ask(socketPath: string, req: BridgeRequest, options: { readonly timeoutMs?: number } = {}): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false
    // Listeners first: Bun reports a missing socket synchronously, inside connect().
    const socket = new Socket()
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => finish(undefined), options.timeoutMs)
    socket.on("error", () => finish(undefined))
    socket.on("close", () => finish(undefined))
    socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`))
    onLines(socket, (text) => {
      try {
        finish(JSON.parse(text))
      } catch {
        finish(undefined)
      }
    })
    try {
      socket.connect(socketPath)
    } catch {
      finish(undefined)
    }
  })
}
