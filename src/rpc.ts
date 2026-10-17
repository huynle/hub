import { Rpc } from "@opencode/plugin/rpc"

// Server-side methods the /hub dialog calls. All of them act on this machine's spoke.
// RPC id "hub"; opencode-voice (<= 0.4) used "voice". The TUI and server plugins ship together in this
// package, so they always agree; the server also registers the same methods under the legacy id
// (VoiceRpc) for any other client still built against opencode-voice.

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const str = { type: "string" } as const
const bool = { type: "boolean" } as const
const num = { type: "number" } as const
const empty = obj({})
const errorData = { type: "object" } as const

/**
 * not_connected: no live connection · invalid: bad input · unreachable: server could not be reached ·
 * unavailable: spoke not running in this process · server_error: the hub refused the request.
 */
const errors = {
  not_connected: errorData,
  invalid: errorData,
  unreachable: errorData,
  unavailable: errorData,
  server_error: errorData,
} as const

const methods = {
  status: {
    input: obj({ sessionID: str }),
    output: {
      type: "object",
      properties: {
        server: str,
        mode: { type: "string", enum: ["off", "always", "session"] },
        enrolled: bool,
        connection: { type: "string", enum: ["off", "connecting", "connected", "revoked", "error"] },
        lastError: str,
        sessionExposed: bool,
        conversation: bool,
        enrollment: { type: "string", enum: ["pending", "approved", "denied", "expired", "error"] },
        machineName: str,
        kind: { type: "string", enum: ["service", "standalone"] },
        localHub: str,
      },
      required: ["server", "mode", "enrolled", "connection", "machineName", "kind"],
      additionalProperties: false,
    },
    errors,
  },
  setServer: { input: obj({ server: str }, ["server"]), output: empty, errors },
  /** GET <server>/healthz from this machine: reachable and a Hub? */
  checkServer: { input: obj({ server: str }, ["server"]), output: obj({ ok: bool, version: str, error: str }, ["ok"]), errors },
  /** Start the local hub for the configured loopback server now (Open hub). */
  startLocalHub: { input: empty, output: obj({ status: { type: "string", enum: ["started", "running", "busy"] } }, ["status"]), errors },
  enroll: {
    input: empty,
    output: obj(
      { userCode: str, approveURL: str, autoApproved: bool, localHub: { type: "string", enum: ["started", "running", "busy"] } },
      ["userCode", "approveURL"],
    ),
    errors,
  },
  setMode: { input: obj({ mode: { type: "string", enum: ["off", "always", "session"] } }, ["mode"]), output: empty, errors },
  setSession: { input: obj({ sessionID: str, on: bool }, ["sessionID", "on"]), output: empty, errors },
  pairCode: { input: empty, output: obj({ code: str, url: str, expiresAt: num }, ["code", "url", "expiresAt"]), errors },
  handoff: { input: obj({ sessionID: str }, ["sessionID"]), output: obj({ notified: num }, ["notified"]), errors },
  /** One-time sign-in link: the session's page, or the home page without sessionID. */
  /** voice: land on the session with Voice mode starting (`/s/<id>?voice=1`). */
  openLink: { input: obj({ sessionID: str, voice: bool }), output: obj({ url: str }, ["url"]), errors },
  /**
   * TUI presence: the sessions this TUI shows (route root and open tabs), sent on change and every 15 s.
   * `reporter` identifies the TUI; each report replaces its previous one.
   */
  presence: {
    input: obj({ sessionIDs: { type: "array", items: str, maxItems: 200 }, reporter: str }, ["sessionIDs"]),
    output: empty,
    errors,
  },
  /** Conversation mode for a session in this process (same path as the server's "conversation" op). */
  conversation: { input: obj({ sessionID: str, on: bool }, ["sessionID", "on"]), output: obj({ agent: str }, ["agent"]), errors },
} as const

export const HubRpc = Rpc.define({ id: "hub", methods, events: {} })

/** @deprecated The opencode-voice RPC id ("voice"); same methods as HubRpc. */
export const VoiceRpc = Rpc.define({ id: "voice", methods, events: {} })
