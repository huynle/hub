// A deny-all HTTP/HTTPS proxy on loopback for live harness tests. Harnesses phone home even with base-URL overrides
// (Claude Code: downloads.claude.ai; Codex: chatgpt.com, github.com …; spike report v0hsdqhm), so live tests point
// HTTP(S)_PROXY here: every CONNECT and plain proxy request is refused (403) before any outbound connection, and the
// attempted host is recorded. It never dials out.
import net from "node:net"

export interface ProxyAttempt {
  /** CONNECT, GET …; "" when the request line did not parse. */
  readonly method: string
  /** The request target: host:port for CONNECT, the absolute URL otherwise. */
  readonly target: string
  readonly host: string
  readonly port: number | undefined
  readonly at: number
}

export interface DenyProxy {
  /** http://127.0.0.1:<port> */
  url: string
  port: number
  attempts: ProxyAttempt[]
  /** Attempted hosts, each once, in first-seen order. */
  hosts(): string[]
  /** HTTP(S)_PROXY / ALL_PROXY (both cases) pointing here, and NO_PROXY exempting loopback (stub servers). */
  env(): Record<string, string>
  stop(): Promise<void>
}

const NO_PROXY = "127.0.0.1,localhost,::1"
const HEAD_MAX = 16_384

function parseTarget(line: string): Omit<ProxyAttempt, "at"> {
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line)
  if (!match) return { method: "", target: line.slice(0, 200), host: "", port: undefined }
  const [, method, target] = match as unknown as [string, string, string]
  if (method === "CONNECT") {
    const at = target.lastIndexOf(":")
    const host = (at > 0 ? target.slice(0, at) : target).replace(/^\[|\]$/g, "")
    const port = at > 0 ? Number(target.slice(at + 1)) : undefined
    return { method, target, host, port: Number.isFinite(port) ? port : undefined }
  }
  try {
    const url = new URL(target)
    return { method, target, host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 }
  } catch {
    return { method, target, host: "", port: undefined }
  }
}

const reply = (status: string) => `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\nProxy-Agent: hub-testkit-deny\r\n\r\n`

export function denyProxy(options: { port?: number } = {}): Promise<DenyProxy> {
  const attempts: ProxyAttempt[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let head = ""
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1")
      const end = head.indexOf("\r\n\r\n")
      if (end < 0 && head.length < HEAD_MAX) return
      socket.off("data", onData)
      const attempt = parseTarget(head.split("\r\n")[0] ?? "")
      attempts.push({ ...attempt, at: Date.now() })
      socket.end(reply(attempt.method ? "403 Forbidden" : "400 Bad Request"))
    }
    socket.on("data", onData)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      const url = `http://127.0.0.1:${port}`
      resolve({
        url,
        port,
        attempts,
        hosts: () => [...new Set(attempts.map((a) => a.host).filter(Boolean))],
        env: () => ({
          HTTPS_PROXY: url,
          HTTP_PROXY: url,
          ALL_PROXY: url,
          https_proxy: url,
          http_proxy: url,
          all_proxy: url,
          NO_PROXY,
          no_proxy: NO_PROXY,
        }),
        stop: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}
