// End to end through the real transaction engine on a fake host (a temporary directory; no real home, ~/.claude
// or network): preview → apply of the Claude Code plan with a fake installer, fake upstream and fake probes. It
// proves the install is verified before it counts, a failed probe or evidence rolls everything back (the previous
// version current again, hub's config restored), ~/.claude is never touched, and no credential is captured anywhere.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createAdapterRegistry, findSecrets, planDigest, sha256Hex, type DiscoverySnapshot, type Profile, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { claudeExecutors, createClaudeAdapter, createClaudeHarnessSource, type ClaudeAdapterOptions } from "../src/bootstrap/adapters/claude/index.ts"
import { createNodeProbe } from "../src/bootstrap/discovery/node-probe.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { builtinExecutors } from "../src/bootstrap/transaction/builtin.ts"
import { createApplier } from "../src/bootstrap/transaction/engine.ts"
import { CLAUDE_BINARIES, CLAUDE_VERSION, FakeRunner, FakeScratch, signedHubManifest, upstreamRelease } from "./bootstrap/claude-adapter-fixtures.ts"
import { DISCOVERY_DARWIN, HOST, MINUTE, PREVIEW, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"
import { sandbox, type Sandbox } from "./bootstrap/transaction-fixtures.ts"

const PROFILE: Profile = { ...PROFILE_SESSION_ONLY, harnesses: ["claude-code"] }
/** Credential-shaped values planted in the user's Claude Code files and environment. */
const PLANTED = { credential: "sk-ant-oat01-PLANTEDsecretPLANTEDsecret0123456789abcdef", apiKey: "sk-ant-api03-PLANTEDapikeyPLANTEDapikey0123456789", email: "dev@example.com" }
const USER_CLAUDE = {
  ".claude.json": `{\n  "theme": "dark",\n  "oauthAccount": {"emailAddress": "${PLANTED.email}"}\n}\n`,
  ".claude/settings.json": '{\n  // user settings\n  "model": "opus",\n  "hooks": {}\n}\n',
  ".claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: PLANTED.credential, refreshToken: PLANTED.credential } }),
}

let boxes: Sandbox[] = []
afterEach(() => {
  for (const b of boxes) b.cleanup()
  boxes = []
})

interface Host {
  readonly box: Sandbox
  readonly manifest: VerifiedManifest
  now: number
  nonce: number
}

function host(): Host {
  const box = sandbox()
  boxes.push(box)
  for (const [rel, text] of Object.entries(USER_CLAUDE)) {
    mkdirSync(join(box.path("home", rel), ".."), { recursive: true })
    writeFileSync(box.path("home", rel), text, { mode: 0o600 })
  }
  return { box, manifest: signedHubManifest(), now: T0 + MINUTE, nonce: 0 }
}

/** What discovery would report for this sandbox (claude-code presence and hub configs from the disk). */
function snapshotOf(h: Host, presence: Partial<DiscoverySnapshot["harnesses"][number]> = {}): DiscoverySnapshot {
  const configs = existsSync(h.box.path("config", "hub/claude-code.json"))
    ? [{ path: h.box.path("config", "hub/claude-code.json"), owner: "hub" as const, format: "json" as const, sha256: `sha256:${sha256Hex(readFileSync(h.box.path("config", "hub/claude-code.json")))}` }]
    : []
  return {
    ...DISCOVERY_DARWIN,
    harnesses: DISCOVERY_DARWIN.harnesses.map((x) => (x.id === "claude-code" ? { ...x, ...presence } : x)),
    configs,
    roots: h.box.roots,
  }
}

interface Fakes {
  readonly spokeConnected?: boolean
  readonly codesignIdentity?: number
  readonly tampered?: boolean
  readonly version?: string
}

function setup(h: Host, fakes: Fakes = {}, adapterOptions: Partial<ClaudeAdapterOptions> = {}, presence: Partial<DiscoverySnapshot["harnesses"][number]> = {}) {
  const release = upstreamRelease()
  if (fakes.tampered) release.downloads.set(`https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/darwin-arm64/claude`, new Uint8Array([...CLAUDE_BINARIES["darwin-arm64"], 0]))
  const runner = new FakeRunner((file, args) => {
    if (file === "/usr/bin/codesign") return { kind: "exited", code: args.some((a) => a.includes("notarized")) ? 0 : (fakes.codesignIdentity ?? 0), stdout: "" }
    // The probes run the binary hub installed, which really is there.
    if (!existsSync(file)) return { kind: "not-found" }
    if (args[0] === "--version") return { kind: "exited", code: 0, stdout: `${fakes.version ?? CLAUDE_VERSION} (Claude Code)\n` }
    if (args[0] === "auth") return { kind: "exited", code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: PLANTED.email, accessToken: PLANTED.credential }) }
    return { kind: "error", message: "unexpected probe" }
  })
  const env = { HOME: h.box.path("home", ""), PATH: "", ANTHROPIC_API_KEY: PLANTED.apiKey }
  const probe = createNodeProbe({ env, home: h.box.roots[0]!.path, runtime: null, machineID: "test" })
  const options: ClaudeAdapterOptions = {
    manifest: h.manifest,
    probe,
    roots: h.box.roots,
    probes: {
      runner,
      spoke: async () => (fakes.spokeConnected === false ? { connected: false } : { connected: true, harness: "claude-code", evidence: "hooks", features: ["stop", "permission"] }),
      conformance: async () => ({ ok: true }),
    },
    ...adapterOptions,
  }
  const adapter = createClaudeAdapter(options)
  const registry = createAdapterRegistry()
  registry.register(adapter)
  const snapshot = snapshotOf(h, presence)
  const planned = planSetup({ snapshot, profile: PROFILE, links: () => undefined, adapters: registry })
  if (!planned.ok) throw new Error(JSON.stringify(planned.issues))
  const source = createClaudeHarnessSource({ manifest: h.manifest, download: release.downloads, runner, scratch: new FakeScratch(), platform: "darwin", signingKey: { fingerprint: release.key.fingerprint }, ...(options.installed ? { installed: options.installed } : {}) })
  const verifications: unknown[] = []
  const ctx = { env, home: h.box.roots[0]!.path, platform: "darwin", arch: "arm64", now: () => h.now }
  const executors = {
    ...builtinExecutors({ harness: source }),
    ...claudeExecutors({ source, verify: () => adapter.verify(ctx), now: () => h.now, onVerified: (v) => verifications.push(v) }),
  }
  const applier = createApplier({ roots: h.box.roots, host: { fingerprint: HOST, target: "darwin-arm64" }, executors, now: () => h.now, pid: 4242, isAlive: () => true, newID: () => `tx_c${++h.nonce}` })
  const plan = planned.value.plan
  const token = { ...PREVIEW, planDigest: planDigest(plan), snapshotDigest: plan.snapshotDigest, issuedAt: h.now - 1000, expiresAt: h.now + 10 * MINUTE, nonce: `nonce-claude-${h.nonce}-0123456789` }
  const apply = () => applier.apply({ token, replan: async () => ({ plan, snapshot, blockers: planned.value.blockers, evidence: planned.value.evidence }) })
  return { apply, plan, runner, verifications, release }
}

