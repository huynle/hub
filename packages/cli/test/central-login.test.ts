// End to end against the real hub (test/central-harness.ts): `hub login` with the device code, approved in the
// console as the user with the launch scope ticked, then `hub launch` gets past authentication: without a grant the
// hub's launch route refuses it at the grant check (forbidden, with the hint), and with a launch grant for the new
// token the launch is accepted (queued: there is no node).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, waitFor } from "../../../test/central-harness"
import { EXIT, run } from "../src/cli"

const hub = await harness()
afterAll(() => hub.stop())
const home = mkdtempSync(path.join(tmpdir(), "hub-cli-central-login-"))

async function cli(argv: string[], onStderr?: (all: string) => void) {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, {
    env: {},
    home,
    cwd: "/p",
    stdout: (s) => (stdout += s),
    stderr: (s) => {
      stderr += s
      onStderr?.(stderr)
    },
    login: { intervalMs: 20, clientName: "dev box" },
  })
  return { code, stdout, stderr }
}

describe("hub login (device code) → hub launch, against the hub", () => {
  let tokenID = ""

  test("login: the user approves in the console with sessions:launch; the app token is stored", async () => {
    let code = ""
    const login = cli(["login", "--url", hub.url, "--scope", "sessions:launch"], (all) => {
      code = /approve code ([A-Z]{4}-[A-Z]{4})/.exec(all)?.[1] ?? code
    })
    await waitFor(() => code !== "", 5000)
    const pending = (await (await hub.api(`/api/cli-logins/${code}`)).json()) as { login: { clientName: string; scopes: string[] } }
    expect(pending.login).toMatchObject({ clientName: "dev box", scopes: ["sessions:read", "messages:send", "messages:read", "sessions:launch"] })
    expect((await hub.api(`/api/cli-logins/${code}/approve`, { method: "POST", json: { scopes: pending.login.scopes } })).status).toBe(204)
    const r = await login
    expect(r.stderr).toContain(`${hub.url}/approve?code=${code}`)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("app token")
    expect(r.stdout).toContain("CLI login: dev box")
    expect(r.stdout).toContain("--allow launch")
    const stored = JSON.parse(readFileSync(path.join(home, ".config", "hub", "cli.json"), "utf8")) as { url: string; token: string }
    expect(stored.url).toBe(hub.url)
    expect(r.stdout + r.stderr).not.toContain(stored.token)
    const who = JSON.parse((await cli(["whoami", "--json"])).stdout) as { actor: { kind: string; tokenID: string; scopes: string[] } }
    expect(who.actor.kind).toBe("app")
    expect(who.actor.scopes).toContain("sessions:launch")
    tokenID = who.actor.tokenID
  })

  test("launch without a grant: past authentication, refused at the grant check (exit 5) with what it needs", async () => {
    const r = await cli(["launch", "--repo", "hub", "--branch", "feat/x"])
    expect(r.code).toBe(EXIT.forbidden)
    expect(r.stderr).toContain("No grant lets this app launch in /p/hub")
    expect(r.stderr).toContain("verb launch")
  })

  test("with a launch grant for the token: the launch is accepted (queued, no node yet)", async () => {
    expect((await hub.api("/api/agent/grants", { method: "POST", json: { holder: `app:${tokenID}`, scope: { projects: ["/p/hub"] }, allow: ["launch"] } })).status).toBe(201)
    const r = await cli(["launch", "--repo", "hub", "--branch", "feat/x", "--json"])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const { launch } = JSON.parse(r.stdout)
    expect(launch).toMatchObject({ state: "queued", spec: { workspace: { repo: "/p/hub", branch: "feat/x" } } })
    expect(launch.by).toBe(`app:${tokenID}`)
  })

  test("a denied login stores nothing and keeps the earlier one", async () => {
    let code = ""
    const login = cli(["login", "--url", hub.url], (all) => {
      code = /approve code ([A-Z]{4}-[A-Z]{4})/.exec(all)?.[1] ?? code
    })
    await waitFor(() => code !== "", 5000)
    const before = readFileSync(path.join(home, ".config", "hub", "cli.json"), "utf8")
    expect((await hub.api(`/api/cli-logins/${code}/deny`, { method: "POST", json: {} })).status).toBe(204)
    const r = await login
    expect(r.code).toBe(EXIT.forbidden)
    expect(readFileSync(path.join(home, ".config", "hub", "cli.json"), "utf8")).toBe(before)
  })
})
