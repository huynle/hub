// The CLI against the real hub (test/central-harness.ts): an app token made in the console's API, then login,
// whoami, status, sessions, who and the error envelope end to end.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness } from "../../../test/central-harness"
import { run } from "../src/cli"

const hub = harness()
afterAll(() => hub.stop())

async function cli(argv: string[], env: Record<string, string>, home: string) {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env, home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

describe("hub CLI against the hub", () => {
  const home = mkdtempSync(path.join(tmpdir(), "hub-cli-central-"))
  let token = ""

  test("an app token from POST /api/agent/app-tokens logs in", async () => {
    const created = await hub.api("/api/agent/app-tokens", { method: "POST", json: { label: "cli test" } })
    expect(created.status).toBe(201)
    token = ((await created.json()) as { token: string }).token
    const r = await cli(["login", "--url", hub.url, "--token", token], {}, home)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("(cli test)")
  })

  test("whoami, status, sessions and who answer with the login", async () => {
    const whoami = await cli(["whoami", "--json"], {}, home)
    expect(whoami.code).toBe(0)
    expect(JSON.parse(whoami.stdout).actor).toMatchObject({ kind: "app", label: "cli test", scopes: ["sessions:read"] })
    const status = await cli(["status", "--json"], {}, home)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ you: { kind: "app" }, attention: [] })
    expect((await cli(["sessions"], {}, home)).stdout.trim()).toBe("no sessions")
    expect((await cli(["who"], {}, home)).code).toBe(0)
  })

  test("errors come back as exit codes: unknown session 404, writes forbidden for app tokens", async () => {
    const show = await cli(["show", "ses_nope"], {}, home)
    expect(show.code).toBe(3)
    const name = await cli(["name", "@x", "--session", "ses_nope"], {}, home)
    expect(name.code).toBe(5)
  })

  test("a revoked token is unauthorized (exit 9)", async () => {
    const id = token.split("_")[1]!
    expect((await hub.api(`/api/agent/app-tokens/${id}`, { method: "DELETE" })).status).toBe(204)
    const r = await cli(["whoami"], {}, home)
    expect(r.code).toBe(9)
    expect(r.stderr).toContain("hub login")
  })
})
