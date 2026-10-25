// One initialized connection to a Codex app-server: JSON-RPC over a channel, the initialize handshake (with the
// experimental API, which thread/inject_items and turn/steer's clientUserMessageId need) and the client's name.
import { JsonRpcPeer, type Channel, type PeerHandlers, type RpcID } from "./jsonrpc.ts"
import type { AppServerPort } from "./sessions.ts"

export interface AppServerConnection extends AppServerPort {
  readonly peer: JsonRpcPeer
  /** Resolves with the reason when the connection closed. */
  readonly closed: Promise<string>
  readonly isClosed: boolean
  close(): void
}

export interface OpenOptions extends PeerHandlers {
  /** The connection's name (keeps its JSON-RPC request IDs apart from another connection's). */
  readonly name: string
  readonly clientVersion: string
  readonly timeoutMs?: number
}

const INIT_TIMEOUT_MS = 20_000

/** Opens the connection: initialize, then the initialized notification. Closes the channel when that fails. */
export async function openAppServer(channel: Channel, options: OpenOptions): Promise<AppServerConnection> {
  const peer = new JsonRpcPeer(channel, options)
  try {
    await peer.request("initialize", { clientInfo: { name: "hub", title: "Hub", version: options.clientVersion }, capabilities: { experimentalApi: true } }, { timeoutMs: options.timeoutMs ?? INIT_TIMEOUT_MS })
  } catch (cause) {
    peer.close()
    throw cause
  }
  peer.notify("initialized")
  return {
    name: options.name,
    peer,
    closed: peer.closed,
    get isClosed() {
      return peer.isClosed
    },
    request: (method: string, params?: unknown) => peer.request(method, params),
    respond: (id: RpcID, result: unknown) => peer.respond(id, result),
    close: () => peer.close(),
  }
}
