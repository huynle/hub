// The OpenShell CLI client against the fake openshell (test/fake-openshell.ts): argv built without a shell, the global
// flags (--workspace hub, --gateway, --color never) on every call, `-o json` parsed, the 0.1.x version gate, time
// limits, and errors that carry a short reason and never the secrets or env values of the call.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type CreateSandboxOptions, OPENSHELL_WORKSPACE, OpenShellCli, OpenShellError, type OpenShellCliOptions } from "../src/cli.ts"
import { createFakeOpenShell, type FakeOpenShell, type FakeOpenShellOptions } from "./fake-openshell.ts"

const fakes: FakeOpenShell[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup()
})

function setup(fakeOptions: FakeOpenShellOptions = {}, options: Partial<OpenShellCliOptions> = {}) {
  const fake = createFakeOpenShell(fakeOptions)
  fakes.push(fake)
  const cli = new OpenShellCli({ binary: fake.binary, env: { PATH: process.env.PATH ?? "" }, ...options })
  return { fake, cli }
}

const tmp = () => mkdtempSync(path.join(tmpdir(), "hub-openshell-cli-"))

async function rejection(promise: Promise<unknown>): Promise<OpenShellError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(OpenShellError)
    return error as OpenShellError
  }
  throw new Error("expected a rejection")
}

describe("global flags and version gate", () => {
  test("every call scopes to the hub workspace with colour off; the gateway when configured", async () => {
    const { fake, cli } = setup({}, { gateway: "lab" })
    await cli.status()
    const calls = fake.calls()
    expect(calls.map((c) => c.command)).toEqual(["--version", "status"])
    const status = calls[1]!
    expect(OPENSHELL_WORKSPACE).toBe("hub")
    expect(status.workspace).toBe("hub")
    expect(status.gateway).toBe("lab")
    expect(status.argv.slice(0, 6)).toEqual(["--gateway", "lab", "--workspace", "hub", "--color", "never"])
  })

  test("no --gateway when none is configured; the workspace can be changed", async () => {
    const { fake, cli } = setup({}, { workspace: "other" })
    await cli.status()
    const status = fake.calls()[1]!
    expect(status.argv).not.toContain("--gateway")
    expect(status.workspace).toBe("other")
  })

  test("checks the version once, and accepts any 0.1.x", async () => {
    const { fake, cli } = setup({ version: "0.1.9" })
    expect(await cli.version()).toBe("0.1.9")
    await cli.status()
    await cli.list()
    expect(fake.calls().filter((c) => c.command === "--version")).toHaveLength(1)
  })

  test("refuses other versions with unsupported_version, before running anything else", async () => {
    for (const version of ["0.2.0", "1.1.2"]) {
      const { fake, cli } = setup({ version })
      const error = await rejection(cli.list())
      expect(error.code).toBe("unsupported_version")
      expect(error.message).toContain(version)
      expect(fake.calls().map((c) => c.command)).toEqual(["--version"])
    }
  })

  test("a missing binary is not_installed", async () => {
    const cli = new OpenShellCli({ binary: path.join(tmp(), "no-such-openshell") })
    const error = await rejection(cli.status())
    expect(error.code).toBe("not_installed")
  })

  test("drops OPENSHELL_* settings that would change what a call does (the flags decide)", async () => {
    const { fake, cli } = setup({}, {
      env: { PATH: process.env.PATH ?? "", OPENSHELL_SANDBOX_POLICY: "/evil.yaml", OPENSHELL_GATEWAY_INSECURE: "1", OPENSHELL_WORKSPACE: "default", OPENSHELL_GATEWAY_ENDPOINT: "https://evil" },
    })
    await cli.status()
    expect(fake.calls()[1]!.env).toEqual({})
  })
})

describe("status", () => {
  test("parses `status -o json`", async () => {
    const { fake, cli } = setup()
    const status = await cli.status()
    expect(status).toEqual({ gateway: "openshell", server: "https://localhost:17670", connected: true, authenticated: true, version: "0.1.2" })
    expect(fake.calls()[1]!.argv.slice(-3)).toEqual(["status", "-o", "json"])
  })
})

