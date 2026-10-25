// `hub node openshell check` (design §6.4, decision lk6gn3u7, spike report gut64rwq): whether this node can run
// sandboxed launches. It reads node.json's `openshell` section and asks the openshell CLI (the fake from
// packages/runtime-openshell/test) only read-only questions: --version, status, workspace list, provider list. It never
// creates anything; for a missing workspace it prints the command to run. Exit 0 when nothing is wrong (warnings
// allowed), 1 when something is; --json prints the report.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFakeOpenShell, type FakeOpenShell } from "../../runtime-openshell/test/fake-openshell.ts"
import { EXIT, run, type Io } from "../src/cli"

// Every fake openshell call starts a bun process: slow under load.
setDefaultTimeout(60_000)

const READ_ONLY = new Set(["--version", "status", "workspace list", "provider list"])
const IMAGE = "ghcr.io/example/hub-sandbox:0.1"

const fakes: FakeOpenShell[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup()
})

function fake(): FakeOpenShell {
  const f = createFakeOpenShell()
  fakes.push(f)
  f.update((s) => (s.providers = ["anthropic"]))
  return f
}

function home(node: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-cli-openshell-"))
  mkdirSync(path.join(dir, ".config", "hub"), { recursive: true })
  if (node !== undefined) writeFileSync(path.join(dir, ".config", "hub", "node.json"), JSON.stringify(node))
  return dir
}

const good = (openshell: Record<string, unknown> = {}) => ({
  workspaceRoots: ["/tmp"],
  openshell: { enabled: true, image: IMAGE, profiles: { default: { providers: ["anthropic"] } }, ...openshell },
})

async function check(options: { node?: unknown; openshell?: FakeOpenShell | string; json?: boolean } = {}) {
  let stdout = ""
  let stderr = ""
  const f = options.openshell ?? fake()
  const io: Io = {
    env: { PATH: process.env.PATH ?? "" },
    home: home("node" in options ? options.node : good()),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    openshellBinary: typeof f === "string" ? f : f.binary,
  }
  const code = await run(["node", "openshell", "check", ...(options.json ? ["--json"] : [])], io)
  const report = options.json ? JSON.parse(stdout) : undefined
  return { code, stdout, stderr, report, fake: typeof f === "string" ? undefined : f }
}

type Item = { check: string; status: string; message: string; hint?: string }
const item = (report: { checks: Item[] }, name: string) => report.checks.filter((c) => c.check === name)

