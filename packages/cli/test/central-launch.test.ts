// `hub launch` and `hub launches` against the real hub (test/central-harness.ts): an app token with scope
// sessions:launch and a launch grant on the repo, logged in; the hub validates the CLI's spec, answers the same
// launch for the same key, lists by label, shows, and stops (then gone).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness } from "../../../test/central-harness"
import { EXIT, run } from "../src/cli"

const hub = harness()
afterAll(() => hub.stop())
const home = mkdtempSync(path.join(tmpdir(), "hub-cli-central-launch-"))

async function cli(argv: string[]) {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env: {}, home, cwd: "/p", stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

describe("hub launch against the hub", () => {
  let id = ""

  test("log in with an app token holding sessions:launch and a launch grant on /p/hub", async () => {
    const token = (await (await hub.api("/api/agent/app-tokens", { method: "POST", json: { label: "launcher", scopes: ["sessions:launch"] } })).json()) as { token: string; id: string }
    expect((await hub.api("/api/agent/grants", { method: "POST", json: { holder: `app:${token.id}`, scope: { projects: ["/p/hub"] }, allow: ["launch"] } })).status).toBe(201)
    expect((await cli(["login", "--url", hub.url, "--token", token.token])).code).toBe(0)
  })

  test("launch (relative --repo against the working directory), then the same key again", async () => {
    const argv = ["launch", "--repo", "hub", "--branch", "feat/x", "--key", "k1", "--label", "app=brain", "--prompt", "Go", "--end", "idle", "--timeout", "4h", "--json"]
    const first = await cli(argv)
    expect(first.stderr).toBe("")
    expect(first.code).toBe(0)
    const { launch } = JSON.parse(first.stdout)
    expect(launch).toMatchObject({ state: "queued", spec: { workspace: { repo: "/p/hub", mode: "worktree", branch: "feat/x" }, labels: { app: "brain" }, end: { when: "idle", timeout: "4h" } } })
    id = launch.id
    const again = await cli(argv.slice(0, -1))
    expect(again.code).toBe(0)
    expect(again.stdout).toStartWith(`${id} was already launched with key k1: queued`)
  })

  test("outside the grant: forbidden (exit 5); the hub's invalid is a usage error (exit 2)", async () => {
    expect((await cli(["launch", "--repo", "/elsewhere", "--branch", "b"])).code).toBe(EXIT.forbidden)
    const invalid = await cli(["launch", "--repo", "/p/hub"])
    expect(invalid.code).toBe(EXIT.usage)
    expect(invalid.stderr).toContain("branch")
  })

  test("list by label, show, stop; stopping again is gone (exit 8)", async () => {
    const list = await cli(["launches", "list", "--label", "app=brain"])
    expect(list.code).toBe(0)
    expect(list.stdout).toStartWith(`${id}  queued`)
    expect((await cli(["launches", "list", "--label", "app=other"])).stdout).toBe("no launches\n")
    const show = await cli(["launches", "show", id])
    expect(show.stdout).toContain(`by: app:`)
    const stop = await cli(["launches", "stop", id])
    expect(stop.code).toBe(0)
    expect(stop.stdout).toStartWith(`stopped ${id}: ended stopped`)
    expect((await cli(["launches", "stop", id])).code).toBe(EXIT.gone)
  })
})
