// The release tool (packages/cli/src/bootstrap/release/cli.ts, run as `bun scripts/hubctl-release.ts`): build argv,
// manifest generation from dist/ and the reviewed pin list, signing with the key from the environment (never
// echoed), and verification of every artifact. Keys are ephemeral; builds are recorded, not run (see
// bootstrap-release-build.test.ts for a real compile).
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SUPPORTED_TARGETS, canonicalJSON, validateArtifactManifest, verifyManifest } from "../src/bootstrap/contracts/index.ts"
import { SIGNING_KEY_ENV, hubctlBuildArgv, runRelease, type ReleaseIo } from "../src/bootstrap/release/cli.ts"
import { TRUST_ROOT_DEFINE } from "../src/bootstrap/release/trust-root.ts"
import { HARNESS_PINS } from "./bootstrap/fixtures.ts"
import { bytesInfo, ephemeralKey, fakeBinary, rootOf } from "./bootstrap/release-fixtures.ts"

const repo = path.join(import.meta.dir, "..", "..", "..")
const version = JSON.parse(readFileSync(path.join(repo, "packages/cli/package.json"), "utf8")).version as string

function harness(env: Record<string, string> = {}, extra: Partial<ReleaseIo> = {}) {
  let out = ""
  let err = ""
  const runs: string[][] = []
  const io: ReleaseIo = {
    env,
    cwd: repo,
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    run: async (argv) => (runs.push(argv), 0),
    download: async () => {
      throw new Error("no network in tests")
    },
    now: () => 1_793_000_000_000,
    ...extra,
  }
  return { io, runs, out: () => out, err: () => err }
}

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "hubctl-release-"))
  const dist = path.join(dir, "dist")
  mkdirSync(dist)
  for (const t of SUPPORTED_TARGETS) writeFileSync(path.join(dist, `hubctl-${t.target}`), fakeBinary(t.target, version))
  const pins = path.join(dir, "pins.json")
  writeFileSync(pins, JSON.stringify({ schema: "hub.harness-pin-list", version: 1, pins: [] }))
  const key = ephemeralKey()
  const root = path.join(dir, "trust-root.json")
  writeFileSync(root, JSON.stringify(rootOf(key)))
  return { dir, dist, pins, key, root, file: (name: string) => path.join(dir, name) }
}

async function unsignedManifest(w: ReturnType<typeof workspace>) {
  const h = harness()
  const code = await runRelease(["manifest", "--dist", w.dist, "--pins", w.pins, "--minimum-version", "0.0.1", "--out", w.file("unsigned.json")], h.io)
  expect(code).toBe(0)
  return w.file("unsigned.json")
}

async function signedManifest(w: ReturnType<typeof workspace>) {
  const unsigned = await unsignedManifest(w)
  const h = harness({ [SIGNING_KEY_ENV]: w.key.pem })
  expect(await runRelease(["sign", "--in", unsigned, "--out", w.file("hubctl-manifest.json"), "--trust-root", w.root], h.io)).toBe(0)
  return w.file("hubctl-manifest.json")
}

describe("build", () => {
  test("hubctlBuildArgv compiles main.ts for the target's bun target into dist/hubctl-<target>", () => {
    const root = rootOf(ephemeralKey())
    const argv = hubctlBuildArgv("linux-arm64", { bun: "/opt/bun", outdir: "/x/dist", root })
    expect(argv.slice(0, 3)).toEqual(["/opt/bun", "build", "--compile"])
    expect(argv).toContain("--target=bun-linux-arm64")
    expect(argv).toContain("packages/cli/src/main.ts")
    expect(argv.slice(-2)).toEqual(["--outfile", "/x/dist/hubctl-linux-arm64"])
    expect(argv).toContain(`${TRUST_ROOT_DEFINE}=${JSON.stringify(canonicalJSON(root))}`)
    expect(hubctlBuildArgv("darwin-x64", { bun: "bun", outdir: "d" }).some((w) => w.startsWith(TRUST_ROOT_DEFINE))).toBe(false)
  })

  test("x64 targets compile against Bun's baseline runtime (no AVX2: older CPUs, QEMU kvm64)", () => {
    const words = (target: string) => hubctlBuildArgv(target, { bun: "bun", outdir: "d" })
    expect(words("linux-x64")).toContain("--target=bun-linux-x64-baseline")
    expect(words("darwin-x64")).toContain("--target=bun-darwin-x64-baseline")
    expect(words("linux-x64").at(-1)).toBe(path.join("d", "hubctl-linux-x64"))
    expect(words("darwin-x64").at(-1)).toBe(path.join("d", "hubctl-darwin-x64"))
    for (const t of SUPPORTED_TARGETS) if (t.arch === "x64") expect(t.bunTarget).toEndWith("-baseline")
  })

  test("builds every supported target by default (never Windows or musl)", async () => {
    const h = harness()
    expect(await runRelease(["build", "--outdir", "/tmp/out", "--trust-root", "/nonexistent/root.json"], h.io)).toBe(0)
    expect(h.runs.map((a) => a.at(-1))).toEqual(SUPPORTED_TARGETS.map((t) => `/tmp/out/hubctl-${t.target}`))
    expect(h.err()).toContain("no trust root")
  })

  test("refuses unsupported targets with the documented reason", async () => {
    for (const target of ["windows-x64", "linux-x64-musl", "plan9-x64"]) {
      const h = harness()
      expect(await runRelease(["build", target], h.io)).toBe(2)
      expect(h.runs).toEqual([])
      expect(h.err()).toContain(target)
    }
  })

  test("--require-trust-root refuses a build without a valid trust root", async () => {
    const w = workspace()
    const h = harness()
    expect(await runRelease(["build", "--require-trust-root", "--trust-root", w.file("missing.json"), "linux-x64"], h.io)).toBe(1)
    expect(h.runs).toEqual([])
    writeFileSync(w.file("bad.json"), JSON.stringify({ ...rootOf(w.key), threshold: 3 }))
    expect(await runRelease(["build", "--require-trust-root", "--trust-root", w.file("bad.json"), "linux-x64"], harness().io)).toBe(1)
    const ok = harness()
    expect(await runRelease(["build", "--require-trust-root", "--trust-root", w.root, "linux-x64"], ok.io)).toBe(0)
    expect(ok.runs[0]!.some((word) => word.startsWith(TRUST_ROOT_DEFINE))).toBe(true)
  })

  test("a failed compile fails the build", async () => {
    const h = harness({}, { run: async () => 1 })
    expect(await runRelease(["build", "linux-x64"], h.io)).toBe(1)
  })
})

