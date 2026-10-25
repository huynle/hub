// An in-memory hub end for SpokeConnection (its `socket` option): records what the spoke sends and lets a test send
// server frames (welcome, requests, byes) without a server.
import { encode, parseSpokeMessage, PROTOCOL_VERSION, type ServerMessage, type ServerRequest, type SpokeMessage } from "../../protocol/src/index.ts"
import type { SocketLike } from "../src/index.ts"

export class FakeSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly raw: string[] = []
  closed = false
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string): void {
    this.raw.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  /** Frames the spoke sent, parsed. */
  get frames(): SpokeMessage[] {
    return this.raw.map((r) => parseSpokeMessage(r)).filter((m): m is SpokeMessage => m !== undefined)
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: encode(message) })
  }
  welcome(features: readonly string[] = ["harness", "messaging"]): void {
    this.deliver({ t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://hub.example", features })
  }
}

/** A socket factory that keeps every socket it made; `last` is the current one. */
export function fakeSockets() {
  const made: FakeSocket[] = []
  return {
    made,
    get last(): FakeSocket {
      return made.at(-1)!
    },
    factory: (url: string, headers: Record<string, string>) => {
      const socket = new FakeSocket(url, headers)
      made.push(socket)
      return socket
    },
  }
}

let next = 0
/** Sends a server request on `socket` and resolves with the spoke's res frame. */
export async function call(socket: FakeSocket, req: ServerRequest): Promise<{ ok: boolean; result?: any; error?: string }> {
  const id = `h${++next}`
  socket.deliver({ t: "req", id, req })
  for (let i = 0; i < 200; i++) {
    const res = socket.frames.find((f) => f.t === "res" && f.id === id)
    if (res && res.t === "res") return res
    await Bun.sleep(1)
  }
  throw new Error(`no answer to ${req.op}`)
}
