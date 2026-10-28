// Offline verification of the sigstore bundles openai/codex publishes next to its Linux release assets (legacy
// cosign bundles: signature, Fulcio leaf certificate, Rekor signed entry timestamp). It is optional evidence on top
// of hub's pinned digest: "verified" only when every check passes, "unavailable" when this hubctl cannot judge it
// (no trusted root, an unknown CA or log, a bundle format it does not read), "failed" when a check it can run fails.
import { describe, expect, test } from "bun:test"
import { codexSigstoreIdentity, trustFromTrustedRoot, verifySigstoreBundle } from "../src/bootstrap/adapters/codex/sigstore.ts"
import { CODEX_SAN, GITHUB_ISSUER, sigstoreWorld, T0_FOR_SIGSTORE, type BundleOptions } from "./bootstrap/codex-fixtures.ts"

const artifact = new TextEncoder().encode("codex-package-x86_64-unknown-linux-musl.tar.gz bytes")
const world = sigstoreWorld()
const trusted = () => {
  const t = trustFromTrustedRoot(world.trustedRoot)
  if (!t.ok) throw new Error(t.message)
  return t.value
}
const identity = codexSigstoreIdentity("0.165.0")
const check = (options: BundleOptions = {}, bytes = artifact) => verifySigstoreBundle(world.bundle(artifact, options), bytes, { trust: trusted(), identity })

describe("verifySigstoreBundle", () => {
  test("the Codex identity is the release workflow at the version's tag, issued by GitHub Actions", () => {
    expect(identity).toEqual({ san: CODEX_SAN, issuer: GITHUB_ISSUER })
  })

  test("verifies a bundle: chain to the trusted root, identity, artifact signature, Rekor SET and body binding", () => {
    const r = check()
    expect(r.kind).toBe("sigstore")
    expect(r.status).toBe("verified")
    expect(r.detail).toContain("rust-release.yml@refs/tags/rust-v0.165.0")
  })

  const failed: Record<string, BundleOptions | "tamperedArtifact"> = {
    otherWorkflow: { san: "https://github.com/evil/codex/.github/workflows/release.yml@refs/tags/rust-v0.165.0" },
    otherTag: { san: "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.1.0" },
    otherIssuer: { issuer: "https://accounts.example.com" },
    noIssuer: { noIssuer: true },
    tamperedArtifact: "tamperedArtifact",
    bodyNamesOtherDigest: { bodyDigest: "0".repeat(64) },
    impostorCA: { ca: "impostor" },
    forgedSET: { rekor: "forged" },
    loggedOutsideCertValidity: { integratedMs: T0_FOR_SIGSTORE },
  }
  for (const [label, options] of Object.entries(failed))
    test(`fails: ${label}`, () => {
      const r = options === "tamperedArtifact" ? check({}, new TextEncoder().encode("other bytes")) : check(options)
      expect(r.status).toBe("failed")
      expect(r.detail).toBeString()
    })

  test("unavailable: no trusted root in this hubctl (never verified by default)", () => {
    expect(verifySigstoreBundle(world.bundle(artifact), artifact, { identity }).status).toBe("unavailable")
  })

  test("unavailable: a CA or a log this hubctl does not know", () => {
    expect(check({ ca: "unknown" }).status).toBe("unavailable")
    expect(check({ rekor: "unknown" }).status).toBe("unavailable")
  })

  test("unavailable: a bundle format it does not read", () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    for (const raw of ["not json", '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}', "[]"])
      expect(verifySigstoreBundle(enc(raw), artifact, { trust: trusted(), identity }).status).toBe("unavailable")
  })

  test("trustFromTrustedRoot refuses a document without usable keys", () => {
    expect(trustFromTrustedRoot({}).ok).toBe(false)
    expect(trustFromTrustedRoot({ ...world.trustedRoot, certificateAuthorities: [] }).ok).toBe(false)
  })
})
