// The Claude Code HarnessSource: it downloads the pinned binary, attempts the upstream evidence the pin lists (the
// GPG-signed manifest.json, macOS notarization through fixed-argv codesign) and unpacks the single binary. The pinned
// sha256 stays mandatory and is checked by the install executor; any failed evidence rejects the artifact.
import { describe, expect, test } from "bun:test"
import { checkHarnessEvidence, findSecrets, type InstallHarness } from "../src/bootstrap/contracts/index.ts"
import { CODESIGN, createClaudeHarnessSource, upstreamPlatform } from "../src/bootstrap/adapters/claude/source.ts"
import { armoredSignature, CLAUDE_BINARIES, CLAUDE_VERSION, claudePin, FakeRunner, FakeScratch, pgpKey, RELEASES, signedHubManifest, upstreamManifest, upstreamRelease, type ClaudeTarget } from "./bootstrap/claude-adapter-fixtures.ts"

const manifest = signedHubManifest()

function installFor(target: ClaudeTarget): InstallHarness {
  const pin = claudePin(target)
  return {
    id: "install-claude-code",
    kind: "install-harness",
    escalation: "user",
    summary: "Install Claude Code",
    harness: "claude-code",
    version: pin.version,
    target: pin.target,
    source: { manifest: manifest.release, url: pin.url, file: pin.file },
    size: pin.size,
    sha256: pin.sha256,
    evidence: [...pin.evidence],
    path: { root: "data", rel: `hub/harnesses/claude-code/${pin.version}` },
    owner: "hub",
    rollback: "restore-previous",
  }
}

/** codesign answers: identity check exit code, then the notarized check exit code. */
const codesign = (identity: number | "missing", notarized = 0) =>
  new FakeRunner((file, args) => {
    if (identity === "missing") return { kind: "not-found" }
    expect(file).toBe(CODESIGN.program)
    return { kind: "exited", code: args.some((a) => a.includes("notarized")) ? notarized : identity, stdout: "" }
  })

function source(options: { release?: ReturnType<typeof upstreamRelease>; runner?: FakeRunner; platform?: string; fingerprint?: string } = {}) {
  const release = options.release ?? upstreamRelease()
  const runner = options.runner ?? codesign(0)
  const scratch = new FakeScratch()
  const src = createClaudeHarnessSource({
    manifest,
    download: release.downloads,
    runner,
    scratch,
    platform: options.platform ?? "darwin",
    signingKey: { fingerprint: options.fingerprint ?? release.key.fingerprint },
  })
  return { src, release, runner, scratch }
}

const statusOf = (evidence: readonly { kind: string; status: string }[], kind: string) => evidence.find((e) => e.kind === kind)?.status

