// The CLI as shipped: one JS bundle (npm run build:cli) that runs on bun (the OpenCode binary with BUN_BE_BUN=1)
// and on node, and is packed into @huynle/hub.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..", "..", "..")
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const out = path.join(mkdtempSync(path.join(tmpdir(), "hub-cli-bundle-")), "hub-cli.js")

const hub = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/api/agent/whoami" && request.headers.get("authorization") === "Bearer tok"
      ? Response.json({ actor: { kind: "session", userID: "u1", machineID: "m1", sessionID: "ses_bundle" }, user: { id: "u1", name: "Huy" } })
      : Response.json({ error: { code: "unauthorized", message: "nope" } }, { status: 401 }),
})
afterAll(() => hub.stop(true))

async function exec(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...env } })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

describe("CLI bundle", () => {
  test("the build script bundles main.ts for node into packages/cli/dist/hub-cli.js, and prepack runs it", () => {
    expect(pkg.scripts["build:cli"]).toBe("bun build packages/cli/src/main.ts --target=node --outfile=packages/cli/dist/hub-cli.js")
    expect(pkg.scripts.prepack).toContain("npm run build:cli")
    expect(pkg.files).toContain("packages/cli/dist/hub-cli.js")
  })

  test("builds", async () => {
    const r = await exec([process.execPath, "build", path.join(root, "packages/cli/src/main.ts"), "--target=node", `--outfile=${out}`])
    expect(r.code).toBe(0)
  })

  test("runs on bun as BUN_BE_BUN=1 <runtime> bundle: --version, whoami, exit codes", async () => {
    const version = await exec([process.execPath, out, "--version"], { BUN_BE_BUN: "1" })
    expect(version.stdout.trim()).toBe(JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version)
    const whoami = await exec([process.execPath, out, "whoami"], { BUN_BE_BUN: "1", HUB_URL: `http://127.0.0.1:${hub.port}`, HUB_SESSION_TOKEN: "tok" })
    expect(whoami.code).toBe(0)
    expect(whoami.stdout).toContain("session ses_bundle")
    const denied = await exec([process.execPath, out, "whoami"], { HUB_URL: `http://127.0.0.1:${hub.port}`, HUB_SESSION_TOKEN: "bad" })
    expect(denied.code).toBe(9)
    expect(denied.stderr).toContain("nope")
  })

  test("runs on node when it is installed", async () => {
    const node = Bun.which("node")
    if (!node) return
    const r = await exec([node, out, "whoami", "--json"], { HUB_URL: `http://127.0.0.1:${hub.port}`, HUB_SESSION_TOKEN: "tok" })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).actor.sessionID).toBe("ses_bundle")
  })
})