describe("hub node openshell check", () => {
  test("all good: exit 0, every check ok, only read-only openshell calls", async () => {
    const r = await check({ json: true })
    expect(r.code).toBe(EXIT.ok)
    expect(r.report.ok).toBe(true)
    const statuses = Object.fromEntries((r.report.checks as Item[]).map((c) => [c.check, c.status]))
    expect(statuses).toEqual({ config: "ok", profiles: "ok", "default-providers": "ok", image: "ok", cli: "ok", gateway: "ok", workspace: "ok", providers: "ok" })
    const commands = r.fake!.calls().map((c) => c.command)
    expect(commands.every((c) => READ_ONLY.has(c))).toBe(true)
    expect(commands).toEqual(expect.arrayContaining(["--version", "status", "workspace list", "provider list"]))
    expect(r.fake!.calls().every((c) => c.workspace === "hub")).toBe(true)
  })

  test("text output: one line per check and a summary", async () => {
    const r = await check()
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/ok\s+cli: openshell 0\.1\.2/)
    expect(r.stdout).toMatch(/ok\s+workspace: hub exists/)
    expect(r.stdout).toContain("no problems")
  })

  test("the configured gateway is used", async () => {
    const r = await check({ node: good({ gateway: "lab" }) })
    expect(r.code).toBe(0)
    expect(r.fake!.calls().every((c) => c.gateway === "lab")).toBe(true)
  })

  test("no openshell section: a problem with an example", async () => {
    const r = await check({ node: { workspaceRoots: ["/tmp"] }, json: true })
    expect(r.code).toBe(1)
    const [config] = item(r.report, "config")
    expect(config!.status).toBe("fail")
    expect(config!.hint).toContain('"openshell"')
  })

  test("openshell.enabled false: a warning, not a problem", async () => {
    const r = await check({ node: good({ enabled: false }), json: true })
    expect(r.code).toBe(0)
    expect(item(r.report, "config")[0]!.status).toBe("warn")
  })

  test("invalid openshell fields are problems", async () => {
    const r = await check({ node: good({ gateway: "bad name!" }), json: true })
    expect(r.code).toBe(1)
    const fails = item(r.report, "config").filter((c) => c.status === "fail")
    expect(fails.map((c) => c.message).join("\n")).toContain("openshell.gateway")
  })

  test("an unsupported profile (cpu/memory/mounts on the vm backend) is a problem", async () => {
    const r = await check({ node: good({ profiles: { default: { providers: ["anthropic"] }, big: { cpu: 4 } } }), json: true })
    expect(r.code).toBe(1)
    const profiles = item(r.report, "profiles")
    expect(profiles.find((c) => c.status === "fail")!.message).toContain("big")
    expect(item(r.report, "config").every((c) => c.status !== "fail")).toBe(true)
  })

  test("the default profile without providers: a warning (the agent cannot reach a model)", async () => {
    const r = await check({ node: good({ profiles: {} }), json: true })
    expect(r.code).toBe(0)
    const [warning] = item(r.report, "default-providers")
    expect(warning!.status).toBe("warn")
    expect(warning!.message).toContain("model")
  })

  test("images: unset (the local default name) or without a registry host warn; localhost registries warn", async () => {
    for (const image of [undefined, "hub-sandbox:0.1", "localhost:5055/hub-sandbox:0.1", "127.0.0.1:5000/x:1"]) {
      const node = good()
      if (image === undefined) delete (node.openshell as Record<string, unknown>).image
      else node.openshell.image = image
      const r = await check({ node, json: true })
      expect(r.code).toBe(0)
      expect(item(r.report, "image").some((c) => c.status === "warn")).toBe(true)
    }
    const ok = await check({ node: good({ image: "docker.io/library/debian:bookworm-slim" }), json: true })
    expect(item(ok.report, "image").every((c) => c.status === "ok")).toBe(true)
  })

  test("a profile's own image is checked too", async () => {
    const r = await check({ node: good({ profiles: { default: { providers: ["anthropic"] }, local: { image: "mine:dev" } } }), json: true })
    const warning = item(r.report, "image").find((c) => c.status === "warn")!
    expect(warning.message).toContain("mine:dev")
  })

  test("openshell not installed: a problem, the CLI checks are skipped", async () => {
    const r = await check({ openshell: "/nonexistent/openshell", json: true })
    expect(r.code).toBe(1)
    expect(item(r.report, "cli")[0]!.status).toBe("fail")
    for (const name of ["gateway", "workspace", "providers"]) expect(item(r.report, name)[0]!.status).toBe("skip")
  })

  test("an unsupported CLI version is a problem", async () => {
    const f = fake()
    f.update((s) => (s.version = "0.2.0"))
    const r = await check({ openshell: f, json: true })
    expect(r.code).toBe(1)
    expect(item(r.report, "cli")[0]!.message).toContain("0.2.0")
  })

  test("a disconnected gateway is a problem; workspace and providers are skipped", async () => {
    const f = fake()
    f.update((s) => (s.gatewayStatus = "disconnected"))
    const r = await check({ openshell: f, json: true })
    expect(r.code).toBe(1)
    expect(item(r.report, "gateway")[0]!.status).toBe("fail")
    expect(item(r.report, "workspace")[0]!.status).toBe("skip")
  })

  test("no workspace hub: a problem that offers the create command (never run)", async () => {
    const f = fake()
    f.update((s) => (s.workspaces = ["default"]))
    const r = await check({ openshell: f, json: true })
    expect(r.code).toBe(1)
    const [workspace] = item(r.report, "workspace")
    expect(workspace!.status).toBe("fail")
    expect(workspace!.hint).toContain("openshell workspace create --name hub")
    expect(f.calls().some((c) => c.command === "workspace create")).toBe(false)
  })

  test("a profile naming a provider the hub workspace lacks is a problem", async () => {
    const r = await check({ node: good({ profiles: { default: { providers: ["anthropic"] }, x: { providers: ["openai"] } } }), json: true })
    expect(r.code).toBe(1)
    const missing = item(r.report, "providers").filter((c) => c.status === "fail")
    expect(missing).toHaveLength(1)
    expect(missing[0]!.message).toContain("openai")
    expect(missing[0]!.message).toContain("x")
  })
})