describe("createClaudeHarnessSource fetch", () => {
  test("downloads the pinned URL and verifies both kinds of evidence on macOS", async () => {
    const { src, release, runner, scratch } = source()
    const action = installFor("darwin-arm64")
    const got = await src.fetch(action)
    expect(got.bytes).toEqual(CLAUDE_BINARIES["darwin-arm64"])
    expect(statusOf(got.evidence, "gpg-manifest")).toBe("verified")
    expect(statusOf(got.evidence, "macos-notarization")).toBe("verified")
    expect(release.downloads.requests).toContain(action.source.url)
    expect(release.downloads.requests).toContain(`${RELEASES}/${CLAUDE_VERSION}/manifest.json.sig`)
    // codesign ran on a scratch copy of exactly the downloaded bytes, with fixed argv.
    expect(scratch.files).toEqual([CLAUDE_BINARIES["darwin-arm64"]])
    expect(runner.calls.map((c) => c.args.slice(0, -1))).toEqual([[...CODESIGN.identity], [...CODESIGN.notarized]])
    expect(runner.calls.every((c) => c.args.at(-1) === "/scratch/claude-1")).toBe(true)
    const report = checkHarnessEvidence(action, { sha256: action.sha256, size: action.size }, got.evidence)
    expect(report.ok).toBe(true)
  })

  test("on Linux only the manifest is attempted; the pin lists no notarization", async () => {
    const { src, runner } = source({ platform: "linux" })
    const got = await src.fetch(installFor("linux-x64"))
    expect(got.evidence.map((e) => [e.kind, e.status])).toEqual([["gpg-manifest", "verified"]])
    expect(runner.calls).toEqual([])
  })

  test("notarization is unavailable off macOS or without codesign, never failed", async () => {
    const linuxHost = await source({ platform: "linux" }).src.fetch(installFor("darwin-arm64"))
    expect(statusOf(linuxHost.evidence, "macos-notarization")).toBe("unavailable")
    const noCodesign = await source({ runner: codesign("missing") }).src.fetch(installFor("darwin-arm64"))
    expect(statusOf(noCodesign.evidence, "macos-notarization")).toBe("unavailable")
  })

  test("signed by Anthropic but notarization not confirmable (offline) is unavailable", async () => {
    const got = await source({ runner: codesign(0, 3) }).src.fetch(installFor("darwin-arm64"))
    expect(statusOf(got.evidence, "macos-notarization")).toBe("unavailable")
  })

  test("a binary not signed by Anthropic fails notarization, and the evidence rejects it", async () => {
    for (const code of [1, 3]) {
      const action = installFor("darwin-arm64")
      const got = await source({ runner: codesign(code) }).src.fetch(action)
      expect(statusOf(got.evidence, "macos-notarization")).toBe("failed")
      const report = checkHarnessEvidence(action, { sha256: action.sha256, size: action.size }, got.evidence)
      expect(report.ok ? "ok" : report.issues[0]!.code).toBe("evidence_failed")
    }
  })

  test("a bad manifest signature fails the gpg evidence; one by an unknown key is unavailable", async () => {
    const key = pgpKey()
    const manifestBytes = upstreamManifest(CLAUDE_VERSION)
    // Forged: another key's signature claiming to be the pinned key's.
    const forged = upstreamRelease({ key, manifest: manifestBytes, signature: armoredSignature(pgpKey(), manifestBytes, { issuer: key.fingerprint }) })
    expect(statusOf((await source({ release: forged }).src.fetch(installFor("darwin-arm64"))).evidence, "gpg-manifest")).toBe("failed")
    const unknown = upstreamRelease({ key, manifest: manifestBytes, signature: armoredSignature(pgpKey(), manifestBytes) })
    expect(statusOf((await source({ release: unknown }).src.fetch(installFor("darwin-arm64"))).evidence, "gpg-manifest")).toBe("unavailable")
  })

  test("a signed manifest that lists other bytes fails", async () => {
    const other = { "darwin-arm64": new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]) }
    const release = upstreamRelease({ binaries: other })
    release.downloads.set(`${RELEASES}/${CLAUDE_VERSION}/darwin-arm64/claude`, CLAUDE_BINARIES["darwin-arm64"])
    const got = await source({ release }).src.fetch(installFor("darwin-arm64"))
    expect(statusOf(got.evidence, "gpg-manifest")).toBe("failed")
  })

  test("a signed manifest for another version fails", async () => {
    const key = pgpKey()
    const release = upstreamRelease({ key, manifest: upstreamManifest("2.1.91") })
    expect(statusOf((await source({ release }).src.fetch(installFor("darwin-arm64"))).evidence, "gpg-manifest")).toBe("failed")
  })

  test("no signature published (releases before 2.1.89) or an unreachable bucket is unavailable", async () => {
    const unsigned = upstreamRelease({ signature: new Error("404") })
    expect(statusOf((await source({ release: unsigned }).src.fetch(installFor("darwin-arm64"))).evidence, "gpg-manifest")).toBe("unavailable")
    const noKey = upstreamRelease()
    noKey.downloads.set("https://downloads.claude.ai/keys/claude-code.asc", new Error("offline"))
    expect(statusOf((await source({ release: noKey }).src.fetch(installFor("darwin-arm64"))).evidence, "gpg-manifest")).toBe("unavailable")
  })

  test("the published key must be the pinned one", async () => {
    const got = await source({ fingerprint: "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE" }).src.fetch(installFor("darwin-arm64"))
    expect(statusOf(got.evidence, "gpg-manifest")).toBe("unavailable")
  })

  test("a pin outside the upstream release bucket cannot use the upstream manifest", async () => {
    const action = { ...installFor("darwin-arm64"), source: { ...installFor("darwin-arm64").source, url: "https://mirror.example/claude" } }
    const release = upstreamRelease()
    release.downloads.set("https://mirror.example/claude", CLAUDE_BINARIES["darwin-arm64"])
    const got = await source({ release }).src.fetch(action)
    expect(statusOf(got.evidence, "gpg-manifest")).toBe("unavailable")
  })

  test("evidence details carry no secrets and are single lines", async () => {
    const got = await source({ runner: codesign(1) }).src.fetch(installFor("darwin-arm64"))
    expect(findSecrets(got.evidence)).toEqual([])
    for (const e of got.evidence) expect(e.detail ?? "").not.toContain("\n")
  })

  test("only Claude Code installs are served", async () => {
    await expect(source().src.fetch({ ...installFor("darwin-arm64"), harness: "codex" } as InstallHarness)).rejects.toThrow()
  })
})

describe("unpack", () => {
  test("the single binary becomes <version>/claude, executable", async () => {
    const { src } = source()
    const files = await src.unpack(installFor("darwin-arm64"), CLAUDE_BINARIES["darwin-arm64"])
    expect(files.ok && files.value.map((f) => [f.rel, f.mode])).toEqual([["claude", 0o755]])
  })

  test("a binary for another platform is refused", async () => {
    const { src } = source()
    const r = await src.unpack(installFor("darwin-arm64"), CLAUDE_BINARIES["linux-x64"])
    expect(r.ok ? "ok" : r.code).toBe("invalid")
    const r2 = await src.unpack(installFor("linux-x64"), CLAUDE_BINARIES["darwin-arm64"])
    expect(r2.ok ? "ok" : r2.code).toBe("invalid")
  })

  test("other pinned file shapes (compressed, archives) are refused", async () => {
    const { src } = source()
    const r = await src.unpack({ ...installFor("darwin-arm64"), source: { ...installFor("darwin-arm64").source, file: "claude.zst" } }, CLAUDE_BINARIES["darwin-arm64"])
    expect(r.ok ? "ok" : r.code).toBe("invalid")
  })
})

describe("upstreamPlatform", () => {
  test("hub targets map to upstream's platform names (glibc Linux only)", () => {
    expect(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].map(upstreamPlatform)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"])
    expect(upstreamPlatform("linux-x64-musl")).toBeUndefined()
  })
})

describe("installed and floor", () => {
  test("come from the options (the history), for the downgrade policy", () => {
    const src = createClaudeHarnessSource({ manifest, download: upstreamRelease().downloads, platform: "darwin", installed: { version: "2.1.85", sha256: `sha256:${"c".repeat(64)}` }, floor: "2.1.89", allowDowngrade: true })
    expect(src.installed?.("claude-code")).toEqual({ version: "2.1.85", sha256: `sha256:${"c".repeat(64)}` })
    expect(src.installed?.("codex")).toBeUndefined()
    expect(src.floor?.("claude-code")).toBe("2.1.89")
    expect(src.allowDowngrade).toBe(true)
  })
})