/** Every file under a directory (rel → bytes digest), for "nothing changed" checks. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const a = join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      const s = statSync(a)
      if (s.isDirectory()) walk(a, r)
      else out[r] = `${(s.mode & 0o777).toString(8)} ${sha256Hex(readFileSync(a))}`
    }
  }
  if (existsSync(dir)) walk(dir, "")
  return out
}

const userClaude = (h: Host) => ({ dir: tree(h.box.path("home", ".claude")), json: readFileSync(h.box.path("home", ".claude.json"), "utf8") })

/** Everything hubctl wrote: the bootstrap state (journals, plans, backups) and hub's own config. */
function hubWritten(h: Host): string {
  const files: string[] = []
  const walk = (abs: string) => {
    if (!existsSync(abs)) return
    for (const name of readdirSync(abs)) {
      const a = join(abs, name)
      if (statSync(a).isDirectory()) walk(a)
      else files.push(readFileSync(a, "utf8"))
    }
  }
  walk(h.box.path("state", "hub"))
  walk(h.box.path("config", "hub"))
  return files.join("\n")
}

const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)
const versionDir = (h: Host, v: string) => h.box.path("data", `hub/harnesses/claude-code/${v}`)
const currentLink = (h: Host) => h.box.path("data", "hub/harnesses/claude-code/current")

