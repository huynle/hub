// runNode: the daemon's entry (`bun packages/node/src/main.ts`, the launchd and systemd units): reads config.json
// (credentials, read-only) and node.json, refuses to run unenrolled or without workspace roots, connects, and
// stops cleanly on a signal.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT_CONFIG, runNode } from "../src/run.ts"

let servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers) s.stop(true)
  servers = []
})

function fakeHub(features = ["harness", "messaging", "nodes"]) {
  const hellos: Record<string, unknown>[] = []
  const auth: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      auth.push(req.headers.get("authorization"))
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      message(ws, msg) {
        const frame = JSON.parse(String(msg))
        if (frame.t === "hello") {
          hellos.push(frame)
          ws.send(JSON.stringify({ t: "welcome", v: 1, machineID: "m1", publicURL: "http://x", features }))
        }
      },
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, hellos, auth }
}

function configDir(config: unknown, node?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-node-run-"))
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config))
  if (node !== undefined) writeFileSync(path.join(dir, "node.json"), JSON.stringify(node))
  return { HUB_SPOKE_CONFIG: path.join(dir, "config.json") }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met")
    await Bun.sleep(10)
  }
}

describe("runNode", () => {
  test("an unenrolled machine (no token in config.json) exits with a hint", async () => {
    const lines: string[] = []
    const code = await runNode({ env: configDir({ server: "http://127.0.0.1:1" }, { workspaceRoots: ["/tmp"] }), home: "/nowhere", log: (l) => lines.push(l), signal: AbortSignal.abort() })
    expect(code).toBe(1)
    expect(lines.join("\n")).toContain("not enrolled")
  })

  test("no workspace roots exits with EXIT_CONFIG and names node.json; node.json problems are logged", async () => {
    const lines: string[] = []
    const env = configDir({ server: "http://127.0.0.1:1", token: "mt" }, { workspaceRoots: ["relative"], slots: 0 })
    const code = await runNode({ env, home: "/nowhere", log: (l) => lines.push(l), signal: AbortSignal.abort() })
    expect(code).toBe(EXIT_CONFIG)
    const text = lines.join("\n")
    expect(text).toContain("node.json")
    expect(text).toContain("relative")
    expect(text).toContain("slots")
  })

  test("connects with the machine token, says hello as a node, and stops on abort", async () => {
    const hub = fakeHub()
    const controller = new AbortController()
    const lines: string[] = []
    const env = configDir({ server: hub.url, token: "mt_run" }, { workspaceRoots: [tmpdir()], slots: 3, labels: { gpu: "no" } })
    const done = runNode({ env, home: "/nowhere", log: (l) => lines.push(l), signal: controller.signal })
    await until(() => hub.hellos.length > 0 && lines.some((l) => l.includes("connected")))
    expect(hub.auth[0]).toBe("Bearer mt_run")
    expect(hub.hellos[0]).toMatchObject({ t: "hello", role: "node", capacity: { slots: 3 }, labels: { gpu: "no" }, workspaceRoots: [tmpdir().replace(/\/+$/, "")] })
    controller.abort()
    expect(await done).toBe(0)
    expect(lines.join("\n")).not.toContain("mt_run")
  })

  test("logs when the hub does not serve nodes", async () => {
    const hub = fakeHub(["harness", "messaging"])
    const controller = new AbortController()
    const lines: string[] = []
    const env = configDir({ server: hub.url, token: "mt" }, { workspaceRoots: [tmpdir()] })
    const done = runNode({ env, home: "/nowhere", log: (l) => lines.push(l), signal: controller.signal })
    await until(() => lines.some((l) => l.includes("does not serve nodes")))
    controller.abort()
    expect(await done).toBe(0)
  })
})
