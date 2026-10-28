// Building and signing the hubctl release manifest (packages/cli/src/bootstrap/release/manifest.ts). Keys are
// ephemeral (generated per run); the signed manifest must verify with the contract's own verifyManifest, and the
// signing step refuses a key the shipped trust root does not list.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { SUPPORTED_TARGETS, canonicalJSON, verifyManifest, type IssueCode, type Result } from "../src/bootstrap/contracts/index.ts"
import { buildManifestBody, channelFor, manifestJSON, parseSigningKey, signManifest, signVerified, trustRootFor } from "../src/bootstrap/release/manifest.ts"
import { HARNESS_PINS } from "./bootstrap/fixtures.ts"
import { bytesInfo, ephemeralKey, fakeBinary, rootOf } from "./bootstrap/release-fixtures.ts"

const codes = (r: Result<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code))
const expectRejected = (r: Result<unknown>, code: IssueCode) => {
  expect(r.ok).toBe(false)
  expect(codes(r)).toContain(code)
}

const artifacts = [...SUPPORTED_TARGETS].reverse().map((t) => ({ target: t.target, file: `hubctl-${t.target}`, ...bytesInfo(fakeBinary(t.target)) }))
const input = { release: "0.8.0", minimumVersion: "0.7.0", issuedAt: 1_793_000_000_000, artifacts, harnesses: [...HARNESS_PINS] }

describe("buildManifestBody", () => {
  test("lists every supported target in matrix order, with the pins, and is deterministic", () => {
    const r = buildManifestBody(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.artifacts.map((a) => a.target)).toEqual(SUPPORTED_TARGETS.map((t) => t.target))
    expect(r.value.harnesses).toEqual([...HARNESS_PINS])
    expect(r.value.channel).toBe("stable")
    expect(r.value.product).toBe("hubctl")
    const again = buildManifestBody({ ...input, artifacts: [...artifacts].reverse() })
    expect(again.ok && canonicalJSON(again.value)).toBe(canonicalJSON(r.value))
  })

  test("a pre-release goes to the next channel", () => {
    expect(channelFor("0.8.0")).toBe("stable")
    expect(channelFor("0.8.0-rc.1")).toBe("next")
    const r = buildManifestBody({ ...input, release: "0.8.0-rc.1" })
    expect(r.ok && r.value.channel).toBe("next")
  })

  test("refuses a release missing a supported target, or with an unsupported one", () => {
    expectRejected(buildManifestBody({ ...input, artifacts: artifacts.filter((a) => a.target !== "linux-arm64") }), "missing_field")
    expectRejected(buildManifestBody({ ...input, artifacts: [...artifacts, { ...artifacts[0]!, target: "windows-x64", file: "hubctl-windows-x64.exe" }] }), "unsupported_platform")
  })

  test("refuses a floor above the release and a bad version", () => {
    expectRejected(buildManifestBody({ ...input, minimumVersion: "0.9.0" }), "inconsistent")
    expectRejected(buildManifestBody({ ...input, release: "v0.8.0" }), "invalid_value")
  })
})

describe("signing", () => {
  const key = ephemeralKey()
  const root = rootOf(key)
  const body = (() => {
    const r = buildManifestBody(input)
    if (!r.ok) throw new Error("fixture")
    return r.value
  })()

  test("a signed manifest verifies against a root listing the key", () => {
    const m = signManifest(body, { keyID: key.id, privateKey: parseSigningKey(key.pem) })
    expect(m.signatures.length).toBe(1)
    expect(verifyManifest(m, root).ok).toBe(true)
  })

  test("signVerified refuses a key the trust root does not list (the release gate)", () => {
    const other = ephemeralKey()
    expectRejected(signVerified(body, { keyID: key.id, privateKey: parseSigningKey(other.pem) }, root), "signature_invalid")
    expect(signVerified(body, { keyID: key.id, privateKey: parseSigningKey(key.pem) }, root).ok).toBe(true)
  })

  test("parseSigningKey accepts PKCS#8 PEM and base64 DER, refuses other keys and never echoes the secret", () => {
    const der = key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    expect(parseSigningKey(der).asymmetricKeyType).toBe("ed25519")
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    expect(() => parseSigningKey(rsa)).toThrow("ed25519")
    let message = ""
    try {
      parseSigningKey("not-a-key-SECRETVALUE")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toBe("")
    expect(message).not.toContain("SECRETVALUE")
  })

  test("trustRootFor derives a v1 single-key root (threshold 1) from the private key's public half", () => {
    const r = trustRootFor(parseSigningKey(key.pem), key.id)
    expect(r).toEqual(root)
  })

  test("manifestJSON is canonical, newline-terminated and has no private key material", () => {
    const m = signManifest(body, { keyID: key.id, privateKey: parseSigningKey(key.pem) })
    const text = manifestJSON(m)
    expect(text).toBe(`${canonicalJSON(m)}\n`)
    expect(text).not.toContain("PRIVATE KEY")
  })
})
