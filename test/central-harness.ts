// Shared helpers for central server integration tests: a real server on port 0 and real WebSocket spokes.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central, type CentralOptions } from "../src/central/http"
import { encode, PROTOCOL_VERSION, type Hello, type SessionInfo, type SpokeMessage } from "../src/protocol"

export const PUBLIC = "http://voice.test"

export interface Harness extends Central {
  /** Cookie header value for a freshly paired device. */
  cookie: string
  api(pathname: string, init?: RequestInit & { json?: unknown; cookie?: string | null; origin?: string | null }): Promise<Response>
  notified: Array<{ kind: string; sessionID: string; title: string; body?: string }>
  /** HUB_STATE_DIR of this server (state.json lives there). */
  stateDir: string
}

export function webDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-web-"))
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>voice</title>")
  writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {})")
  writeFileSync(path.join(dir, "app.js"), "console.log(1)")
  writeFileSync(path.join(dir, "manifest.webmanifest"), "{}")
  return dir
}

export function harness(overrides: Partial<CentralOptions> & { env?: Record<string, string>; noDevice?: boolean } = {}): Harness {
  const { env, noDevice, ...rest } = overrides
  const notified: Harness["notified"] = []
  const config = centralConfig({
    HUB_PORT: "0",
    HUB_PUBLIC_URL: PUBLIC,
    HUB_STATE_DIR: mkdtempSync(path.join(tmpdir(), "voice-state-")),
    ...env,
  })
  const central = startCentral({
    config,
    webDir: webDir(),
    version: "9.9.9",
    speech: {
      transcribe: async (audio, format) => `heard ${audio.length} ${format}`,
      speak: async (text) => new TextEncoder().encode(`mp3:${text}`),
    },
    notifier: {
      notify: async (kind, sessionID, title, _detail, body) => {
        notified.push({ kind, sessionID, title, ...(body ? { body } : {}) })
        return 2
      },
    },
    ...rest,
  })
  const cookie = noDevice ? "" : `voice_device=${central.store.addDevice("test phone").token}`
  const api: Harness["api"] = (pathname, init = {}) => {
    const headers = new Headers(init.headers)
    const c = init.cookie === undefined ? cookie : init.cookie
    if (c) headers.set("cookie", c)
    const o = init.origin === undefined ? PUBLIC : init.origin
    if (o) headers.set("origin", o)
    let body = init.body
    if (init.json !== undefined) {
      headers.set("content-type", "application/json")
      body = JSON.stringify(init.json)
    }
    return fetch(`${central.url}${pathname}`, { ...init, headers, body, redirect: "manual" })
  }
  return Object.assign(central, { cookie, api, notified, stateDir: config.stateDir })
}

export const hello = (processID: string, extra: Partial<Hello> = {}): Hello => ({
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

export const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `title ${id}`,
  directory: "/work",
  updated: 1,
  owned: false,
  ...extra,
})

export interface FakeSpoke {
  ws: WebSocket
  frames: any[]
  closed: Promise<{ code: number; reason: string }>
  send(message: SpokeMessage | Record<string, unknown> | string): void
  next(predicate?: (frame: any) => boolean, timeoutMs?: number): Promise<any>
  close(): void
}

/** Opens a WebSocket to /spoke/ws. Does not send hello. */
export async function connect(central: Central, token: string | undefined): Promise<FakeSpoke> {
  const ws = new WebSocket(`${central.url.replace(/^http/, "ws")}/spoke/ws`, {
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
  return {
    ws,
    frames,
    closed,
    send: (message) => ws.send(typeof message === "string" ? message : encode(message as SpokeMessage)),
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
    close: () => ws.close(),
  }
}

/** Enrolled machine + connected spoke that completed hello/welcome and reported sessions. */
export async function spoke(
  central: Central,
  options: { machine?: { token: string }; hello?: Partial<Hello>; processID?: string; sessions?: SessionInfo[] } = {},
): Promise<FakeSpoke & { token: string }> {
  const token = options.machine?.token ?? central.store.addMachine("laptop").token
  const client = await connect(central, token)
  client.send(hello(options.processID ?? "p1", options.hello))
  await client.next((f) => f.t === "welcome")
  if (options.sessions) {
    client.send({ t: "sessions", sessions: options.sessions })
    await waitFor(() => options.sessions!.every((s) => central.registry.hasSession(s.id)))
  }
  return Object.assign(client, { token })
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(5)
  }
}

/** Reads SSE `data:` messages from a response body. */
export function sse(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    async next(predicate: (message: any) => boolean = () => true, timeoutMs = 2000): Promise<any> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let index: number
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n")
          if (!data) continue
          const message = JSON.parse(data)
          if (predicate(message)) return message
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for SSE message")
        const result = await Promise.race([
          reader.read(),
          Bun.sleep(left).then(() => ({ done: false, value: undefined, timeout: true }) as const),
        ])
        if ("timeout" in result) continue
        if (result.done) throw new Error("SSE stream ended")
        buffer += decoder.decode(result.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}
