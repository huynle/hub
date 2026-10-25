// `hub node` runs on bun from source and on node bundled (`bun build --target=node`, how the CLI ships): no Bun
// APIs, the global WebSocket with an Authorization header (undici on node), git through node:child_process.
// Each run connects to a fake hub, gets a prepare for a temporary repository, answers it, and stops on SIGTERM.
import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const main = path.join(import.meta.dir, "..", "src", "main.ts")
const work = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-node-bundle-")))
const bundle = path.join(work, "hub-node.js")

const repo = path.join(work, "root", "proj")
mkdirSync(repo, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: work } })
git("init", "-q", "-b", "main")
git("commit", "-q", "--allow-empty", "-m", "init")

const config = path.join(work, "config", "config.json")
mkdirSync(path.dirname(config))
writeFileSync(config, JSON.stringify({ server: "http://127.0.0.1:1", token: "mt_bundle" }))
writeFileSync(path.join(work, "config", "node.json"), JSON.stringify({ workspaceRoots: [path.join(work, "root")], slots: 2 }))

interface Seen {
  auth: (string | null)[]
  hellos: Record<string, unknown>[]
  results: Record<string, unknown>[]
}
let seen: Seen = { auth: [], hellos: [], results: [] }
const hub = Bun.serve({
  port: 0,
  fetch(req, srv) {
    seen.auth.push(req.headers.get("authorization"))
    return srv.upgrade(req) ? undefined : new Response("no", { status: 400 })
  },
  websocket: {
    message(ws, msg) {
      const frame = JSON.parse(String(msg))
      if (frame.t === "hello") {
        seen.hellos.push(frame)
        ws.send(JSON.stringify({ t: "welcome", v: 1, machineID: "m1", publicURL: "http://x", features: ["nodes"] }))
        ws.send(JSON.stringify({ t: "req", id: "h1", req: { op: "prepare", launchID: "lb", runtime: { kind: "host" }, harness: "opencode", workspace: { repo, mode: "worktree", branch: "feat/bundle" } } }))
      }
      if (frame.t === "res") seen.results.push(frame)
    },
  },
})
writeFileSync(config, JSON.stringify({ server: `http://127.0.0.1:${hub.port}`, token: "mt_bundle" }))
afterAll(() => hub.stop(true))

async function runAndStop(cmd: string[]) {
  seen = { auth: [], hellos: [], results: [] }
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work, HUB_SPOKE_CONFIG: config } })
  const end = Date.now() + 10_000
  while (seen.results.length === 0 && Date.now() < end) await Bun.sleep(20)
  proc.kill("SIGTERM")
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { stderr, code }
}

describe("hub node as shipped", () => {
  test("bundles for node", () => {
    const r = Bun.spawnSync([process.execPath, "build", main, "--target=node", `--outfile=${bundle}`])
    expect(r.exitCode).toBe(0)
  })

  for (const [name, cmd] of [
    ["bun, from source", () => [process.execPath, main]],
    ["node, bundled", () => [Bun.which("node") ?? "", bundle]],
  ] as const) {
    test(`runs on ${name}: hello, a prepared worktree, a clean stop`, async () => {
      const argv = cmd()
      if (!argv[0]) return // node is not installed
      const { stderr, code } = await runAndStop([...argv])
      expect(seen.auth[0]).toBe("Bearer mt_bundle")
      expect(seen.hellos[0]).toMatchObject({ t: "hello", role: "node", capacity: { slots: 2 } })
      expect(seen.results[0]).toMatchObject({ t: "res", id: "h1", ok: true, result: { workspace: { mode: "worktree", branch: "feat/bundle", reused: name.startsWith("node") } } })
      expect(code).toBe(0)
      expect(stderr).not.toContain("mt_bundle")
    }, 20_000)
  }
})
