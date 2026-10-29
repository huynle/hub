// Building and signing the hubctl release manifest (contracts §3.6, I5, decision Q5).
//   - The body lists one hubctl artifact for every supported target (in matrix order) and the reviewed harness
//     pins (pins.ts), so the same inputs always give the same bytes.
//   - The signature is a detached ed25519 signature over manifestPayload (canonical JSON without `signatures`),
//     by the single release key (threshold 1), held as a GitHub Actions secret.
//   - signVerified signs and then verifies with the contract's verifyManifest against the trust root the hubctl
//     binaries embed: a secret that does not match the shipped root never produces a publishable manifest.
// Only node:crypto and the contracts are used, so the signing job runs with no npm dependencies installed.
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto"
import {
  Checker,
  SEMVER,
  SUPPORTED_TARGETS,
  TRUST_ROOT_SCHEMA,
  canonicalJSON,
  manifestPayload,
  validateArtifactManifest,
  verifyManifest,
  type ArtifactManifest,
  type HarnessPin,
  type Result,
  type TrustRoot,
  type VerifiedManifest,
} from "../contracts/index.ts"

export type ManifestBody = Omit<ArtifactManifest, "signatures">

export interface ManifestInput {
  readonly release: string
  /** The security floor (≤ release). */
  readonly minimumVersion: string
  readonly issuedAt: number
  readonly artifacts: readonly { readonly target: string; readonly file: string; readonly size: number; readonly sha256: string }[]
  /** The manifest's harness pins (verifyPinDownloads / harnessPins). */
  readonly harnesses: readonly HarnessPin[]
  /**
   * The targets this release ships, listed explicitly (a partial release, e.g. one target for testing): each must
   * be supported and have exactly one artifact, and no artifact may be for another target. Default: every
   * supported target.
   */
  readonly targets?: readonly string[]
}

export interface SigningKey {
  readonly keyID: string
  readonly privateKey: KeyObject
}

/** A pre-release (x.y.z-…) goes to `next`, everything else to `stable`. */
export const channelFor = (release: string): "stable" | "next" => (SEMVER.exec(release)?.[4] ? "next" : "stable")

const ORDER = SUPPORTED_TARGETS.map((t) => t.target)
const rank = (target: string) => {
  const i = ORDER.indexOf(target)
  return i < 0 ? ORDER.length : i
}

/**
 * The unsigned manifest for a release: validated, every supported target (or every listed target) present and
 * nothing else, artifacts in matrix order.
 */
export function buildManifestBody(input: ManifestInput): Result<ManifestBody> {
  const body: ManifestBody = {
    schema: "hub.artifact-manifest",
    version: 1,
    product: "hubctl",
    release: input.release,
    channel: channelFor(input.release),
    minimumVersion: input.minimumVersion,
    issuedAt: input.issuedAt,
    artifacts: [...input.artifacts].map(({ target, file, size, sha256 }) => ({ target, file, size, sha256 })).sort((a, b) => rank(a.target) - rank(b.target)),
    harnesses: [...input.harnesses],
  }
  const c = new Checker()
  c.merge("", validateArtifactManifest({ ...body, signatures: [] }))
  const targets = input.targets ?? ORDER
  if (input.targets) {
    if (targets.length === 0) c.add("/artifacts", "invalid_value", "a release lists at least one target")
    if (new Set(targets).size !== targets.length) c.add("/artifacts", "duplicate", "a target is listed twice")
    for (const target of targets) if (!ORDER.includes(target)) c.add("/artifacts", "unsupported_platform", `${target} is not a supported target`)
    for (const a of body.artifacts) if (ORDER.includes(a.target) && !targets.includes(a.target)) c.add("/artifacts", "inconsistent", `the release has a hubctl for ${a.target}, which is not one of the listed targets (${targets.join(", ")})`)
  }
  for (const target of targets) if (!body.artifacts.some((a) => a.target === target)) c.add("/artifacts", "missing_field", `the release has no hubctl for ${target}`)
  return c.result(body)
}

/** The release key from the secret's text: PKCS#8 PEM or base64 PKCS#8 DER, ed25519 only. Errors never quote it. */
export function parseSigningKey(secret: string): KeyObject {
  const text = secret.trim()
  let key: KeyObject
  try {
    key = text.startsWith("-----BEGIN") ? createPrivateKey({ key: text, format: "pem" }) : createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" })
  } catch {
    throw new Error("the release signing key is not a PKCS#8 ed25519 private key (PEM or base64 DER)")
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the release signing key must be ed25519, not ${key.asymmetricKeyType ?? "unknown"}`)
  return key
}

/** Adds the detached ed25519 signature over manifestPayload. */
export function signManifest(body: ManifestBody, key: SigningKey): ArtifactManifest {
  const value = sign(null, Buffer.from(manifestPayload(body), "utf8"), key.privateKey).toString("base64")
  return { ...body, signatures: [{ keyID: key.keyID, algorithm: "ed25519", value }] }
}

/** Signs, then verifies against the shipped trust root; a key the root does not list never yields a manifest. */
export function signVerified(body: ManifestBody, key: SigningKey, root: TrustRoot): Result<VerifiedManifest> {
  return verifyManifest(signManifest(body, key), root)
}

/** The v1 trust root (one active key, threshold 1) for the public half of a release key. */
export function trustRootFor(privateKey: KeyObject, keyID: string): TrustRoot {
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64")
  return { schema: TRUST_ROOT_SCHEMA, version: 1, threshold: 1, keys: [{ keyID, algorithm: "ed25519", publicKey, status: "active" }] }
}

/** The bytes published as hubctl-manifest.json. */
export const manifestJSON = (manifest: ArtifactManifest): string => `${canonicalJSON(manifest)}\n`
