// The hubctl release verification library (packages/cli/src/bootstrap/release/verify.ts): what an installer runs
// on a downloaded hubctl before it touches the disk. Tampered manifests or bytes, wrong-platform artifacts and
// downgrades are rejected with the contract's issue codes (T1–T4). Keys are generated here, per run.
import { describe, expect, test } from "bun:test"
import type { IssueCode, Result } from "../src/bootstrap/contracts/index.ts"
import { digestBytes, parseManifest, verifyHubctlRelease } from "../src/bootstrap/release/verify.ts"
import { bytesInfo, ephemeralKey, fakeBinary, releaseBody, rootOf, signWith } from "./bootstrap/release-fixtures.ts"

const codes = (r: Result<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code))
const expectRejected = (r: Result<unknown>, code: IssueCode) => {
  expect(r.ok).toBe(false)
  expect(codes(r)).toContain(code)
}

const key = ephemeralKey()
const root = rootOf(key)
const manifest = signWith(releaseBody("0.8.0", "0.7.0"), key)
const host = "linux-x64"
const bytes = bytesInfo(fakeBinary(host))
const accept = (overrides: Partial<Parameters<typeof verifyHubctlRelease>[0]> = {}) => verifyHubctlRelease({ manifest, root, target: host, bytes, ...overrides })

describe("verifyHubctlRelease accepts", () => {
  test("a signed manifest, the host's artifact and its exact bytes: a fresh install", () => {
    const r = accept()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe("install")
    expect(r.value.artifact.target).toBe(host)
    expect(r.value.manifest.release).toBe("0.8.0")
    expect(r.value.floor).toBe("0.7.0")
  })

  test("an upgrade, and a reinstall of the same bytes", () => {
    const up = accept({ installed: { version: "0.7.1", sha256: "sha256:" + "0".repeat(64) } })
    expect(up.ok && up.value.kind).toBe("upgrade")
    const same = accept({ installed: { version: "0.8.0", sha256: bytes.sha256 } })
    expect(same.ok && same.value.kind).toBe("reinstall")
  })

  test("the floor to persist is the highest seen", () => {
    const r = accept({ floor: "0.7.5" })
    expect(r.ok && r.value.floor).toBe("0.7.5")
  })
})

describe("verifyHubctlRelease rejects tampering (T1, T2)", () => {
  test("a manifest edited after signing", () => {
    expectRejected(accept({ manifest: { ...manifest, release: "0.9.0" } }), "signature_invalid")
    const artifacts = manifest.artifacts.map((a) => (a.target === host ? { ...a, sha256: "sha256:" + "f".repeat(64) } : a))
    expectRejected(accept({ manifest: { ...manifest, artifacts } }), "signature_invalid")
  })

  test("an unsigned manifest, a stranger's signature and a revoked key", () => {
    expectRejected(accept({ manifest: { ...manifest, signatures: [] } }), "signature_invalid")
    expectRejected(accept({ manifest: signWith(releaseBody(), ephemeralKey()) }), "signature_invalid")
    expectRejected(accept({ root: rootOf({ ...key, status: "revoked" }) }), "signature_invalid")
  })

  test("bytes that differ from the manifest (digest or size)", () => {
    expectRejected(accept({ bytes: bytesInfo(fakeBinary("linux-arm64")) }), "integrity_mismatch")
    expectRejected(accept({ bytes: { ...bytes, size: bytes.size + 1 } }), "integrity_mismatch")
  })

  test("a malformed manifest is refused before any signature check", () => {
    expectRejected(accept({ manifest: { ...manifest, extra: true } }), "unknown_field")
    expectRejected(accept({ manifest: "not a manifest" }), "invalid_value")
  })
})

describe("verifyHubctlRelease rejects the wrong platform (T3)", () => {
  test("another supported target's artifact", () => {
    expectRejected(accept({ bytes: bytesInfo(fakeBinary("darwin-arm64")) }), "integrity_mismatch")
  })

  test("a target the release does not list", () => {
    const body = releaseBody()
    const linuxOnly = signWith({ ...body, artifacts: body.artifacts.filter((a) => a.target !== "darwin-x64") }, key)
    expectRejected(accept({ manifest: linuxOnly, target: "darwin-x64" }), "wrong_platform")
  })

  test("unsupported hosts: Windows, musl, unknown", () => {
    for (const target of ["windows-x64", "linux-x64-musl", "freebsd-x64"]) expectRejected(accept({ target }), "wrong_platform")
  })
})

describe("verifyHubctlRelease rejects downgrades (T4)", () => {
  test("an older release without --allow-downgrade", () => {
    expectRejected(accept({ installed: { version: "0.9.0", sha256: "sha256:" + "0".repeat(64) } }), "downgrade_rejected")
  })

  test("an older release with --allow-downgrade, above the floor", () => {
    const r = accept({ installed: { version: "0.9.0", sha256: "sha256:" + "0".repeat(64) }, allowDowngrade: true })
    expect(r.ok && r.value.kind).toBe("downgrade")
  })

  test("nothing below the security floor, even with --allow-downgrade", () => {
    expectRejected(accept({ floor: "0.8.1", allowDowngrade: true }), "below_security_floor")
    const old = signWith(releaseBody("0.6.0", "0.6.0"), key)
    expectRejected(accept({ manifest: old, bytes: bytesInfo(fakeBinary(host, "0.6.0")), floor: "0.7.0", allowDowngrade: true }), "below_security_floor")
  })

  test("the same version with other bytes is tampering", () => {
    expectRejected(accept({ installed: { version: "0.8.0", sha256: "sha256:" + "0".repeat(64) } }), "integrity_mismatch")
  })
})

describe("helpers", () => {
  test("digestBytes is the contract's sha256 form", () => {
    expect(digestBytes(new TextEncoder().encode("abc"))).toEqual({ size: 3, sha256: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" })
  })

  test("parseManifest refuses non-JSON and oversize input with invalid_value", () => {
    expectRejected(parseManifest("{"), "invalid_value")
    expectRejected(parseManifest(" ".repeat(1_048_577)), "invalid_value")
    const r = parseManifest(JSON.stringify(manifest))
    expect(r.ok).toBe(true)
  })
})
