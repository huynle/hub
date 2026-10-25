// Pod RPC (design §9, decision vkxkqiuf §5): ops for a spoke or node connection held by another pod travel as a
// Bus request on pod.<podID>.rpc. The serving pod runs the op on its own socket (with the same per-op timeout as a
// local request and a tenant re-check, see SpokeHub) and replies {ok, result} or {ok:false, error:{name, message}};
// the calling pod turns that back into SpokeError / NodeError / RequestTimeoutError / RequestTooLargeError, so
// callers cannot tell a remote connection from a local one. The Bus waits RPC_SLACK_MS longer than the op so the
// serving pod's own timeout answers first; a pod with no responder is gone (the connection is offline).
// Session-token and act-token pushes (LOCAL_ONLY_OPS) never cross the Bus: refused on both ends.
// Close notices (machine revoked, launch ended) are published to every pod, the sender included.
import type { NodeRequest, ServerRequest } from "../../protocol"
import { BusNoResponderError, BusTimeoutError, type Bus, type Unsubscribe } from "../backend/types"
import { NodeError, RequestTimeoutError, RequestTooLargeError, SpokeError } from "../spoke-ws"

/** How much longer the calling pod waits than the op's own timeout. */
export const RPC_SLACK_MS = 2_000
/** Ops that carry credentials for the spoke's shells and agents: sent only by the pod holding the connection. */
export const LOCAL_ONLY_OPS: ReadonlySet<string> = new Set(["sessionTokens", "actTokens"])
/** The topic a pod answers ops for its connections on. */
export const rpcTopic = (podID: string) => `pod.${podID}.rpc`
/** Close notices for every pod. */
export const CLOSE_TOPIC = "cluster.close"

/** An op for a connection on another pod; `tenant` is the user the calling pod acts for (checked there). */
export type RpcCall =
  | { readonly kind: "spoke"; readonly connID: string; readonly tenant: string; readonly req: ServerRequest }
  | { readonly kind: "node"; readonly connID: string; readonly tenant: string; readonly req: NodeRequest }

/** Disconnect a machine's sockets (revoked) or a launch's (ended) on every pod. */
export interface CloseNotice {
  readonly kind: "machine" | "launch"
  readonly id: string
  readonly reason: string
  /** The pod that published it. */
  readonly from: string
}

interface WireError {
  readonly name: string
  readonly message: string
}

type RpcReply = { readonly ok: true; readonly result?: unknown } | { readonly ok: false; readonly error: WireError }

export interface PodRpcOptions {
  readonly bus: Bus
  /** This pod (HUB_POD_ID). */
  readonly podID: string
}

export class PodRpc {
  readonly podID: string
  private readonly bus: Bus
  private readonly unsubscribes: Unsubscribe[] = []

  constructor(options: PodRpcOptions) {
    this.bus = options.bus
    this.podID = options.podID
  }

  /** Answers ops for this pod's connections with `handler` (its errors go back to the caller). */
  async serve(handler: (call: RpcCall) => Promise<unknown>): Promise<void> {
    const unsubscribe = await this.bus.serve(rpcTopic(this.podID), async (message): Promise<RpcReply> => {
      const call = message as RpcCall
      try {
        if (!isCall(call)) throw new SpokeError("Invalid pod RPC call")
        if (LOCAL_ONLY_OPS.has(call.req.op)) throw new SpokeError(`The ${call.req.op} op is not sent across pods`)
        return { ok: true, result: await handler(call) }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        return { ok: false, error: { name: error.name, message: error.message } }
      }
    })
    this.unsubscribes.push(unsubscribe)
  }

  /**
   * Runs an op on `pod`'s connection and resolves with its result. `timeoutMs` is the op's own timeout; `onGone`
   * is told when the pod has no responder (it is gone: forget its directory entry).
   */
  async call(pod: string, call: RpcCall, timeoutMs: number, options: { readonly onGone?: () => void } = {}): Promise<unknown> {
    if (LOCAL_ONLY_OPS.has(call.req.op)) throw new SpokeError(`The ${call.req.op} op is not sent across pods`)
    let reply: RpcReply
    try {
      reply = await this.bus.request<RpcReply>(rpcTopic(pod), call, { timeoutMs: timeoutMs + RPC_SLACK_MS })
    } catch (cause) {
      if (cause instanceof BusNoResponderError) {
        options.onGone?.()
        throw offline(call)
      }
      if (cause instanceof BusTimeoutError) throw timeout(call)
      throw failed(call, cause instanceof Error ? cause.message : String(cause))
    }
    if (reply?.ok === true) return reply.result
    if (reply?.ok === false && typeof reply.error?.message === "string") throw revive(call, reply.error)
    throw failed(call, "Invalid pod RPC reply")
  }

  /** Tells every pod (this one included) to close a machine's or a launch's sockets. */
  async publishClose(notice: Omit<CloseNotice, "from">): Promise<void> {
    await this.bus.publish(CLOSE_TOPIC, { ...notice, from: this.podID } satisfies CloseNotice)
  }

  async onClose(handler: (notice: CloseNotice) => void): Promise<void> {
    this.unsubscribes.push(
      await this.bus.subscribe(CLOSE_TOPIC, (message) => {
        const notice = message as CloseNotice
        if ((notice?.kind === "machine" || notice?.kind === "launch") && typeof notice.id === "string") handler(notice)
      }),
    )
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.unsubscribes.splice(0).map((unsubscribe) => unsubscribe()))
  }
}

function isCall(call: RpcCall | undefined): call is RpcCall {
  return (
    (call?.kind === "spoke" || call?.kind === "node") &&
    typeof call.connID === "string" &&
    typeof call.tenant === "string" &&
    typeof (call.req as { op?: unknown } | undefined)?.op === "string"
  )
}

const offline = (call: RpcCall): Error => (call.kind === "node" ? new NodeError("The node disconnected") : new SpokeError("OpenCode process disconnected"))
const timeout = (call: RpcCall): Error => (call.kind === "node" ? new RequestTimeoutError(call.req.op, "The node") : new RequestTimeoutError(call.req.op))
const failed = (call: RpcCall, message: string): Error => (call.kind === "node" ? new NodeError(message) : new SpokeError(message))

/** The serving pod's error as the class the caller would have got locally. */
function revive(call: RpcCall, wire: WireError): Error {
  let error: Error
  switch (wire.name) {
    case "RequestTimeoutError":
      error = new RequestTimeoutError(call.req.op)
      break
    case "RequestTooLargeError":
      error = new RequestTooLargeError(call.req.op)
      break
    case "SpokeError":
      error = new SpokeError(wire.message)
      break
    case "NodeError":
      error = new NodeError(wire.message)
      break
    default:
      error = failed(call, wire.message)
  }
  error.message = wire.message
  return error
}