describe("gatewayInfo", () => {
  test("parses `gateway info -o json`: the compute drivers' names", async () => {
    const { fake, cli } = setup()
    expect(await cli.gatewayInfo()).toEqual({ computeDrivers: ["vm"] })
    expect(fake.calls()[1]!.argv.slice(-4)).toEqual(["gateway", "info", "-o", "json"])
    fake.update((s) => (s.computeDrivers = ["vm", "kata"]))
    expect((await cli.gatewayInfo()).computeDrivers).toEqual(["vm", "kata"])
  })

  test("output without compute drivers is bad output", async () => {
    const { fake, cli } = setup()
    fake.fail({ command: "gateway info", exitCode: 0, stdout: "{}" })
    expect((await rejection(cli.gatewayInfo())).code).toBe("bad_output")
  })
})

describe("workspaces and providers (read-only listings for `hub node openshell check`)", () => {
  test("workspaces: the names from `workspace list -o json`, every page", async () => {
    const { fake } = setup()
    fake.update((s) => (s.workspaces = ["default", "hub", "lab"]))
    const small = new OpenShellCli({ binary: fake.binary, env: { PATH: process.env.PATH ?? "" }, pageSize: 2 })
    expect(await small.workspaces()).toEqual(["default", "hub", "lab"])
    const lists = fake.calls().filter((c) => c.command === "workspace list")
    expect(lists).toHaveLength(2)
    expect(lists[0]!.argv.slice(4)).toEqual(["workspace", "list", "--page-size", "2", "-o", "json"])
    expect(lists[1]!.argv).toContain("--page-token")
  })

  test("providers: the names from `provider list -o json` in the hub workspace", async () => {
    const { fake, cli } = setup()
    expect(await cli.providers()).toEqual([])
    fake.update((s) => (s.providers = ["anthropic", "openai"]))
    expect(await cli.providers()).toEqual(["anthropic", "openai"])
    const call = fake.calls().find((c) => c.command === "provider list")!
    expect(call.workspace).toBe("hub")
    expect(call.argv.slice(4)).toEqual(["provider", "list", "--page-size", "100", "-o", "json"])
  })

  test("output without the list is bad output", async () => {
    const { fake, cli } = setup()
    fake.fail({ command: "workspace list", exitCode: 0, stdout: "{}" })
    expect((await rejection(cli.workspaces())).code).toBe("bad_output")
    fake.fail({ command: "provider list", exitCode: 0, stdout: "[]" })
    expect((await rejection(cli.providers())).code).toBe("bad_output")
  })
})

describe("create", () => {
  test("builds the argv: name, image, policy, providers, labels, env, detached, no auto providers, JSON out, then the command", async () => {
    const { fake, cli } = setup()
    const dir = tmp()
    const policy = path.join(dir, "policy.yaml")
    writeFileSync(policy, "version: 1\n")
    const sandbox = await cli.create({
      name: "hub-0123456789abcdef0123",
      from: "hub-sandbox:dev",
      policyFile: policy,
      providers: ["anthropic", "openai"],
      labels: { "hub.launch": "L1", "hub.owner": "u1" },
      env: { HUB_URL: "http://host.openshell.internal:4097" },
      command: ["/usr/local/bin/hub-entry", "--flag", "with space"],
    })
    expect(sandbox).toMatchObject({ name: "hub-0123456789abcdef0123", workspace: "hub", phase: "Ready", labels: { "hub.launch": "L1", "hub.owner": "u1" }, exitCode: null })
    expect(sandbox.id).toBeString()
    const call = fake.calls().at(-1)!
    expect(call.command).toBe("sandbox create")
    expect(call.argv.slice(4)).toEqual([
      "sandbox", "create", "--name", "hub-0123456789abcdef0123", "--from", "hub-sandbox:dev", "--policy", policy,
      "--provider", "anthropic", "--provider", "openai", "--label", "hub.launch=L1", "--label", "hub.owner=u1",
      "--env", "HUB_URL=http://host.openshell.internal:4097", "--no-auto-providers", "--no-tty", "--detach", "-o", "json",
      "--", "/usr/local/bin/hub-entry", "--flag", "with space",
    ])
    const stored = fake.sandbox("hub-0123456789abcdef0123")!
    expect(stored.policy).toBe("version: 1\n")
    expect(stored.command).toEqual(["/usr/local/bin/hub-entry", "--flag", "with space"])
  })

  test("a template instead of an image; no command means no `--`", async () => {
    const { fake, cli } = setup()
    await cli.create({ name: "hub-a", template: "agents" })
    const argv = fake.calls().at(-1)!.argv
    expect(argv).toContain("--template")
    expect(argv).not.toContain("--")
    expect(argv).not.toContain("--from")
  })

  test("rejects bad names, labels and env names before calling openshell (invalid)", async () => {
    const { fake, cli } = setup()
    const bad: CreateSandboxOptions[] = [
      { name: "Hub_A" },
      { name: "-hub" },
      { name: "a".repeat(64) },
      { name: "hub-a", labels: { "hub.launch": "x,y" } },
      { name: "hub-a", labels: { "bad key": "x" } },
      { name: "hub-a", labels: { "hub.launch": "v".repeat(64) } },
      { name: "hub-a", env: { "1BAD": "x" } },
      { name: "hub-a", from: "img", template: "t" },
      { name: "hub-a", providers: ["bad name"] },
    ]
    for (const options of bad) expect((await rejection(cli.create(options))).code).toBe("invalid")
    expect(fake.calls().filter((c) => c.command === "sandbox create")).toHaveLength(0)
  })

  test("an existing name is already_exists", async () => {
    const { cli } = setup()
    await cli.create({ name: "hub-a" })
    expect((await rejection(cli.create({ name: "hub-a" }))).code).toBe("already_exists")
  })
})

