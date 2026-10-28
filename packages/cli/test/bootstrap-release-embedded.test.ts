// What a standalone hubctl carries inside itself (packages/cli/src/bootstrap/release/{trust-root,assets}.ts): the
// trust root (public keys only, injected at build time with `bun build --define`) and the six service templates of
// EMBEDDED_ASSETS. A compiled probe proves both survive `bun build --compile` and need nothing on disk.
import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EMBEDDED_ASSETS, canonicalJSON, type IssueCode, type Result } from "../src/bootstrap/contracts/index.ts"
import { EMBEDDED_TEXT, embeddedAsset } from "../src/bootstrap/release/assets.ts"
import { TRUST_ROOT_DEFINE, embeddedTrustRootText, shippedTrustRoot, trustRootDefine } from "../src/bootstrap/release/trust-root.ts"
import { digestBytes } from "../src/bootstrap/release/verify.ts"
import { ephemeralKey, rootOf } from "./bootstrap/release-fixtures.ts"

const codes = (r: Result<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code))
const expectRejected = (r: Result<unknown>, code: IssueCode) => {
  expect(r.ok).toBe(false)
  expect(codes(r)).toContain(code)
}
const repo = path.join(import.meta.dir, "..", "..", "..")
const root = rootOf(ephemeralKey())

describe("shipped trust root", () => {
  test("a source run embeds none, and says so (signature_invalid)", () => {
    expect(embeddedTrustRootText()).toBeUndefined()
    expectRejected(shippedTrustRoot(), "signature_invalid")
  })

  test("parses and validates the embedded text", () => {
    const r = shippedTrustRoot(canonicalJSON(root))
    expect(r.ok && r.value).toEqual(root)
    expectRejected(shippedTrustRoot("{"), "signature_invalid")
    expectRejected(shippedTrustRoot(canonicalJSON({ ...root, threshold: 2 })), "signature_invalid")
  })

  test("refuses private key material in a trust root", () => {
    const text = canonicalJSON({ ...root, keys: [{ ...root.keys[0]!, publicKey: "-----BEGIN PRIVATE KEY-----" }] })
    expectRejected(shippedTrustRoot(text), "signature_invalid")
    expect(() => trustRootDefine({ ...root, keys: [{ ...root.keys[0]!, privateKey: "x" }] } as never)).toThrow()
  })

  test("trustRootDefine is the --define word pair for bun build", () => {
    expect(trustRootDefine(root)).toEqual(["--define", `${TRUST_ROOT_DEFINE}=${JSON.stringify(canonicalJSON(root))}`])
  })
})

describe("embedded service templates", () => {
  test("every EMBEDDED_ASSETS entry is embedded, byte for byte, with its digest", () => {
    expect(Object.keys(EMBEDDED_TEXT).sort()).toEqual(Object.keys(EMBEDDED_ASSETS).sort())
    for (const [id, asset] of Object.entries(EMBEDDED_ASSETS)) {
      const disk = readFileSync(path.join(repo, asset.source))
      const e = embeddedAsset(id)
      expect(e?.text).toBe(disk.toString("utf8"))
      expect(e?.sha256).toBe(digestBytes(disk).sha256)
      expect(e?.asset).toEqual(asset)
    }
  })

  test("unknown assets are undefined", () => {
    expect(embeddedAsset("service/launchd/nope")).toBeUndefined()
    expect(embeddedAsset("__proto__")).toBeUndefined()
  })
})

describe("compiled", () => {
  test("a standalone binary carries the trust root and templates, and runs without bun, node or scripts/", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hubctl-embedded-"))
    const entry = path.join(dir, "probe.ts")
    writeFileSync(
      entry,
      [
        `import { shippedTrustRoot } from ${JSON.stringify(path.join(repo, "packages/cli/src/bootstrap/release/trust-root.ts"))}`,
        `import { embeddedAsset, EMBEDDED_TEXT } from ${JSON.stringify(path.join(repo, "packages/cli/src/bootstrap/release/assets.ts"))}`,
        "const r = shippedTrustRoot()",
        "console.log(JSON.stringify({ root: r.ok ? r.value : null, assets: Object.keys(EMBEDDED_TEXT).map((id) => [id, embeddedAsset(id)?.sha256]) }))",
      ].join("\n"),
    )
    const build = Bun.spawnSync([process.execPath, "build", "--compile", entry, ...trustRootDefine(root), "--outfile", path.join(dir, "probe")], { stderr: "pipe", stdout: "pipe" })
    expect(build.exitCode).toBe(0)
    const run = path.join(mkdtempSync(path.join(tmpdir(), "hubctl-run-")), "probe")
    copyFileSync(path.join(dir, "probe"), run)
    Bun.spawnSync(["chmod", "+x", run])
    const out = Bun.spawnSync([run], { cwd: path.dirname(run), env: { PATH: "/usr/bin:/bin", HOME: path.dirname(run) }, stdout: "pipe", stderr: "pipe" })
    expect(out.exitCode).toBe(0)
    const result = JSON.parse(out.stdout.toString())
    expect(result.root).toEqual(root)
    expect(result.assets).toEqual(Object.keys(EMBEDDED_TEXT).map((id) => [id, embeddedAsset(id)?.sha256]))
  }, 120_000)
})
