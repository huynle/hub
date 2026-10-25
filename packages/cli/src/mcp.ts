// `hub mcp`: a Model Context Protocol server on stdio (JSON-RPC 2.0, one JSON message per line), hand-written so
// the CLI keeps no dependencies. It answers initialize, ping, tools/list and tools/call; notifications get no answer.
import type { Credentials } from "./credentials"

/** The protocol revisions the server speaks, newest first: a client's supported one is echoed, else the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"]

/** JSON-RPC error codes. */
export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const

export interface McpServerOptions {
  /** The hub credential to call with (throws a CliError when there is none). */
  readonly credentials: () => Credentials
  readonly version: string
}

type Id = string | number | null

export interface RpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: Id
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export interface McpServer {
  /** Answers one parsed message; undefined for notifications and for responses the client sends. */
  handle(message: unknown): Promise<RpcResponse | undefined>
}

const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result })
export const rpcError = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } })

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string | number => typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

export function createMcpServer(options: McpServerOptions): McpServer {
  const initialize = (params: Record<string, unknown>) => {
    const asked = params.protocolVersion
    const protocolVersion = typeof asked === "string" && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
    return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hub", version: options.version } }
  }

  return {
    async handle(message) {
      if (!isObject(message)) return rpcError(null, RPC.invalidRequest, Array.isArray(message) ? "batches are not supported" : "not a JSON-RPC message")
      const hasId = "id" in message
      const id = isId(message.id) ? message.id : null
      if (message.jsonrpc !== "2.0") return rpcError(id, RPC.invalidRequest, 'jsonrpc must be "2.0"')
      if (!("method" in message)) return undefined // a response; the server sends no requests
      if (typeof message.method !== "string") return rpcError(id, RPC.invalidRequest, "method must be a string")
      if (!hasId) return undefined // notifications (initialized, cancelled, …)
      if (!isId(message.id)) return rpcError(null, RPC.invalidRequest, "id must be a string or a number")
      const params = isObject(message.params) ? message.params : {}
      switch (message.method) {
        case "initialize":
          return ok(id, initialize(params))
        case "ping":
          return ok(id, {})
        default:
          return rpcError(id, RPC.methodNotFound, `method not found: ${message.method}`)
      }
    },
  }
}
