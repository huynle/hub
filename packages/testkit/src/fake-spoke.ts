// The client side of a spoke for hub tests: a real WebSocket to a hub's /spoke/ws that records every frame,
// hello/sessions frame builders, and a handshake helper (hello → welcome → sessions).
import { encode, PROTOCOL_VERSION, type Hello, type SessionInfo, type SpokeMessage, type Welcome } from "../../protocol/src/index.ts"

export interface FakeSpoke {
  ws: WebSocket
  /** Every frame the hub sent, parsed, in arrival order. */
  frames: any[]
  closed: Promise<{ code: number; reason: string }>
  send(message: SpokeMessage | Record<string, unknown> | string): void
  /** The next unread frame matching the predicate (each frame is returned at most once, in order). */
  next(predicate?: (frame: any) => boolean, timeoutMs?: number): Promise<any>
  /** Answers a server request with ok: true. */
  respond(id: string, result?: unknown): void
  /** Answers a server request with ok: false. */
  fail(id: string, error: string): void
  close(): void
}

export const helloFrame = (processID: string, extra: Partial<Hello> = {}): Hello => ({
  t: "hello",
  v: PROTOCOL_VERSION,
  processID,
  kind: "standalone",
  directory: "/work",
  pid: 1,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
  ...extra,
})

export const sessionInfo = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `title ${id}`,
  directory: "/work",
  updated: 1,
  owned: false,
  ...extra,
})

/** Opens a WebSocket to <base>/spoke/ws (base http(s):// or ws(s)://). Does not send hello. */
export async function connectSpoke(base: string, token?: string): Promise<FakeSpoke> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/spoke/ws`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as any)
  const frames: any[] = []
  const waiters: Array<() => void> = []
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)))
    for (const wake of waiters.splice(0)) wake()
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason })
      for (const wake of waiters.splice(0)) wake()
    }),
  )
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true })
  })
  let cursor = 0
  const send = (message: SpokeMessage | Record<string, unknown> | string) => ws.send(typeof message === "string" ? message : encode(message as SpokeMessage))
  return {
    ws,
    frames,
    closed,
    send,
    async next(predicate = () => true, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor++]
          if (predicate(frame)) return frame
        }
        if (ws.readyState === WebSocket.CLOSED) throw new Error("socket closed")
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for frame")
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, left)
        })
      }
    },
    respond: (id, result) => send({ t: "res", id, ok: true, ...(result === undefined ? {} : { result }) }),
    fail: (id, error) => send({ t: "res", id, ok: false, error }),
    close: () => ws.close(),
  }
}

/** Connects, sends hello, waits for the welcome and (when given) reports sessions. */
export async function fakeSpoke(
  base: string,
  options: { token?: string; hello?: Partial<Hello>; processID?: string; sessions?: SessionInfo[] } = {},
): Promise<FakeSpoke & { welcome: Welcome }> {
  const client = await connectSpoke(base, options.token)
  client.send(helloFrame(options.processID ?? "p1", options.hello))
  const welcome = (await client.next((f) => f.t === "welcome")) as Welcome
  if (options.sessions) client.send({ t: "sessions", sessions: options.sessions })
  return Object.assign(client, { welcome })
}
