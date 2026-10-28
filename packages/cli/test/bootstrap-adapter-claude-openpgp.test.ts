// The Claude Code adapter's in-house OpenPGP check of upstream's detached manifest signature (contracts §5: GPG is
// optional evidence with no hard gpg dependency). It verifies upstream's real key, manifest and signature, and
// sorts every other outcome into verified, unavailable (cannot be checked here) or failed (checked and wrong).
import { describe, expect, test } from "bun:test"
import { CLAUDE_SIGNING_FINGERPRINT, publicKeyFingerprint, verifyDetachedSignature } from "../src/bootstrap/adapters/claude/openpgp.ts"
import { armor, armoredSignature, pgpKey, pgpSign, UPSTREAM, upstreamManifestBytes } from "./bootstrap/claude-adapter-fixtures.ts"

const enc = (s: string) => new TextEncoder().encode(s)

describe("upstream's real release-signing material", () => {
  test("the published key has the fingerprint upstream documents", () => {
    expect(CLAUDE_SIGNING_FINGERPRINT).toBe("31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE")
    expect(publicKeyFingerprint(UPSTREAM.publicKey)).toBe(CLAUDE_SIGNING_FINGERPRINT)
  })

  test("the real 2.1.308 manifest verifies against its detached signature", () => {
    const data = upstreamManifestBytes()
    expect(new Bun.CryptoHasher("sha256").update(data).digest("hex")).toBe(UPSTREAM.manifestSha256)
    expect(verifyDetachedSignature({ data, signature: UPSTREAM.signature, publicKey: UPSTREAM.publicKey, fingerprint: CLAUDE_SIGNING_FINGERPRINT }).status).toBe("verified")
  })

  test("one changed byte of the manifest fails", () => {
    const data = upstreamManifestBytes()
    data[40] = data[40]! ^ 1
    const r = verifyDetachedSignature({ data, signature: UPSTREAM.signature, publicKey: UPSTREAM.publicKey, fingerprint: CLAUDE_SIGNING_FINGERPRINT })
    expect(r.status).toBe("failed")
  })
})

describe("verifyDetachedSignature outcomes", () => {
  const key = pgpKey()
  const other = pgpKey()
  const data = enc('{"version":"2.1.90"}\n')
  const check = (signature: string | Uint8Array, patch: Partial<Parameters<typeof verifyDetachedSignature>[0]> = {}) =>
    verifyDetachedSignature({ data, signature, publicKey: key.armored, fingerprint: key.fingerprint, ...patch })

  test("a good signature by the pinned key is verified (armored or binary)", () => {
    expect(check(armoredSignature(key, data))).toMatchObject({ status: "verified" })
    expect(check(pgpSign(key, data, { hash: 8 }))).toMatchObject({ status: "verified" })
  })

  test("a signature over other bytes, or forged in the pinned key's name, fails", () => {
    expect(check(armoredSignature(key, enc("other"))).status).toBe("failed")
    expect(check(armoredSignature(other, data, { issuer: key.fingerprint })).status).toBe("failed")
  })

  test("a published key that is not the pinned one cannot vouch: unavailable", () => {
    const r = verifyDetachedSignature({ data, signature: armoredSignature(other, data), publicKey: other.armored, fingerprint: key.fingerprint })
    expect(r.status).toBe("unavailable")
    expect(r.detail).toContain("not the pinned")
  })

  test("a signature by another key (a rotation this hubctl does not know) is unavailable, not a pass", () => {
    expect(check(armoredSignature(other, data)).status).toBe("unavailable")
  })

  test("what this verifier does not support is unavailable", () => {
    expect(check(armoredSignature(key, data, { type: 1 })).status).toBe("unavailable")
    expect(check(armoredSignature(key, data, { hash: 2 })).status).toBe("unavailable")
    expect(check(armoredSignature(key, data, { version: 5 })).status).toBe("unavailable")
    expect(check(armoredSignature(key, data), { publicKey: armor("PUBLIC KEY BLOCK", Buffer.from([0xc6, 3, 4, 0, 0])) }).status).toBe("unavailable")
  })

  test("a malformed signature fails, never throws", () => {
    expect(check("-----BEGIN PGP SIGNATURE-----\n\n!!!\n-----END PGP SIGNATURE-----\n").status).toBe("failed")
    expect(check(new Uint8Array([0xc2, 0xff, 1])).status).toBe("failed")
    expect(check(pgpSign(key, data).subarray(0, 40)).status).toBe("failed")
  })

  test("details are one short line", () => {
    for (const r of [check(armoredSignature(key, data)), check(armoredSignature(other, data)), check(new Uint8Array([1]))]) {
      expect(r.detail.length).toBeLessThanOrEqual(200)
      expect(r.detail).not.toContain("\n")
    }
  })
})
