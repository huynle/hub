// `hub node` from the shipped CLI bundle (packages/cli/dist/hub-cli.js, `bun build --target=node`): `hub node run`
// runs the daemon on bun (as `BUN_BE_BUN=1 <runtime> hub-cli.js`, how the launchers and the service units run it)
// and on node, answers a prepare, and exits 0 on SIGTERM; `hub node install --dry-run` finds the templates next to
// the bundle (scripts/ of the package) and writes nothing.
import { afterAll, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const root = path.join(import.meta.dir, "..", "..", "..")
const work = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-cli-node-bundle-")))
// The package layout: <pkg>/packages/cli/dist/hub-cli.js and <pkg>/scripts/.
const pkg = path.join(work, "pkg")
const bundle = path.join(pkg, "packages", "cli", "dist", "hub-cli.js")
mkdirSync(path.join(pkg, "scripts"), { recursive: true })
for (const file of ["io.github.huynle.hub-node.plist", "hub-node.service"]) copyFileSync(path.join(root, "scripts", file), path.join(pkg, "scripts", file))

const repo = path.join(work, "root", "proj")
mkdirSync(repo, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: work } })
git("init", "-q", "-b", "main")
git("commit", "-q", "--allow-empty", "-m", "init")

const home = path.join(work, "home")
const configDir = path.join(home, ".config", "hub")
mkdirSync(configDir, { recursive: true })
writeFileSync(path.join(configDir, "node.json"), JSON.stringify({ workspaceRoots: [path.join(work, "root")], slots: 2 }))

let results: Record<string, unknown>[] = []
let hellos: Record<string, unknown>[] = []
let branch = 0
const hub = Bun.serve({
  port: 0,
  fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
  websocket: {
    message(ws, msg) {
      const frame = JSON.parse(String(msg))
      if (frame.t === "hello") {
        hellos.push(frame)
        ws.send(JSON.stringify({ t: "welcome", v: 1, machineID: "m1", publicURL: "http://x", features: ["nodes"] }))
        ws.send(JSON.stringify({ t: "req", id: "h1", req: { op: "prepare", launchID: `lb${branch}`, runtime: { kind: "host" }, harness: "opencode", workspace: { repo, mode: "worktree", branch: `feat/cli-${branch++}` } } }))
      }
      if (frame.t === "res") results.push(frame)
    },
  },
})
writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${hub.port}`, token: "mt_cli_bundle" }))
afterAll(() => hub.stop(true))

const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...extra })

async function runAndStop(cmd: string[], extra: Record<string, string> = {}) {
  results = []
  hellos = []
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: env(extra) })
  const end = Date.now() + 10_000
  while (results.length === 0 && Date.now() < end) await Bun.sleep(20)
  proc.kill("SIGTERM")
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { stderr, code }
}

describe("hub node from the CLI bundle", () => {
  test("bundles for node", () => {
    const r = Bun.spawnSync([process.execPath, "build", path.join(root, "packages/cli/src/main.ts"), "--target=node", `--outfile=${bundle}`])
    expect(r.exitCode).toBe(0)
  })

  for (const [name, cmd, extra] of [
    ["bun (BUN_BE_BUN=1)", () => [process.execPath, bundle, "node", "run"], { BUN_BE_BUN: "1" }],
    ["node", () => [Bun.which("node") ?? "", bundle, "node", "run"], {}],
  ] as const) {
    test(`hub node run on ${name}: hello, a prepared worktree, exit 0 on SIGTERM`, async () => {
      const argv = cmd()
      if (!argv[0]) return // node is not installed
      const { stderr, code } = await runAndStop([...argv], extra)
      expect(hellos[0]).toMatchObject({ t: "hello", role: "node", capacity: { slots: 2 } })
      expect(results[0]).toMatchObject({ t: "res", id: "h1", ok: true, result: { workspace: { mode: "worktree", reused: false } } })
      expect(stderr).toContain("[hub node] connected")
      expect(stderr).toContain("[hub node] stopped")
      expect(stderr).not.toContain("mt_cli_bundle")
      expect(code).toBe(0)
    }, 20_000)
  }

  test("hub node install --dry-run finds the templates next to the bundle and writes nothing", async () => {
    const proc = Bun.spawn([process.execPath, bundle, "node", "install", "--dry-run"], { stdout: "pipe", stderr: "pipe", env: env({ BUN_BE_BUN: "1" }) })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain(process.platform === "darwin" ? `<string>${bundle}</string>` : `${bundle} node run`)
    expect(existsSync(path.join(home, "Library", "LaunchAgents"))).toBe(false)
    expect(existsSync(path.join(home, ".config", "systemd"))).toBe(false)
  })
})
