// A WebSocket client over a Unix socket: the shared Codex daemon's control socket speaks WebSocket (HTTP Upgrade,
// then frames), so the spoke does the handshake and the framing itself (no TCP, no dependency).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { connectUnixWebSocket } from "../src/websocket.ts"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function server(onMessage: (ws: Bun.ServerWebSocket<unknown>, text: string) => void = (ws, text) => ws.send(`echo:${text}`)) {
  const dir = mkdtempSync(path.join(tmpdir(), "cx-ws-"))
  const socket = path.join(dir, "s.sock")
  const upgrades: Record<string, string>[] = []
  const opened: Bun.ServerWebSocket<unknown>[] = []
  const srv = Bun.serve({
    unix: socket,
    fetch(req, s) {
      { const h: Record<string, string> = {}; req.headers.forEach((v, k) => (h[k] = v)); upgrades.push(h) }
      return s.upgrade(req) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      open: (ws) => void opened.push(ws),
      message: (ws, message) => onMessage(ws, typeof message === "string" ? message : message.toString()),
    },
  })
  cleanup.push(() => {
    srv.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })
  return { socket, upgrades, opened }
}

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("connectUnixWebSocket", () => {
  test("upgrades over the Unix socket and exchanges text messages of every length class", async () => {
    const { socket, upgrades } = server()
    const channel = await connectUnixWebSocket(socket)
    cleanup.push(() => channel.close())
    const got: string[] = []
    channel.onMessage((t) => got.push(t))
    const sizes = [5, 200, 70_000]
    for (const n of sizes) channel.send("x".repeat(n))
    await until(() => got.length === sizes.length)
    expect(got.map((t) => t.length)).toEqual(sizes.map((n) => n + 5))
    expect(got[0]).toBe("echo:xxxxx")
    expect(upgrades[0]?.upgrade?.toLowerCase()).toBe("websocket")
  })

  test("unicode text survives framing", async () => {
    const { socket } = server()
    const channel = await connectUnixWebSocket(socket)
    cleanup.push(() => channel.close())
    const got: string[] = []
    channel.onMessage((t) => got.push(t))
    channel.send("héllo ✓ 🚀")
    await until(() => got.length === 1)
    expect(got[0]).toBe("echo:héllo ✓ 🚀")
  })

  test("the server closing ends the channel (onClose once)", async () => {
    const { socket, opened } = server()
    const channel = await connectUnixWebSocket(socket)
    const reasons: string[] = []
    channel.onClose((r) => reasons.push(r))
    await until(() => opened.length === 1)
    opened[0]!.close(1000, "bye")
    await until(() => reasons.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(reasons).toHaveLength(1)
  })

  test("closing from this side ends the channel", async () => {
    const { socket } = server()
    const channel = await connectUnixWebSocket(socket)
    const reasons: string[] = []
    channel.onClose((r) => reasons.push(r))
    channel.close()
    await until(() => reasons.length === 1)
  })

  test("a missing socket rejects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cx-ws-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    await expect(connectUnixWebSocket(path.join(dir, "none.sock"), { timeoutMs: 1000 })).rejects.toThrow()
  })

  test("a server that does not upgrade rejects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cx-ws-"))
    const socket = path.join(dir, "plain.sock")
    const srv = Bun.serve({ unix: socket, fetch: () => new Response("plain", { status: 404 }) })
    cleanup.push(() => {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    })
    await expect(connectUnixWebSocket(socket, { timeoutMs: 1000 })).rejects.toThrow(/upgrade|404/i)
  })
})
