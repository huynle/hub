// Shared helpers for central server integration tests: a real server on port 0 and real WebSocket spokes.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central, type CentralOptions } from "../src/central/http"
import { type Hello, type SessionInfo } from "../src/protocol"
import { connectSpoke, helloFrame, sessionInfo, type FakeSpoke } from "../packages/testkit/src/index.ts"

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

export async function harness(overrides: Partial<CentralOptions> & { env?: Record<string, string>; noDevice?: boolean } = {}): Promise<Harness> {
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
      notify: async (kind, sessionID, title, body) => {
        notified.push({ kind, sessionID, title, ...(body ? { body } : {}) })
        return 2
      },
    },
    // Push endpoints in tests use reserved names (push.example); resolve every host to a public address.
    resolveHost: async () => ["93.184.215.14"],
    ...rest,
  })
  const cookie = noDevice ? "" : `voice_device=${(await central.store.addDevice("test phone")).token}`
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

// The client side of a spoke (frame builders and a recording WebSocket) lives in the testkit.
export const hello = helloFrame
export const session = sessionInfo
export type { FakeSpoke }

/** Opens a WebSocket to /spoke/ws. Does not send hello. */
export const connect = (central: Central, token: string | undefined): Promise<FakeSpoke> => connectSpoke(central.url, token)

/** Enrolled machine + connected spoke that completed hello/welcome and reported sessions. */
export async function spoke(
  central: Central,
  options: { machine?: { token: string }; hello?: Partial<Hello>; processID?: string; sessions?: SessionInfo[] } = {},
): Promise<FakeSpoke & { token: string }> {
  const token = options.machine?.token ?? (await central.store.addMachine("laptop")).token
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
          // Heartbeats (`event: ping`) are not messages.
          if (chunk.split("\n").some((line) => line.startsWith("event: "))) continue
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
