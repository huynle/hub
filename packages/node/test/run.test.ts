// runNode: the daemon's entry (`bun packages/node/src/main.ts`, the launchd and systemd units): reads config.json
// (credentials, read-only) and node.json, refuses to run unenrolled or without workspace roots, connects, and
// stops cleanly on a signal.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sandboxName } from "../../runtime-openshell/src/runtime.ts"
import { createFakeOpenShell, type FakeOpenShell } from "../../runtime-openshell/test/fake-openshell.ts"
import { EXIT_CONFIG, runNode } from "../src/run.ts"

let servers: { stop(force?: boolean): void }[] = []
const fakes: FakeOpenShell[] = []
afterEach(() => {
  for (const s of servers) s.stop(true)
  servers = []
  for (const f of fakes.splice(0)) f.cleanup()
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

  test("the host runtime offers the harnesses found here: claude-code with `claude` on PATH, node.json overriding", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "hub-node-bin-"))
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n")
    chmodSync(path.join(bin, "claude"), 0o755)
    const hostHarnesses = async (node: Record<string, unknown>) => {
      const hub = fakeHub()
      const controller = new AbortController()
      const env = { ...configDir({ server: hub.url, token: "mt" }, { workspaceRoots: [tmpdir()], ...node }), PATH: bin }
      const done = runNode({ env, home: "/nowhere", log: () => {}, signal: controller.signal })
      await until(() => hub.hellos.length > 0)
      controller.abort()
      expect(await done).toBe(0)
      return (hub.hellos[0]!.runtimes as { kind: string; harnesses: string[] }[]).find((r) => r.kind === "host")?.harnesses
    }
    expect(await hostHarnesses({})).toEqual(["opencode", "claude-code"])
    expect(await hostHarnesses({ harnesses: { "claude-code": false } })).toEqual(["opencode"])
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

describe("runNode with openshell", () => {
  function openshellFake() {
    const fake = createFakeOpenShell()
    fakes.push(fake)
    const name = sandboxName("l_left")
    fake.update((s) => {
      s.sandboxes[`hub/${name}`] = { id: "x", name, workspace: "hub", labels: { "hub.launch": "l_left", "hub.machine": "m1" }, phase: "Ready", pendingGets: 0, createdAt: "2026-10-25T00:00:00Z", providers: [], env: {}, command: [], exitCode: null }
      s.sandboxes["hub/demo"] = { id: "y", name: "demo", workspace: "hub", labels: {}, phase: "Ready", pendingGets: 0, createdAt: "2026-10-25T00:00:00Z", providers: [], env: {}, command: [], exitCode: null }
    })
    return { fake, name }
  }

  test("enabled: offers the openshell runtime with its profiles and backends, announces sandbox, reports this machine's sandboxes", async () => {
    const hub = fakeHub()
    const { fake, name } = openshellFake()
    const controller = new AbortController()
    const lines: string[] = []
    const env = { ...configDir({ server: hub.url, token: "mt", machineID: "m1" }, { workspaceRoots: [tmpdir()], openshell: { enabled: true, gateway: "lab", profiles: { web: {} } } }), PATH: process.env.PATH, HUB_CLAUDE_BIN: "/nonexistent/claude", HUB_CODEX_BIN: "/nonexistent/codex" }
    const done = runNode({ env, home: "/nowhere", log: (l) => lines.push(l), signal: controller.signal, openshellBinary: fake.binary })
    await until(() => hub.hellos.length > 0)
    const hello = hub.hellos[0]!
    expect(hello.features).toEqual(["sandbox"])
    expect(hello.runtimes).toEqual([
      { kind: "host", harnesses: ["opencode"] },
      { kind: "openshell", harnesses: ["opencode"], profiles: ["default", "web"], backends: ["vm"] },
    ])
    expect(hello.launches).toEqual([{ launchID: "l_left", phase: "running", sandbox: name }])
    expect(fake.calls().every((c) => c.workspace === "hub" && c.gateway === "lab")).toBe(true)
    expect(fake.sandbox("demo")).toBeDefined()
    controller.abort()
    expect(await done).toBe(0)
    expect(lines.join("\n")).toContain("openshell")
  })

  test("not enabled: host only, no sandbox feature, the openshell CLI is never called", async () => {
    const hub = fakeHub()
    const { fake } = openshellFake()
    const controller = new AbortController()
    const env = configDir({ server: hub.url, token: "mt", machineID: "m1" }, { workspaceRoots: [tmpdir()], openshell: { enabled: false } })
    const done = runNode({ env, home: "/nowhere", log: () => {}, signal: controller.signal, openshellBinary: fake.binary })
    await until(() => hub.hellos.length > 0)
    expect(hub.hellos[0]!.features).toBeUndefined()
    expect(hub.hellos[0]!.runtimes).toEqual([{ kind: "host", harnesses: ["opencode"] }])
    expect(fake.calls()).toEqual([])
    controller.abort()
    expect(await done).toBe(0)
  })

  test("enabled but the openshell CLI is unusable: logs why and runs host only", async () => {
    const hub = fakeHub()
    const controller = new AbortController()
    const lines: string[] = []
    const env = configDir({ server: hub.url, token: "mt", machineID: "m1" }, { workspaceRoots: [tmpdir()], openshell: { enabled: true } })
    const done = runNode({ env, home: "/nowhere", log: (l) => lines.push(l), signal: controller.signal, openshellBinary: "/nonexistent/openshell" })
    await until(() => hub.hellos.length > 0)
    expect(hub.hellos[0]!.runtimes).toEqual([{ kind: "host", harnesses: ["opencode"] }])
    expect(hub.hellos[0]!.features).toBeUndefined()
    expect(lines.join("\n")).toMatch(/openshell.*(not available|unusable|cannot)/i)
    controller.abort()
    expect(await done).toBe(0)
  })
})
