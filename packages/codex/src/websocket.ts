// A minimal WebSocket client (RFC 6455) over a Unix socket. The shared Codex daemon listens on
// CODEX_HOME/app-server-control/app-server-control.sock and speaks WebSocket there (HTTP Upgrade → 101, then frames;
// spike v0hsdqhm), so the spoke does the handshake and the framing itself: text messages only, client frames masked,
// fragmented messages reassembled, pings answered, a close frame (or the socket ending) closes the channel.
import { createHash, randomBytes } from "node:crypto"
import { Socket } from "node:net"
import type { Channel } from "./jsonrpc.ts"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/** Largest message this client accepts (the daemon announces 16 MiB unfragmented). */
export const WS_MAX_MESSAGE = 16 * 1024 * 1024
const HEAD_MAX = 16 * 1024

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** One client frame (FIN set, masked). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const head = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | opcode
  if (length < 126) head[1] = 0x80 | length
  else if (length < 65_536) {
    head[1] = 0x80 | 126
    head.writeUInt16BE(length, 2)
  } else {
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = randomBytes(4)
  const body = Buffer.alloc(length)
  for (let i = 0; i < length; i++) body[i] = payload[i]! ^ mask[i & 3]!
  return Buffer.concat([head, mask, body])
}

export interface WebSocketOptions {
  /** For the connection and the upgrade (default 5 s). */
  readonly timeoutMs?: number
  /** The request path (default "/"). */
  readonly path?: string
}

/** Connects and upgrades; resolves with a channel of text messages, rejects when either fails. */
export function connectUnixWebSocket(socketPath: string, options: WebSocketOptions = {}): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64")
    const accept = createHash("sha1").update(key + GUID).digest("base64")
    // Listeners first: Bun reports a missing socket synchronously, inside connect() (quirk awi4wb9g).
    const socket = new Socket()
    let upgraded = false
    let head = Buffer.alloc(0)
    const fail = (error: Error) => {
      if (upgraded) return
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`No WebSocket upgrade from ${socketPath} within ${options.timeoutMs ?? 5000} ms`)), options.timeoutMs ?? 5000)
    socket.on("error", (error) => fail(error))
    socket.on("close", () => fail(new Error(`${socketPath} closed before the WebSocket upgrade`)))
    socket.on("connect", () => {
      socket.write(
        [`GET ${options.path ?? "/"} HTTP/1.1`, "Host: localhost", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
      )
    })
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) {
        if (head.length > HEAD_MAX) fail(new Error("The WebSocket upgrade response is too long"))
        return
      }
      const lines = head.subarray(0, end).toString("latin1").split("\r\n")
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1]
      const headers = new Map(lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()] as const))
      if (status !== "101") return fail(new Error(`No WebSocket upgrade from ${socketPath} (HTTP ${status ?? "?"})`))
      if (headers.get("sec-websocket-accept") !== accept) return fail(new Error(`Bad Sec-WebSocket-Accept from ${socketPath}`))
      upgraded = true
      clearTimeout(timer)
      socket.off("data", onHead)
      socket.removeAllListeners("close")
      socket.removeAllListeners("error")
      resolve(frameChannel(socket, head.subarray(end + 4)))
    }
    socket.on("data", onHead)
    try {
      socket.connect(socketPath)
    } catch (error) {
      fail(error as Error)
    }
  })
}

/** The channel over an upgraded socket; `rest` is what arrived after the upgrade response. */
function frameChannel(socket: Socket, rest: Buffer): Channel {
  const listeners: ((text: string) => void)[] = []
  const closers: ((reason: string) => void)[] = []
  let closed = false
  let buffer: Buffer = Buffer.from(rest)
  let fragments: Buffer[] = []
  let fragmentsLength = 0
  let fragmentText = false

  const finish = (reason: string) => {
    if (closed) return
    closed = true
    socket.destroy()
    for (const cb of closers) cb(reason)
  }
  const write = (opcode: number, payload: Buffer) => {
    if (!closed && !socket.destroyed) socket.write(encodeFrame(opcode, payload))
  }

  const parse = () => {
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0]! & 0x80) !== 0
      const opcode = buffer[0]! & 0x0f
      const masked = (buffer[1]! & 0x80) !== 0
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(WS_MAX_MESSAGE)) return finish("message too large")
        length = Number(big)
        offset = 10
      }
      if (length > WS_MAX_MESSAGE) return finish("message too large")
      const maskAt = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4)
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))
      }
      buffer = buffer.subarray(offset + length)
      switch (opcode) {
        case OP_PING:
          write(OP_PONG, Buffer.from(payload))
          break
        case OP_PONG:
          break
        case OP_CLOSE:
          write(OP_CLOSE, Buffer.from(payload.subarray(0, 2)))
          return finish(payload.length > 2 ? payload.subarray(2).toString("utf8") : "closed by the server")
        case OP_TEXT:
        case OP_BINARY:
        case OP_CONT: {
          if (opcode !== OP_CONT) {
            fragments = []
            fragmentsLength = 0
            fragmentText = opcode === OP_TEXT
          }
          fragments.push(Buffer.from(payload))
          fragmentsLength += payload.length
          if (fragmentsLength > WS_MAX_MESSAGE) return finish("message too large")
          if (fin) {
            const message = Buffer.concat(fragments)
            fragments = []
            fragmentsLength = 0
            if (fragmentText) for (const cb of listeners) cb(message.toString("utf8"))
          }
          break
        }
        default:
          return finish(`unknown WebSocket opcode ${opcode}`)
      }
    }
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    parse()
  })
  socket.on("close", () => finish("connection closed"))
  socket.on("error", (error) => finish(error.message))

  return {
    send(text) {
      if (closed) throw new Error("WebSocket closed")
      write(OP_TEXT, Buffer.from(text, "utf8"))
    },
    close() {
      if (closed) return
      write(OP_CLOSE, Buffer.from([0x03, 0xe8]))
      socket.end()
      finish("closed")
    },
    onMessage(cb) {
      listeners.push(cb)
      // Frames that came with the upgrade response wait for the first listener.
      if (listeners.length === 1 && buffer.length) parse()
    },
    onClose: (cb) => void closers.push(cb),
  }
}
