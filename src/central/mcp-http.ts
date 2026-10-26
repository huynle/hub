// POST /mcp: the hub's MCP tools over MCP Streamable HTTP, for MCP clients and gateways (Brain decision txznll2f).
// Stateless: one JSON-RPC message per POST, answered as application/json (no SSE stream, no Mcp-Session-Id);
// notifications and client responses get 202. Batches are refused (-32600, as in protocol 2025-06-18).
//
// Auth: `Authorization: Bearer <token>`, any credential the agent API accepts (app, device, session and act
// tokens), checked up front with the agent API's resolver: none or invalid → 401 with `WWW-Authenticate: Bearer
// realm="hub"` (no OAuth resource metadata, so gateways detect plain bearer auth). The tools are `hub mcp`'s
// (packages/cli/src/mcp.ts) and call /api/agent with the caller's bearer, dispatched in process: scopes, grants,
// tenancy, kill switches and the audit are exactly the HTTP API's. A browser Origin other than the hub's own is
// refused (DNS rebinding); requests without one (servers, gateways) are fine. Tokens are never echoed.
import { createMcpServer, MCP_PROTOCOL_VERSIONS, NOT_FROM_USER, RPC, rpcError, type RpcResponse } from "../../packages/cli/src/mcp"
import { readCredentials } from "./agent/actor"

export const MCP_PATH = "/mcp"

/** Largest request body (bytes). */
export const MCP_MAX_BODY_BYTES = 1 << 20

export const MCP_INSTRUCTIONS =
  "Hub: see and steer your AI agent sessions. Tools read sessions (status, sessions, show, log, who), message them (msg, ask, reply, decline, inbox), act within your grants (approve, deny, answer, prompt, stop) and launch sessions (launch, launches, launch_show, launch_stop), as this bearer token. " +
  NOT_FROM_USER

export interface McpHttpDeps {
  /** The hub's public URL (the tools' base URL; requests never leave the process). */
  publicURL(): string
  /** Whether a request's Origin is the hub's own. */
  isOwnOrigin(origin: string): boolean
  /** Whether the agent API accepts this bearer token. */
  verify(token: string): Promise<boolean>
  /** The hub's own request handler (the tools' /api/agent calls). */
  dispatch(request: Request): Promise<Response>
  readonly version: string
  readonly maxBodyBytes?: number
}

const NO_STORE = { "cache-control": "no-store" }

const failure = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } })

const unauthorized = (message: string) => failure(401, "unauthorized", message, { "www-authenticate": 'Bearer realm="hub"' })

const answer = (response: RpcResponse) =>
  // A message the server could not take (parse error, not a request, a batch) carries no id: HTTP 400.
  Response.json(response, { status: response.error && response.id === null ? 400 : 200, headers: NO_STORE })

/** The body as text, or undefined when it is over `max` bytes (read no further). */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const length = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(length) && length > max) return undefined
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const acceptsJSON = (accept: string | null) => {
  if (accept === null || !accept.trim()) return true
  return accept.split(",").some((part) => {
    const type = part.split(";")[0]!.trim().toLowerCase()
    return type === "application/json" || type === "*/*" || type === "application/*"
  })
}

/** Answers a request to /mcp (any method). */
export function mcpHttp(deps: McpHttpDeps): (request: Request) => Promise<Response> {
  const max = deps.maxBodyBytes ?? MCP_MAX_BODY_BYTES
  return async (request) => {
    if (request.method !== "POST") return failure(405, "method_not_allowed", "POST JSON-RPC messages to /mcp (no SSE stream, no sessions)", { allow: "POST" })
    const origin = request.headers.get("origin")
    if (origin !== null && !deps.isOwnOrigin(origin)) return failure(403, "forbidden", "Cross-origin request refused")
    // The bearer only: a cookie never authenticates /mcp.
    const token = readCredentials(request, "").bearer
    if (token === undefined) return unauthorized("Send Authorization: Bearer <hub token>")
    if (!token || !(await deps.verify(token))) return unauthorized("Invalid, expired or revoked token")
    const version = request.headers.get("mcp-protocol-version")
    if (version !== null && !MCP_PROTOCOL_VERSIONS.includes(version)) return failure(400, "invalid", `Unsupported MCP-Protocol-Version (supported: ${MCP_PROTOCOL_VERSIONS.join(", ")})`)
    const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (type !== "application/json") return failure(415, "invalid", "Content-Type must be application/json")
    if (!acceptsJSON(request.headers.get("accept"))) return failure(406, "invalid", "Accept must allow application/json")
    const text = await readCapped(request, max)
    if (text === undefined) return failure(413, "invalid", `Request body over ${max} bytes`)
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return answer(rpcError(null, RPC.parse, "parse error: not JSON"))
    }
    const server = createMcpServer({
      credentials: () => ({ url: deps.publicURL(), token, source: "http", fetch: (input, init) => deps.dispatch(new Request(input, init)) }),
      version: deps.version,
      instructions: MCP_INSTRUCTIONS,
    })
    // The client went away: its tool calls are aborted.
    const close = () => server.close()
    request.signal.addEventListener("abort", close, { once: true })
    try {
      const response = await server.handle(message)
      return response ? answer(response) : new Response(null, { status: 202, headers: NO_STORE })
    } finally {
      request.signal.removeEventListener("abort", close)
      server.close()
    }
  }
}
