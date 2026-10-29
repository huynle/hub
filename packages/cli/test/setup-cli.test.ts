// `hubctl machine …` and `hubctl setup …` end to end (HBS-13), through the CLI's run() against a temporary HOME, a
// real hub server on 127.0.0.1 (src/central) and a fake OpenCode on PATH. Nothing touches the real home, config,
// service manager or hub: the service manager is a recording fake, and every path is under the temporary HOME.
//
//   machine status → machine enroll (device code, approved on the hub) → machine status
//   setup discover → setup preview (writes nothing) → setup preview --out → setup apply → replay refused (12)
//   setup verify (ready only while the spoke is connected: 0, then 15) → setup drift → setup rollback
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, spoke, type Harness } from "../../../test/central-harness.ts"
import { canonicalJSON, validateEnvelope, type ResultEnvelope } from "../src/bootstrap/contracts/index.ts"
import { tarGz, zip } from "./bootstrap/opencode-adapter-fixtures.ts"
import { bytesInfo, ephemeralKey, fakeBinary, releaseBody, rootOf, signWith } from "./bootstrap/release-fixtures.ts"
import { run, type Io } from "../src/cli"

let h: Harness | undefined
const homes: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true })
})

const FAKE_OPENCODE = `#!/bin/sh
case "$1" in
  --version) echo "opencode v2.2.0" ;;
  models) echo "anthropic/claude-sonnet-4"; echo "openai/gpt-5" ;;
  *) exit 2 ;;
esac
`
const ENTRY = realpathSync(path.join(import.meta.dir, "..", "src", "main.ts"))

function tempHome(): string {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-setup-cli-")))
  homes.push(home)
  mkdirSync(path.join(home, "bin"), { recursive: true })
  writeFileSync(path.join(home, "bin", "opencode"), FAKE_OPENCODE)
  chmodSync(path.join(home, "bin", "opencode"), 0o755)
  return home
}

interface Seen {
  readonly calls: string[]
}

