// Fixtures for the hubctl release tests (packages/cli/src/bootstrap/release): ephemeral ed25519 keys generated at
// test time (no key material is committed), trust roots built from them, and fake hubctl "binaries" whose size and
// digest the manifests list. Everything else comes from the shared contract fixtures (./fixtures.ts).
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { manifestPayload, type ArtifactManifest, type TrustRoot } from "../../src/bootstrap/contracts/index.ts"
import { TRUST_ROOT_TEMPLATE } from "./fixtures.ts"

export interface TestKey {
  readonly id: string
  /** base64 DER (SPKI), as a trust root lists it. */
  readonly der: string
  readonly privateKey: KeyObject
  /** The private key as PKCS#8 PEM, the form the release secret holds. */
  readonly pem: string
}

export function ephemeralKey(id = "hub-release-1"): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    id,
    der: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey,
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }
}

export const rootOf = (...keys: { id: string; der: string; status?: "active" | "retired" | "revoked" }[]): TrustRoot => ({
  ...TRUST_ROOT_TEMPLATE,
  keys: keys.map((k) => ({ keyID: k.id, algorithm: "ed25519", publicKey: k.der, status: k.status ?? "active" })),
})

/** Signs a manifest body the way a test needs it, independently of the code under test. */
export function signWith(body: Omit<ArtifactManifest, "signatures">, ...keys: TestKey[]): ArtifactManifest {
  const payload = Buffer.from(manifestPayload(body))
  return { ...body, signatures: keys.map((k) => ({ keyID: k.id, algorithm: "ed25519" as const, value: sign(null, payload, k.privateKey).toString("base64") })) }
}

/** Deterministic stand-in bytes for a hubctl binary of one target. */
export const fakeBinary = (target: string, release = "0.8.0") => new TextEncoder().encode(`hubctl ${release} for ${target}\n`)

export const bytesInfo = (bytes: Uint8Array) => ({ size: bytes.byteLength, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })

/** A manifest body (no signatures) whose artifacts are fakeBinary for every supported target. */
export function releaseBody(release = "0.8.0", minimumVersion = "0.7.0", harnesses: ArtifactManifest["harnesses"] = []): Omit<ArtifactManifest, "signatures"> {
  return {
    schema: "hub.artifact-manifest",
    version: 1,
    product: "hubctl",
    release,
    channel: "stable",
    minimumVersion,
    issuedAt: 1_793_000_000_000,
    artifacts: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].map((target) => ({ target, file: `hubctl-${target}`, ...bytesInfo(fakeBinary(target, release)) })),
    harnesses,
  }
}