describe("applying the Claude Code plan", () => {
  test("installs the pinned binary, makes it current, points hub's config at it, and verifies for real", async () => {
    const h = host()
    const before = userClaude(h)
    const { apply, runner, verifications } = setup(h)
    const r = await apply()
    expect(codeOf(r)).toBe("ok")
    if (!r.ok) return
    expect(r.report.state).toBe("committed")
    const bin = join(versionDir(h, CLAUDE_VERSION), "claude")
    expect(new Uint8Array(readFileSync(bin))).toEqual(CLAUDE_BINARIES["darwin-arm64"])
    expect(statSync(bin).mode & 0o777).toBe(0o755)
    expect(readlinkSync(currentLink(h))).toBe(CLAUDE_VERSION)
    expect(JSON.parse(readFileSync(h.box.path("config", "hub/claude-code.json"), "utf8"))).toEqual({ binary: join(currentLink(h), "claude") })
    // Evidence: the mandatory pin first, then both upstream checks, recorded in the report.
    expect(r.report.evidence.flatMap((e) => e.results.map((x) => `${x.kind}:${x.status}`))).toEqual(["sha256-pin:verified", "gpg-manifest:verified", "macos-notarization:verified"])
    // Readiness ran against the hub-installed binary.
    expect(runner.calls.filter((c) => c.file !== "/usr/bin/codesign").map((c) => c.file)).toEqual([join(currentLink(h), "claude"), join(currentLink(h), "claude")])
    expect(verifications).toHaveLength(1)
    expect(userClaude(h)).toEqual(before)
  })

  test("a failing probe is not ready: the whole install rolls back", async () => {
    const h = host()
    const before = userClaude(h)
    const r = await setup(h, { spokeConnected: false }).apply()
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(!r.ok && r.report?.state).toBe("rolled-back")
    expect(existsSync(versionDir(h, CLAUDE_VERSION))).toBe(false)
    expect(existsSync(currentLink(h))).toBe(false)
    expect(existsSync(h.box.path("config", "hub/claude-code.json"))).toBe(false)
    expect(userClaude(h)).toEqual(before)
  })

  test("the binary reporting another version is not ready either", async () => {
    const h = host()
    expect(codeOf(await setup(h, { version: "2.1.85" }).apply())).toBe("harness_not_ready")
    expect(existsSync(versionDir(h, CLAUDE_VERSION))).toBe(false)
  })

  test("an upgrade that fails verification makes the previous version current again and restores hub's config", async () => {
    const h = host()
    const old = versionDir(h, "2.1.85")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "claude"), "old claude")
    chmodSync(join(old, "claude"), 0o755)
    symlinkSync("2.1.85", currentLink(h))
    mkdirSync(h.box.path("config", "hub"), { recursive: true })
    const config = '{\n  "binary": "/elsewhere/claude",\n  "x-user-note": "kept"\n}\n'
    writeFileSync(h.box.path("config", "hub/claude-code.json"), config)
    const installed = { version: "2.1.85", sha256: `sha256:${sha256Hex("old claude")}` }
    const r = await setup(h, { spokeConnected: false }, { installed }, { installed: true, installMethod: "hub", version: "2.1.85", path: join(currentLink(h), "claude") }).apply()
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(readlinkSync(currentLink(h))).toBe("2.1.85")
    expect(readFileSync(join(old, "claude"), "utf8")).toBe("old claude")
    expect(existsSync(versionDir(h, CLAUDE_VERSION))).toBe(false)
    expect(readFileSync(h.box.path("config", "hub/claude-code.json"), "utf8")).toBe(config)
  })

  test("an upgrade that verifies keeps the user's other keys in hub's config", async () => {
    const h = host()
    const old = versionDir(h, "2.1.85")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "claude"), "old claude")
    symlinkSync("2.1.85", currentLink(h))
    mkdirSync(h.box.path("config", "hub"), { recursive: true })
    writeFileSync(h.box.path("config", "hub/claude-code.json"), '{\n  "binary": "/elsewhere/claude",\n  "x-user-note": "kept"\n}\n')
    const r = await setup(h, {}, { installed: { version: "2.1.85", sha256: `sha256:${sha256Hex("old claude")}` } }, { installed: true, installMethod: "hub", version: "2.1.85" }).apply()
    expect(codeOf(r)).toBe("ok")
    expect(readlinkSync(currentLink(h))).toBe(CLAUDE_VERSION)
    expect(JSON.parse(readFileSync(h.box.path("config", "hub/claude-code.json"), "utf8"))).toEqual({ binary: join(currentLink(h), "claude"), "x-user-note": "kept" })
    expect(existsSync(old)).toBe(true)
  })

  test("failed evidence rejects the artifact before anything is installed", async () => {
    const h = host()
    const r = await setup(h, { codesignIdentity: 3 }).apply()
    expect(codeOf(r)).toBe("evidence_failed")
    expect(existsSync(versionDir(h, CLAUDE_VERSION))).toBe(false)
  })

  test("a tampered download is refused by the mandatory pin", async () => {
    const h = host()
    expect(codeOf(await setup(h, { tampered: true }).apply())).toBe("integrity_mismatch")
    expect(existsSync(versionDir(h, CLAUDE_VERSION))).toBe(false)
  })
})

describe("no credential is captured", () => {
  test("nothing hubctl wrote, planned, reported or verified holds a Claude credential or account data", async () => {
    for (const fakes of [{}, { spokeConnected: false }] as Fakes[]) {
      const h = host()
      const { apply, plan, verifications } = setup(h, fakes)
      const r = await apply()
      const everything = [hubWritten(h), JSON.stringify(plan), JSON.stringify(r), JSON.stringify(verifications)].join("\n")
      for (const planted of Object.values(PLANTED)) expect(everything).not.toContain(planted)
      expect(findSecrets({ plan, report: r, verifications })).toEqual([])
      // No backup of any ~/.claude file was ever taken (they were never touched).
      expect(Object.keys(tree(h.box.path("state", "hub/bootstrap/backups"))).length).toBe(0)
    }
  })
})