describe("get, list, stop, delete", () => {
  test("get parses the sandbox; a missing one is undefined", async () => {
    const { fake, cli } = setup({ readyAfterGets: 1 })
    await cli.create({ name: "hub-a", labels: { "hub.it": "1" } })
    expect((await cli.get("hub-a"))?.phase).toBe("Provisioning")
    expect((await cli.get("hub-a"))?.phase).toBe("Ready")
    expect(await cli.get("hub-missing")).toBeUndefined()
    expect(fake.calls().at(-1)!.argv.slice(4)).toEqual(["sandbox", "get", "hub-missing", "-o", "json"])
  })

  test("list follows the pages and filters by label selector", async () => {
    const { fake, cli } = setup()
    for (let i = 0; i < 5; i++) await cli.create({ name: `hub-${i}`, labels: { "hub.it": i < 4 ? "1" : "0" } })
    const small = new OpenShellCli({ binary: fake.binary, env: { PATH: process.env.PATH ?? "" }, pageSize: 2 })
    const listed = await small.list({ "hub.it": "1" })
    expect(listed.map((s) => s.name).sort()).toEqual(["hub-0", "hub-1", "hub-2", "hub-3"])
    const lists = fake.calls().filter((c) => c.command === "sandbox list")
    expect(lists).toHaveLength(2)
    expect(lists[0]!.argv.slice(4)).toEqual(["sandbox", "list", "--page-size", "2", "--selector", "hub.it=1", "-o", "json"])
    expect(lists[1]!.argv).toContain("--page-token")
    expect((await cli.list()).length).toBe(5)
  })

  test("stop and delete; deleting a missing sandbox is fine", async () => {
    const { fake, cli } = setup()
    await cli.create({ name: "hub-a" })
    await cli.stop("hub-a")
    expect(fake.sandbox("hub-a")?.phase).toBe("Stopped")
    await cli.delete("hub-a")
    expect(fake.sandbox("hub-a")).toBeUndefined()
    await cli.delete("hub-a")
    expect(fake.calls().at(-1)!.argv.slice(4)).toEqual(["sandbox", "delete", "hub-a"])
  })

  test("stopping a missing sandbox is not_found", async () => {
    const { cli } = setup()
    expect((await rejection(cli.stop("hub-missing"))).code).toBe("not_found")
  })

  test("names are checked on every op", async () => {
    const { cli } = setup()
    expect((await rejection(cli.get("--all"))).code).toBe("invalid")
    expect((await rejection(cli.delete("--all"))).code).toBe("invalid")
  })
})

describe("exec", () => {
  test("runs argv (no shell, no tty, no login shell) and returns exit code and output, with stdin", async () => {
    const { fake, cli } = setup()
    await cli.create({ name: "hub-a" })
    const result = await cli.exec("hub-a", ["sh", "-c", 'printf "%s|" "$1"; cat; echo err >&2; exit 3', "sh", "it's a \"test\""], {
      stdin: "from stdin",
      workdir: "/sandbox/work",
      timeoutSec: 30,
      env: { MODE: "x" },
    })
    expect(result).toEqual({ exitCode: 3, stdout: `it's a "test"|from stdin`, stderr: "err\n" })
    const call = fake.calls().at(-1)!
    expect(call.argv.slice(4)).toEqual([
      "sandbox", "exec", "--name", "hub-a", "--no-tty", "--no-login-shell", "--workdir", "/sandbox/work", "--timeout", "30",
      "--env", "MODE=x", "--", "sh", "-c", 'printf "%s|" "$1"; cat; echo err >&2; exit 3', "sh", `it's a "test"`,
    ])
    expect(call.stdinBytes).toBe(10)
    expect(existsSync(path.join(fake.sandboxRoot("hub-a"), "sandbox", "work"))).toBe(true)
  })

  test("refuses stdin over 4 MiB and an empty command", async () => {
    const { cli } = setup()
    expect((await rejection(cli.exec("hub-a", ["cat"], { stdin: new Uint8Array(4 * 1024 * 1024 + 1) }))).code).toBe("invalid")
    expect((await rejection(cli.exec("hub-a", []))).code).toBe("invalid")
  })
})