describe("manifest", () => {
  test("lists every dist/hubctl-<target> with its size and digest, at the CLI's version", async () => {
    const w = workspace()
    const body = JSON.parse(readFileSync(await unsignedManifest(w), "utf8"))
    expect(validateArtifactManifest({ ...body, signatures: [] }).ok).toBe(true)
    expect(body.release).toBe(version)
    expect(body.minimumVersion).toBe("0.0.1")
    expect(body.issuedAt).toBe(1_793_000_000_000)
    expect(body.signatures).toBeUndefined()
    for (const a of body.artifacts) expect({ size: a.size, sha256: a.sha256 }).toEqual(bytesInfo(fakeBinary(a.target, version)))
  })

  test("re-downloads every pin and refuses to write a manifest on a mismatch", async () => {
    const w = workspace()
    const review = { by: "octocat", on: "2026-10-28", checked: ["upstream-release", "digest-redownloaded", "evidence-listed"] }
    writeFileSync(w.pins, JSON.stringify({ schema: "hub.harness-pin-list", version: 1, pins: HARNESS_PINS.map((pin) => ({ pin, review })) }))
    const good = harness({}, { download: async (url) => HARNESS_PINS.find((p) => p.url === url)! })
    expect(await runRelease(["manifest", "--dist", w.dist, "--pins", w.pins, "--minimum-version", "0.0.1", "--out", w.file("a.json")], good.io)).toBe(0)
    expect(JSON.parse(readFileSync(w.file("a.json"), "utf8")).harnesses).toEqual([...HARNESS_PINS])
    const bad = harness({}, { download: async () => ({ size: 1, sha256: `sha256:${"0".repeat(64)}` }) })
    expect(await runRelease(["manifest", "--dist", w.dist, "--pins", w.pins, "--minimum-version", "0.0.1", "--out", w.file("b.json")], bad.io)).toBe(11)
    expect(existsSync(w.file("b.json"))).toBe(false)
    expect(bad.err()).toContain("integrity_mismatch")
  })

  test("refuses a missing target build, a missing floor and an invalid pin list", async () => {
    const w = workspace()
    const h = harness()
    expect(await runRelease(["manifest", "--dist", w.dir, "--pins", w.pins, "--minimum-version", "0.0.1", "--out", w.file("c.json")], h.io)).toBe(1)
    expect(await runRelease(["manifest", "--dist", w.dist, "--pins", w.pins, "--out", w.file("c.json")], harness().io)).toBe(2)
    writeFileSync(w.pins, "{}")
    expect(await runRelease(["manifest", "--dist", w.dist, "--pins", w.pins, "--minimum-version", "0.0.1", "--out", w.file("c.json")], harness().io)).toBe(1)
    expect(existsSync(w.file("c.json"))).toBe(false)
  })
})

