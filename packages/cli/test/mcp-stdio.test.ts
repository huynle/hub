// `hub mcp` over a pipe: the CLI's TS source spawned with bun, MCP clients' newline-delimited JSON-RPC on stdin, a
// fake hub (Bun.serve). stdout carries protocol frames only; credentials come from the env or the login file.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts")

const hub = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const auth = request.headers.get("authorization")
    if (auth !== "Bearer hst1.env" && auth !== "Bearer hat_login") return Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 })
    if (url.pathname === "/api/agent/whoami") {
      const actor = auth === "Bearer hat_login" ? { kind: "app", tokenID: "tok_login", label: "mcp" } : { kind: "session", sessionID: "ses_env", machineID: "mch_1" }
      return Response.json({ actor, user: { id: "u1", name: "Huy" } })
    }
    if (url.pathname === "/api/agent/sessions/@slow") {
      await Bun.sleep(300)
      return Response.json({ id: "ses_slow", state: "idle" })
    }
    return Response.json({ error: { code: "not_found", message: `no session ${decodeURIComponent(url.pathname.split("/").pop() ?? "")}` } }, { status: 404 })
  },
})
afterAll(() => hub.stop(true))
const HUB_URL = `http://127.0.0.1:${hub.port}`

type Frame = { jsonrpc: string; id?: unknown; result?: any; error?: any }

/** Spawns `hub mcp`; send() writes raw text, lines are collected from stdout. */
function mcp(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, MAIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: mkdtempSync(path.join(tmpdir(), "hub-mcp-home-")), ...env },
  })
  const raw: string[] = []
  const stdout = (async () => {
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    for (let next = await reader.read(); !next.done; next = await reader.read()) raw.push(decoder.decode(next.value, { stream: true }))
  })()
  const stderr = new Response(proc.stderr).text()
  const lines = () => raw.join("").split("\n").filter(Boolean)
  const frames = (): Frame[] => lines().map((l) => JSON.parse(l))
  return {
    proc,
    send: (text: string) => {
      proc.stdin.write(text)
      proc.stdin.flush()
    },
    request: (id: number, method: string, params?: unknown) => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`)
      proc.stdin.flush()
    },
    async waitFor(id: unknown, ms = 4000): Promise<Frame> {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
        const found = frames().find((f) => f.id === id)
        if (found) return found
      }
      throw new Error(`no answer to ${JSON.stringify(id)}; stdout: ${raw.join("")}`)
    },
    async end() {
      proc.stdin.end()
      const code = await proc.exited
      await stdout
      return { code, stdout: raw.join(""), stderr: await stderr }
    },
  }
}

describe("hub mcp over stdio", () => {
  test("initialize → initialized → tools/list → tools/call → ping; unknown method; parse error; only frames on stdout", async () => {
    const s = mcp({ HUB_URL, HUB_SESSION_TOKEN: "hst1.env" })
    s.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    const init = await s.waitFor(1)
    expect(init.result.protocolVersion).toBe("2025-06-18")
    expect(init.result.serverInfo.name).toBe("hub")
    expect(init.result.capabilities.tools).toBeDefined()
    s.send(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n\n`)
    s.request(2, "tools/list")
    expect((await s.waitFor(2)).result.tools.map((t: any) => t.name)).toContain("ask")
    s.request(3, "tools/call", { name: "whoami", arguments: {} })
    const whoami = await s.waitFor(3)
    expect(whoami.result.isError).toBe(false)
    expect(whoami.result.content[0].text).toContain("session ses_env on machine mch_1")
    s.request(4, "ping")
    expect((await s.waitFor(4)).result).toEqual({})
    s.request(5, "prompts/list")
    expect((await s.waitFor(5)).error.code).toBe(-32601)
    s.send("{not json\n")
    expect((await s.waitFor(null)).error.code).toBe(-32700)
    const { code, stdout, stderr } = await s.end()
    expect(code).toBe(0)
    const lines = stdout.split("\n").filter(Boolean)
    expect(lines.length).toBe(6) // one answer per request, none for the notification
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe("2.0")
    expect(stderr).not.toContain("hst1.env")
  })

  test("frames split across writes and CRLF line ends are read whole", async () => {
    const s = mcp({ HUB_URL, HUB_SESSION_TOKEN: "hst1.env" })
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })
    s.send(frame.slice(0, 10))
    await Bun.sleep(50)
    s.send(`${frame.slice(10)}\r\n`)
    expect((await s.waitFor(9)).result).toEqual({})
    expect((await s.end()).code).toBe(0)
  })

  test("without HUB_* env, the login file's app token is used; hub errors are isError results", async () => {
    const config = mkdtempSync(path.join(tmpdir(), "hub-mcp-config-"))
    mkdirSync(path.join(config, "hub"))
    writeFileSync(path.join(config, "hub", "cli.json"), JSON.stringify({ url: HUB_URL, token: "hat_login" }))
    const s = mcp({ XDG_CONFIG_HOME: config })
    s.request(1, "tools/call", { name: "whoami" })
    expect((await s.waitFor(1)).result.content[0].text).toContain("app token tok_login (mcp)")
    s.request(2, "tools/call", { name: "show", arguments: { addr: "@ghost" } })
    const missing = await s.waitFor(2)
    expect(missing.error).toBeUndefined()
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content[0].text).toContain("not_found: no session @ghost")
    expect((await s.end()).code).toBe(0)
  })

  test("not logged in: the server still starts; calls are isError results saying how to log in", async () => {
    const s = mcp({ XDG_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), "hub-mcp-empty-")) })
    s.request(1, "tools/call", { name: "whoami" })
    const r = await s.waitFor(1)
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain("hub login")
    expect((await s.end()).code).toBe(0)
  })

  test("a call in flight when stdin closes is still answered before the server exits", async () => {
    const s = mcp({ HUB_URL, HUB_SESSION_TOKEN: "hst1.env" })
    s.request(1, "tools/call", { name: "show", arguments: { addr: "@slow" } })
    const { code, stdout } = await s.end()
    expect(code).toBe(0)
    expect(JSON.parse(stdout.trim()).result.content[0].text).toContain("ses_slow")
  })

  test("SIGTERM ends the server cleanly", async () => {
    const s = mcp({ HUB_URL, HUB_SESSION_TOKEN: "hst1.env" })
    s.request(1, "ping")
    await s.waitFor(1)
    s.proc.kill("SIGTERM")
    expect(await s.proc.exited).toBe(0)
  })
})