describe("upload and download", () => {
  test("upload sends a file without .gitignore filtering; download brings it back", async () => {
    const { fake, cli } = setup()
    await cli.create({ name: "hub-a" })
    const dir = tmp()
    const bundle = path.join(dir, "repo.bundle")
    writeFileSync(bundle, "bundle-bytes")
    await cli.upload("hub-a", bundle, "/sandbox/in/")
    expect(readFileSync(path.join(fake.sandboxRoot("hub-a"), "sandbox", "in", "repo.bundle"), "utf8")).toBe("bundle-bytes")
    expect(fake.calls().at(-1)!.argv.slice(4)).toEqual(["sandbox", "upload", "--no-git-ignore", "hub-a", bundle, "/sandbox/in/"])
    const back = path.join(dir, "back")
    mkdirSync(back)
    await cli.download("hub-a", "/sandbox/in/repo.bundle", back)
    expect(readFileSync(path.join(back, "repo.bundle"), "utf8")).toBe("bundle-bytes")
    expect(fake.calls().at(-1)!.argv.slice(4)).toEqual(["sandbox", "download", "hub-a", "/sandbox/in/repo.bundle", back])
  })
})

describe("policySet", () => {
  test("sets a live sandbox's policy and waits for it to load", async () => {
    const { fake, cli } = setup()
    await cli.create({ name: "hub-a" })
    const file = path.join(tmp(), "p.yaml")
    writeFileSync(file, "version: 2\n")
    await cli.policySet("hub-a", file, { wait: true, timeoutSec: 20 })
    expect(fake.sandbox("hub-a")?.policy).toBe("version: 2\n")
    expect(fake.calls().at(-1)!.argv.slice(4)).toEqual(["policy", "set", "--policy", file, "--wait", "--timeout", "20", "hub-a"])
  })
})

describe("errors and time limits", () => {
  test("a failure carries the gRPC message, the command and the exit code, never the call's env values or secrets", async () => {
    const { fake, cli } = setup({}, { secrets: ["s3cr3t-token"] })
    fake.fail({ command: "sandbox create", stderr: '\u001b[31mError:\u001b[0m   × status: Internal, message: "boom s3cr3t-token at https://user:pw@gw.example/x and HUB_URL=http://hidden-value", details: []\n', exitCode: 1 })
    const error = await rejection(cli.create({ name: "hub-a", env: { HUB_URL: "http://hidden-value" } }))
    expect(error.code).toBe("failed")
    expect(error.exitCode).toBe(1)
    expect(error.message).toStartWith("openshell sandbox create failed (exit 1): boom")
    for (const secret of ["s3cr3t-token", "hidden-value", "user:pw", "\u001b["]) expect(error.message).not.toContain(secret)
  })

  test("long stderr is cut", async () => {
    const { fake, cli } = setup()
    fake.fail({ command: "status", stderr: "x".repeat(5000) })
    expect((await rejection(cli.status())).message.length).toBeLessThan(500)
  })

  test("unparseable JSON is bad_output", async () => {
    const { fake, cli } = setup()
    fake.fail({ command: "status", exitCode: 0, stdout: "not json", stderr: "" })
    expect((await rejection(cli.status())).code).toBe("bad_output")
  })

  test("a call over its time limit is killed and is a timeout", async () => {
    const { fake, cli } = setup({}, { timeoutMs: 300 })
    fake.fail({ command: "status", delayMs: 5000 })
    const started = Date.now()
    expect((await rejection(cli.status())).code).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("a cancelled call is cancelled", async () => {
    const { fake, cli } = setup()
    await cli.version()
    fake.fail({ command: "sandbox get", delayMs: 5000 })
    const controller = new AbortController()
    const pending = cli.get("hub-a", { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect((await rejection(pending)).code).toBe("cancelled")
  })
})