describe("sign", () => {
  test("signs with the key from the environment; the result verifies against the shipped root", async () => {
    const w = workspace()
    const signed = JSON.parse(readFileSync(await signedManifest(w), "utf8"))
    expect(verifyManifest(signed, rootOf(w.key)).ok).toBe(true)
    expect(signed.signatures[0].keyID).toBe(w.key.id)
  })

  test("refuses a key the trust root does not list, and writes nothing", async () => {
    const w = workspace()
    const unsigned = await unsignedManifest(w)
    const h = harness({ [SIGNING_KEY_ENV]: ephemeralKey().pem })
    expect(await runRelease(["sign", "--in", unsigned, "--out", w.file("m.json"), "--trust-root", w.root], h.io)).toBe(11)
    expect(existsSync(w.file("m.json"))).toBe(false)
  })

  test("refuses without the secret, and never prints the key", async () => {
    const w = workspace()
    const unsigned = await unsignedManifest(w)
    const none = harness()
    expect(await runRelease(["sign", "--in", unsigned, "--out", w.file("m.json"), "--trust-root", w.root], none.io)).toBe(2)
    expect(none.err()).toContain(SIGNING_KEY_ENV)
    const junk = "not-a-key-" + "Q".repeat(40)
    const bad = harness({ [SIGNING_KEY_ENV]: junk })
    expect(await runRelease(["sign", "--in", unsigned, "--out", w.file("m.json"), "--trust-root", w.root], bad.io)).toBe(1)
    const ok = harness({ [SIGNING_KEY_ENV]: w.key.pem })
    await runRelease(["sign", "--in", unsigned, "--out", w.file("m.json"), "--trust-root", w.root], ok.io)
    const body = w.key.pem.split("\n")[1]!
    for (const text of [bad.out(), bad.err(), ok.out(), ok.err(), readFileSync(w.file("m.json"), "utf8")]) {
      expect(text).not.toContain(junk)
      expect(text).not.toContain(body)
      expect(text).not.toContain("PRIVATE KEY")
    }
  })

  test("refuses to re-sign an edited or already-signed body", async () => {
    const w = workspace()
    const body = JSON.parse(readFileSync(await unsignedManifest(w), "utf8"))
    writeFileSync(w.file("edited.json"), JSON.stringify({ ...body, artifacts: body.artifacts.slice(1) }))
    const h = harness({ [SIGNING_KEY_ENV]: w.key.pem })
    expect(await runRelease(["sign", "--in", w.file("edited.json"), "--out", w.file("m.json"), "--trust-root", w.root], h.io)).toBe(1)
    writeFileSync(w.file("signed.json"), JSON.stringify({ ...body, signatures: [] }))
    expect(await runRelease(["sign", "--in", w.file("signed.json"), "--out", w.file("m.json"), "--trust-root", w.root], h.io)).toBe(1)
  })
})

describe("verify", () => {
  test("accepts every artifact of a signed release", async () => {
    const w = workspace()
    const manifest = await signedManifest(w)
    const h = harness()
    expect(await runRelease(["verify", "--manifest", manifest, "--trust-root", w.root, "--dist", w.dist], h.io)).toBe(0)
    expect(h.out().trim().split("\n").length).toBe(SUPPORTED_TARGETS.length)
    expect(await runRelease(["verify", "--manifest", manifest, "--trust-root", w.root, "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-linux-x64")], harness().io)).toBe(0)
  })

  test("rejects tampering, the wrong platform and downgrades with exit 11", async () => {
    const w = workspace()
    const manifest = await signedManifest(w)
    const m = JSON.parse(readFileSync(manifest, "utf8"))
    writeFileSync(w.file("tampered.json"), JSON.stringify({ ...m, minimumVersion: "0.0.0" }))
    const cases: string[][] = [
      ["--manifest", w.file("tampered.json"), "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-linux-x64")],
      ["--manifest", manifest, "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-darwin-arm64")],
      ["--manifest", manifest, "--target", "windows-x64", "--file", path.join(w.dist, "hubctl-linux-x64")],
      ["--manifest", manifest, "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-linux-x64"), "--installed", "99.0.0", "--installed-sha256", `sha256:${"0".repeat(64)}`],
      ["--manifest", manifest, "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-linux-x64"), "--floor", "99.0.0", "--allow-downgrade"],
    ]
    for (const args of cases) {
      const h = harness()
      expect(await runRelease(["verify", "--trust-root", w.root, ...args], h.io)).toBe(11)
    }
    const allowed = harness()
    const args = ["--manifest", manifest, "--target", "linux-x64", "--file", path.join(w.dist, "hubctl-linux-x64"), "--installed", "99.0.0", "--installed-sha256", `sha256:${"0".repeat(64)}`, "--allow-downgrade"]
    expect(await runRelease(["verify", "--trust-root", w.root, ...args], allowed.io)).toBe(0)
    expect(allowed.out()).toContain("downgrade")
  })
})

describe("trust-root and usage", () => {
  test("trust-root prints the public v1 root for the key in the environment", async () => {
    const key = ephemeralKey("hub-release-1")
    const h = harness({ [SIGNING_KEY_ENV]: key.pem })
    expect(await runRelease(["trust-root", "--key-id", "hub-release-1"], h.io)).toBe(0)
    expect(JSON.parse(h.out())).toEqual(rootOf(key))
    expect(h.out()).not.toContain("PRIVATE")
  })

  test("unknown commands and flags are usage errors", async () => {
    expect(await runRelease([], harness().io)).toBe(2)
    expect(await runRelease(["publish"], harness().io)).toBe(2)
    expect(await runRelease(["verify", "--bogus", "x"], harness().io)).toBe(2)
    expect(await runRelease(["build", "--outdir"], harness().io)).toBe(2)
  })
})
