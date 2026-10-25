// `hub mcp`: a Model Context Protocol server on stdio (JSON-RPC 2.0, one JSON message per line), hand-written so
// the CLI keeps no dependencies. It answers initialize, ping, tools/list and tools/call; notifications get no answer.
import type { HubClient } from "../../sdk/src/index.ts"
import { sanitizeText } from "../../../src/central/agent/envelope"
import type { Credentials } from "./credentials"
import { logText, sessionsText, showText, statusText, whoamiText, whoText } from "./format"
import { CliError, withHub } from "./http"

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

type Args = Record<string, unknown>

/** A bad tool argument (an isError result, not a protocol error). */
class ArgError extends Error {}

const need = (args: Args, key: string): string => {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new ArgError(`"${key}" is required (a non-empty string)`)
  return value
}
const optional = (args: Args, key: string): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ArgError(`"${key}" must be a string`)
  return value.trim() ? value : undefined
}
const optionalInt = (args: Args, key: string, min: number, max: number): number | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ArgError(`"${key}" must be a whole number from ${min} to ${max}`)
  return value
}
const optionalStrings = (args: Args, key: string): string[] | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ArgError(`"${key}" must be a list of strings`)
  return value as string[]
}

const STRING = { type: "string" } as const
const ADDR = { type: "string", description: "A session: ses_… (or an unambiguous prefix), @name, @@role or @name.project." } as const

interface Tool {
  readonly name: string
  readonly description: string
  readonly properties: Record<string, unknown>
  readonly required?: readonly string[]
  readonly readOnly: boolean
  /** The text of the answer. */
  run(hub: HubClient, args: Args, signal: AbortSignal): Promise<string>
}

const TOOLS: readonly Tool[] = [
  {
    name: "whoami",
    description: "Who this hub credential is: the app token of `hub login` (or the session of HUB_SESSION_TOKEN) and its user.",
    properties: {},
    readOnly: true,
    run: async (hub, _args, signal) => whoamiText(await hub.whoami({ signal })),
  },
  {
    name: "status",
    description: "Machines → projects → sessions (name, state, harness, activity, blockers), and what needs attention.",
    properties: {},
    readOnly: true,
    run: async (hub, _args, signal) => statusText(await hub.status({ signal })),
  },
  {
    name: "sessions",
    description: "The sessions as a flat list, optionally filtered.",
    properties: {
      project: { ...STRING, description: "Only this project." },
      state: { ...STRING, description: "Only these states (comma-separated, e.g. busy,blocked)." },
      machine: { ...STRING, description: "Only this machine." },
      label: { type: "array", items: STRING, description: "key=value labels that must all match." },
    },
    readOnly: true,
    run: async (hub, args, signal) => {
      const body = await hub.sessions({ project: optional(args, "project"), state: optional(args, "state"), machine: optional(args, "machine"), label: optionalStrings(args, "label"), signal })
      return sessionsText(body.sessions ?? [])
    },
  },
  {
    name: "show",
    description: "One session: state, blockers, activity and its spoke's summary.",
    properties: { addr: ADDR },
    required: ["addr"],
    readOnly: true,
    run: async (hub, args, signal) => showText(await hub.show(need(args, "addr"), { signal })),
  },
  {
    name: "log",
    description: "A session's newest timeline rows, printed oldest first.",
    properties: { addr: ADDR, n: { type: "integer", minimum: 1, maximum: 200, description: "How many rows (the hub's default when unset)." } },
    required: ["addr"],
    readOnly: true,
    run: async (hub, args, signal) => {
      const addr = need(args, "addr")
      const n = optionalInt(args, "n", 1, 200)
      return logText((await hub.log(addr, { ...(n !== undefined ? { n } : {}), signal })).rows ?? [])
    },
  },
  {
    name: "who",
    description: "Named and role-holding sessions.",
    properties: { project: { ...STRING, description: "Only this project." }, role: { ...STRING, description: "Only holders of this role (reviewer or @@reviewer)." } },
    readOnly: true,
    run: async (hub, args, signal) => whoText((await hub.who({ project: optional(args, "project"), role: optional(args, "role"), signal })).sessions ?? []),
  },
]

const toolList = () =>
  TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: t.properties, ...(t.required ? { required: [...t.required] } : {}), additionalProperties: false },
    annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
  }))

/** A failure as the tool's text: `code: message`, candidates, missing feature, retry time, hint. */
function errorText(error: CliError): string {
  const envelope = error.envelope
  const lines = [envelope ? `${envelope.code}: ${error.message}` : error.message]
  const candidates = envelope?.candidates
  if (Array.isArray(candidates) && candidates.length) {
    lines.push("candidates:")
    for (const c of candidates as { sessionID?: string; name?: string; title?: string }[]) {
      lines.push(`  ${[c.sessionID, c.name ? `@${String(c.name).replace(/^@/, "")}` : undefined, c.title].filter(Boolean).join("  ")}`)
    }
  }
  if (typeof envelope?.feature === "string") lines.push(`missing feature: ${envelope.feature}${typeof envelope.harness === "string" ? ` (${envelope.harness})` : ""}`)
  if (typeof envelope?.retryAfter === "number") lines.push(`retry after ${Math.ceil(envelope.retryAfter)} s`)
  if (error.hint) lines.push(`hint: ${error.hint}`)
  return lines.join("\n")
}

/** Tool text as sent: control and invisible characters stripped, the token (should a hub echo it) redacted. */
const clean = (text: string, token: string | undefined) => {
  const safe = sanitizeText(text)
  return token ? safe.split(token).join("[redacted]") : safe
}

const toolResult = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError })

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

  const callTool = async (id: Id, params: Record<string, unknown>): Promise<RpcResponse> => {
    const tool = TOOLS.find((t) => t.name === params.name)
    if (!tool) return rpcError(id, RPC.invalidParams, typeof params.name === "string" ? `unknown tool: ${params.name}` : "params.name (the tool) is required")
    const args = params.arguments ?? {}
    if (!isObject(args)) return rpcError(id, RPC.invalidParams, "params.arguments must be an object")
    let token: string | undefined
    try {
      const credentials = options.credentials()
      token = credentials.token
      const signal = new AbortController().signal
      const text = await withHub(credentials, (hub) => tool.run(hub, args, signal))
      return ok(id, toolResult(clean(text, token), false))
    } catch (cause) {
      const text = cause instanceof ArgError ? `invalid: ${cause.message}` : cause instanceof CliError ? errorText(cause) : `${tool.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      return ok(id, toolResult(clean(text, token), true))
    }
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
        case "tools/list":
          return ok(id, { tools: toolList() })
        case "tools/call":
          return callTool(id, params)
        default:
          return rpcError(id, RPC.methodNotFound, `method not found: ${message.method}`)
      }
    },
  }
}