async function cli(home: string, argv: string[], extra: { stdin?: string; seen?: Seen } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` },
    home,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(extra.stdin !== undefined ? { stdin: async () => extra.stdin! } : {}),
    program: { execPath: process.execPath, entry: ENTRY },
    bootstrap: {
      machineID: "test-machine-id",
      ports: {
        serviceRunner: async (call) => (extra.seen?.calls.push(`${call.program} ${call.words.join(" ")}`), { exitCode: call.words.includes("print") || call.words.includes("is-active") ? 1 : 0 }),
        uid: 501,
      },
    },
  }
  const code = await run(argv, io)
  const envelope = stdout.trim().startsWith("{") ? (JSON.parse(stdout) as ResultEnvelope<any>) : undefined
  return { code, stdout, stderr, envelope }
}

/** Every file under HOME, with its digest (to prove a command wrote nothing). */
function tree(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const s = lstatSync(p)
      if (s.isDirectory()) walk(p)
      else out[path.relative(home, p)] = `${s.size}:${s.mtimeMs}`
    }
  }
  walk(home)
  return out
}

async function enroll(home: string, central: Harness) {
  const approving = (async () => {
    for (let i = 0; i < 200; i++) {
      const list = (await (await central.api("/api/enrollments")).json()) as { enrollments: { userCode: string }[] }
      const code = list.enrollments[0]?.userCode
      if (code) return void (await central.api(`/api/enrollments/${code}/approve`, { method: "POST" }))
      await Bun.sleep(25)
    }
  })()
  const r = await cli(home, ["machine", "enroll", "--server", central.url, "--name", "ci-box", "--json"])
  await approving
  return r
}

const machineToken = (home: string) => (JSON.parse(readFileSync(path.join(home, ".config", "hub", "config.json"), "utf8")) as { token: string }).token

describe("hubctl machine", () => {
  test("status before enrollment is unconfigured (exit 0); enroll → verified; the token never appears", async () => {
    h = await harness()
    const home = tempHome()
    const before = await cli(home, ["machine", "status", "--json"])
    expect(before.code).toBe(0)
    expect(before.envelope).toMatchObject({ schema: "hub.bootstrap.result", command: "machine status", ok: true, data: { state: "unconfigured" } })

    const enrolled = await enroll(home, h)
    expect(enrolled.code).toBe(0)
    expect(enrolled.envelope).toMatchObject({ ok: true, data: { state: "verified", machineName: "ci-box" } })
    expect(enrolled.stderr).toContain("/approve?code=")
    const token = machineToken(home)
    expect(enrolled.stdout + enrolled.stderr).not.toContain(token)

    const after = await cli(home, ["machine", "status"])
    expect(after.code).toBe(0)
    expect(after.stdout).toContain("machine: verified")
    await h.store.revokeMachine(JSON.parse(readFileSync(path.join(home, ".config", "hub", "config.json"), "utf8")).machineID)
    const revoked = await cli(home, ["machine", "status", "--json"])
    expect(revoked.code).toBe(9)
    expect(revoked.envelope?.error?.code).toBe("revoked")
  })

  test("offline hub: exit 7; usage errors: exit 2", async () => {
    const home = tempHome()
    mkdirSync(path.join(home, ".config", "hub"), { recursive: true })
    writeFileSync(path.join(home, ".config", "hub", "config.json"), JSON.stringify({ server: "http://127.0.0.1:9", machineID: "mch_x", token: ["mt", "offline", "test"].join("_") }))
    expect((await cli(home, ["machine", "status", "--json"])).code).toBe(7)
    expect((await cli(home, ["machine", "status", "--no-verify", "--json"])).envelope?.data?.state).toBe("configured")
    expect((await cli(home, ["machine", "enroll"])).code).toBe(2)
    expect((await cli(home, ["machine"])).code).toBe(2)
  })
})

describe("hubctl setup (session-only, against a real hub)", () => {
  test("discover → preview (no writes) → apply → replay refused → verify → drift → rollback", async () => {
    h = await harness()
    const home = tempHome()
    expect((await enroll(home, h)).code).toBe(0)

    const discovered = await cli(home, ["setup", "discover", "--json"])
    expect(discovered.code).toBe(0)
    expect(discovered.envelope?.data).toMatchObject({ schema: "hub.discovery-snapshot", harnesses: [{ id: "opencode", installed: true }, { id: "claude-code" }, { id: "codex" }] })

    const before = tree(home)
    const preview = await cli(home, ["setup", "preview", "--profile", "session-only", "--json"])
    expect(preview.code).toBe(0)
    expect(preview.envelope?.data?.schema).toBe("hub.setup-preview")
    expect(preview.envelope?.data?.plan.actions.map((a: { kind: string }) => a.kind)).toEqual(["ensure-directory", "merge-config", "register-mcp-server", "verify-harness"])
    expect(tree(home)).toEqual(before)

    const file = path.join(home, "preview.json")
    const out = await cli(home, ["setup", "preview", "--profile", "session-only", "--out", file])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain("Setup plan for")
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // The hub sees this machine's OpenCode spoke: spoke-connected passes.
    const client = await spoke(h, { machine: { token: machineToken(home) }, hello: { harness: "opencode" } })
    const applied = await cli(home, ["setup", "apply", "--preview", file, "--json"])
    expect(applied.stderr).toBe("")
    expect(applied.code).toBe(0)
    expect(applied.envelope?.data?.state).toBe("committed")
    const config = JSON.parse(readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"))
    expect(JSON.stringify(config.plugins)).toContain("hub")
    expect(config.mcp.servers.hub.command).toEqual([path.join(home, ".local", "bin", "hubctl"), "mcp"])

    const replay = await cli(home, ["setup", "apply", "--preview", file, "--json"])
    expect(replay.code).toBe(12)
    expect(replay.envelope?.error?.code).toBe("preview_replayed")

    const ready = await cli(home, ["setup", "verify", "--profile", "session-only", "--json"])
    expect(ready.code).toBe(0)
    expect(ready.envelope?.data?.ready).toBe(true)

    const drift = await cli(home, ["setup", "drift", "--json"])
    expect(drift.code).toBe(0)
    expect(drift.envelope?.data?.inSync).toBe(true)

    client.close()
    for (let i = 0; i < 100 && h.registry.catalog().length > 0; i++) await Bun.sleep(20)
    const notReady = await cli(home, ["setup", "verify", "--profile", "session-only", "--json"])
    expect(notReady.code).toBe(15)
    expect(notReady.envelope?.error?.code).toBe("harness_not_ready")

    const rolled = await cli(home, ["setup", "rollback", "--json"])
    expect(rolled.code).toBe(0)
    expect(existsSync(path.join(home, ".config", "opencode", "opencode.json"))).toBe(false)

    for (const r of [discovered, preview, applied, ready, drift, rolled]) {
      expect(validateEnvelope(r.envelope).ok).toBe(true)
      expect(r.stdout + r.stderr).not.toContain(machineToken(home))
    }
    expect(readFileSync(file, "utf8")).not.toContain(machineToken(home))
  }, 30_000)

  test("refusals map through exitFor: a launch node without workspace roots (2), an unknown profile (2), a bad preview file (12)", async () => {
    const home = tempHome()
    const noRoots = await cli(home, ["setup", "preview", "--profile", "launch-node", "--json"])
    if (noRoots.envelope?.error?.code !== "no_service_manager") {
      expect(noRoots.code).toBe(2)
      expect(noRoots.envelope?.error?.message).toContain("--workspace-root")
    }
    expect((await cli(home, ["setup", "preview", "--profile", "nope", "--json"])).code).toBe(2)
    writeFileSync(path.join(home, "bad.json"), "{}")
    const bad = await cli(home, ["setup", "apply", "--preview", path.join(home, "bad.json"), "--json"])
    expect(bad.code).toBe(12)
  })

  test("a refused apply (stale preview) leaves no new filesystem entries under HOME", async () => {
    const home = tempHome()
    const file = path.join(home, "preview.json")
    expect((await cli(home, ["setup", "preview", "--profile", "session-only", "--out", file])).code).toBe(0)
    // The host changes after the preview: the saved preview is stale.
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), '{"theme":"light"}\n')
    const entries = () => {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const p = path.join(dir, name)
          out.push(path.relative(home, p))
          if (lstatSync(p).isDirectory()) walk(p)
        }
      }
      walk(home)
      return out
    }
    const before = entries()
    const refused = await cli(home, ["setup", "apply", "--preview", file, "--json"])
    expect(refused.envelope?.error?.code).toBe("preview_stale")
    expect(refused.code).toBe(12)
    expect(entries()).toEqual(before)
  })

  test("a profile from stdin (the Ansible role's `--profile -`), and setup recover with nothing to recover", async () => {
    const home = tempHome()
    const profile = JSON.stringify({ schema: "hub.bootstrap-profile", version: 2, revision: 1, id: "session-only", harnesses: ["opencode"], runtimes: [], services: [], launch: { enabled: false }, escalation: "never" })
    const r = await cli(home, ["setup", "preview", "--profile", "-", "--json"], { stdin: profile })
    expect(r.code).toBe(0)
    const recovered = await cli(home, ["setup", "recover", "--json"])
    expect(recovered.code).toBe(0)
    expect(recovered.envelope?.data).toMatchObject({ recovered: false })
  })
})

describe("hubctl setup (launch-node, fake service manager)", () => {
  test("units are written and loaded only with --confirm-activation, and a rollback unloads them", async () => {
    const home = tempHome()
    const probe = await cli(home, ["setup", "discover", "--json"])
    if (probe.envelope?.data?.managers?.service === "none") return // this host has no user service manager
    const seen: Seen = { calls: [] }
    const projects = path.join(home, "projects")
    mkdirSync(projects)
    const file = path.join(home, "node-preview.json")
    const preview = await cli(home, ["setup", "preview", "--profile", "launch-node", "--workspace-root", projects, "--confirm-activation", "--enrollment", "separate", "--out", file, "--json"], { seen })
    expect(preview.code).toBe(0)
    const kinds = preview.envelope?.data?.plan.actions.map((a: { kind: string }) => a.kind)
    expect(kinds).toContain("install-service")
    expect(kinds).toContain("activate-service")
    expect(preview.envelope?.warnings?.join(" ")).toMatch(/launchd|systemd/)
    expect(seen.calls).toEqual([])

    // Without --confirm-activation, apply refuses before changing anything (exit 4).
    const refused = await cli(home, ["setup", "apply", "--preview", file, "--json"], { seen })
    expect(refused.code).toBe(4)
    expect(seen.calls).toEqual([])
  })
})

describe("hubctl setup with a signed release manifest (pinned installs)", () => {
  test("installs hubctl and the pinned OpenCode, a rerun plans no install, verify is ready, rollback removes them", async () => {
    h = await harness()
    const home = tempHome()
    rmSync(path.join(home, "bin", "opencode")) // no OpenCode on PATH: hub installs the pinned one
    const target = `${process.platform}-${process.arch}`
    const key = ephemeralKey()
    const archive = process.platform === "darwin" ? { file: `opencode-${target}.zip`, bytes: zip([{ name: "opencode", content: FAKE_OPENCODE }]) } : { file: `opencode-${target}.tar.gz`, bytes: tarGz([{ name: "opencode", content: FAKE_OPENCODE }]) }
    const pin = { harness: "opencode" as const, version: "2.2.0", target, url: `https://github.com/anomalyco/opencode/releases/download/v2.2.0/${archive.file}`, file: archive.file, ...bytesInfo(archive.bytes), evidence: [] }
    const manifest = signWith(releaseBody("0.8.0", "0.7.0", [pin]), key)
    const manifestFile = path.join(home, "hubctl-manifest.json")
    writeFileSync(manifestFile, JSON.stringify(manifest))
    const hubctl = fakeBinary(target)
    const downloads: string[] = []
    const bootstrap = {
      machineID: "test-machine-id",
      trustRoot: canonicalJSON(rootOf(key)),
      ports: {
        uid: 501,
        hubctlBytes: () => hubctl,
        opencodeDownload: async (url: string) => (downloads.push(url), archive.bytes),
        serviceRunner: async () => ({ exitCode: 1 }),
      },
    }
    const with_ = async (argv: string[]) => {
      let stdout = ""
      let stderr = ""
      const code = await run(argv, { env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` }, home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), program: { execPath: process.execPath, entry: ENTRY }, bootstrap })
      return { code, stderr, envelope: JSON.parse(stdout) as ResultEnvelope<any> }
    }
    expect((await enroll(home, h)).code).toBe(0)
    const client = await spoke(h, { machine: { token: machineToken(home) }, hello: { harness: "opencode" } })

    const file = path.join(home, "preview.json")
    const preview = await with_(["setup", "preview", "--profile", "session-only", "--manifest", manifestFile, "--out", file, "--json"])
    expect(preview.envelope.error).toBeUndefined()
    expect(preview.code).toBe(0)
    expect(preview.envelope.data.plan.actions.map((a: { id: string }) => a.id)).toEqual(["state-dir", "install-hubctl", "link-hub", "install-opencode", "select-opencode", "opencode-plugin", "opencode-mcp", "verify-opencode"])

    const applied = await with_(["setup", "apply", "--preview", file, "--manifest", manifestFile, "--json"])
    expect(applied.envelope.error).toBeUndefined()
    expect(applied.code).toBe(0)
    expect(downloads).toEqual([pin.url])
    expect(readFileSync(path.join(home, ".local", "bin", "hubctl"))).toEqual(Buffer.from(hubctl))
    expect(lstatSync(path.join(home, ".local", "bin", "hub")).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(home, ".local", "share", "hub", "harnesses", "opencode", "current", "bin", "opencode"))).toBe(true)
    const state = JSON.parse(readFileSync(path.join(home, ".local", "state", "hub", "bootstrap", "state.json"), "utf8"))
    expect(state).toMatchObject({ profile: { id: "session-only" }, catalogRevision: 1, floors: { hubctl: "0.7.0" } })

    // Rerun: the hub-installed OpenCode is discovered (off PATH), so nothing is installed again.
    const again = await with_(["setup", "preview", "--profile", "session-only", "--manifest", manifestFile, "--json"])
    expect(again.envelope.error).toBeUndefined()
    expect(again.code).toBe(0)
    expect(again.envelope.data.plan.actions.map((a: { kind: string }) => a.kind)).not.toContain("install-harness")

    expect((await with_(["setup", "verify", "--profile", "session-only", "--json"])).code).toBe(0)
    client.close()

    const rolled = await with_(["setup", "rollback", "--json"])
    expect(rolled.code).toBe(0)
    for (const p of [".local/bin/hubctl", ".local/bin/hub", ".local/share/hub/harnesses/opencode/current", ".config/opencode/opencode.json"]) expect(existsSync(path.join(home, p))).toBe(false)
  }, 30_000)

  test("a manifest this hubctl's trust root did not sign is refused (exit 11)", async () => {
    const home = tempHome()
    const manifest = signWith(releaseBody(), ephemeralKey())
    writeFileSync(path.join(home, "m.json"), JSON.stringify(manifest))
    const r = await cli(home, ["setup", "preview", "--manifest", path.join(home, "m.json"), "--json"])
    expect(r.code).toBe(11)
    expect(r.envelope?.error?.code).toBe("signature_invalid")
  })
})

// HBS-12 acceptance: on a fresh, enrolled host the provider login and the spoke can only happen after the install
// (the user needs the installed OpenCode for `opencode auth login` and to start it). So apply commits a harness that
// only waits on the user as "installed, not ready" (exit 0) and `setup verify` stays the strict gate (exit 15);
// `apply --require-ready` keeps the old all-or-nothing behaviour (exit 15, rolled back).
describe("hubctl setup on a fresh host: install is not readiness (contract v1.2)", () => {
  // `opencode models` fails until the user logs in (a marker file), and, like the real one, writes into its config
  // directory while it runs.
  const PENDING_OPENCODE = `#!/bin/sh
case "$1" in
  --version) echo "opencode v2.2.0" ;;
  models)
    mkdir -p "$HOME/.config/opencode/node_modules" && echo "{}" > "$HOME/.config/opencode/node_modules/.lock"
    if [ -f "$HOME/.logged-in" ]; then echo "anthropic/claude-sonnet-4"; else echo "no providers" >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`

  async function freshHost() {
    h = await harness()
    const home = tempHome()
    rmSync(path.join(home, "bin", "opencode"))
    const target = `${process.platform}-${process.arch}`
    const key = ephemeralKey()
    const archive = process.platform === "darwin" ? { file: `opencode-${target}.zip`, bytes: zip([{ name: "opencode", content: PENDING_OPENCODE }]) } : { file: `opencode-${target}.tar.gz`, bytes: tarGz([{ name: "opencode", content: PENDING_OPENCODE }]) }
    const pin = { harness: "opencode" as const, version: "2.2.0", target, url: `https://github.com/anomalyco/opencode/releases/download/v2.2.0/${archive.file}`, file: archive.file, ...bytesInfo(archive.bytes), evidence: [] }
    const manifestFile = path.join(home, "hubctl-manifest.json")
    writeFileSync(manifestFile, JSON.stringify(signWith(releaseBody("0.8.0", "0.7.0", [pin]), key)))
    const hubctl = fakeBinary(target)
    const bootstrap = { machineID: "test-machine-id", trustRoot: canonicalJSON(rootOf(key)), ports: { uid: 501, hubctlBytes: () => hubctl, opencodeDownload: async () => archive.bytes, serviceRunner: async () => ({ exitCode: 1 }) } }
    const hubctlRun = async (argv: string[]) => {
      let stdout = ""
      let stderr = ""
      const code = await run(argv, { env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` }, home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), program: { execPath: process.execPath, entry: ENTRY }, bootstrap })
      return { code, stdout, stderr, envelope: stdout.trim().startsWith("{") ? (JSON.parse(stdout) as ResultEnvelope<any>) : undefined }
    }
    expect((await enroll(home, h)).code).toBe(0)
    const preview = async (name: string) => {
      const file = path.join(home, name)
      const r = await hubctlRun(["setup", "preview", "--profile", "session-only", "--manifest", manifestFile, "--out", file, "--json"])
      expect(r.code).toBe(0)
      return file
    }
    return { home, manifestFile, hubctlRun, preview }
  }

  test("apply commits installed-not-ready (exit 0) → verify 15 → the user logs in and starts OpenCode → verify 0", async () => {
    const { home, manifestFile, hubctlRun, preview } = await freshHost()
    const applied = await hubctlRun(["setup", "apply", "--preview", await preview("p1.json"), "--manifest", manifestFile, "--json"])
    expect(applied.envelope?.error).toBeUndefined()
    expect(applied.code).toBe(0)
    expect(validateEnvelope(applied.envelope).ok).toBe(true)
    expect(applied.envelope?.data?.state).toBe("committed")
    expect(applied.envelope?.data?.ready).toBe(false)
    const oc = applied.envelope?.data?.harnesses.find((x: { harness: string }) => x.harness === "opencode")
    expect(oc.state).toBe("installed-not-ready")
    expect(oc.probes.map((p: { kind: string; class: string; status: string }) => [p.kind, p.class, p.status])).toEqual([
      ["version-exec", "integrity", "pass"],
      ["provider-auth", "user", "pending"],
      ["spoke-connected", "user", "pending"],
    ])
    expect(oc.nextSteps.join("\n")).toContain("opencode auth login")
    expect(oc.nextSteps.at(-1)).toContain("hubctl setup verify")
    expect(existsSync(path.join(home, ".local", "share", "hub", "harnesses", "opencode", "current", "bin", "opencode"))).toBe(true)
    expect(existsSync(path.join(home, ".local", "bin", "hubctl"))).toBe(true)

    const notReady = await hubctlRun(["setup", "verify", "--json"])
    expect(notReady.code).toBe(15)
    expect(notReady.envelope?.error?.code).toBe("harness_not_ready")
    expect(notReady.envelope?.data?.harnesses[0]).toMatchObject({ harness: "opencode", ready: false, state: "installed-not-ready" })

    writeFileSync(path.join(home, ".logged-in"), "")
    const client = await spoke(h!, { machine: { token: machineToken(home) }, hello: { harness: "opencode" } })
    const ready = await hubctlRun(["setup", "verify", "--json"])
    expect(ready.code).toBe(0)
    expect(ready.envelope?.data?.harnesses[0]).toMatchObject({ harness: "opencode", ready: true, state: "ready" })
    client.close()
  }, 30_000)

  test("text output names the harness as installed, not ready, with the next steps", async () => {
    const { manifestFile, hubctlRun, preview } = await freshHost()
    const applied = await hubctlRun(["setup", "apply", "--preview", await preview("p1.json"), "--manifest", manifestFile])
    expect(applied.code).toBe(0)
    expect(applied.stdout).toContain("opencode: installed, not ready")
    expect(applied.stdout).toContain("opencode auth login")
    expect(applied.stdout).toContain("hubctl setup verify")
  }, 30_000)

  test("with --require-ready the same apply fails with harness_not_ready (15) and rolls everything back", async () => {
    const { home, manifestFile, hubctlRun, preview } = await freshHost()
    const strict = await hubctlRun(["setup", "apply", "--preview", await preview("p1.json"), "--manifest", manifestFile, "--require-ready", "--json"])
    expect(strict.code).toBe(15)
    expect(strict.envelope?.error?.code).toBe("harness_not_ready")
    expect(strict.envelope?.data?.state).toBe("rolled-back")
    for (const p of [".local/bin/hubctl", ".local/bin/hub", ".local/share/hub/harnesses/opencode/current", ".config/opencode/opencode.json"]) expect(existsSync(path.join(home, p))).toBe(false)
  }, 30_000)
})
