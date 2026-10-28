// The hubctl release verification library: everything an installer checks about a downloaded hubctl before it
// touches the disk, in the order that keeps untrusted data inert:
//   1. the manifest is well formed and signed by `threshold` active keys of the shipped trust root (T1, T2);
//   2. it lists an artifact for exactly this host's target, and the host is a supported one (T3);
//   3. the downloaded bytes have exactly that size and digest (T1);
//   4. the install is not a downgrade below the security floor, nor an unconsented downgrade (T4).
// Only the contracts are used (node:crypto, no dependencies), so the release signing job can run it without any
// npm install.
import { createHash } from "node:crypto"
import {
  checkArtifactBytes,
  compareVersions,
  decideInstall,
  fail,
  ok,
  selectArtifact,
  verifyManifest,
  type ArtifactEntry,
  type InstallKind,
  type Result,
  type SignatureVerifier,
  type TrustRoot,
  type VerifiedManifest,
} from "../contracts/index.ts"

export interface ReleaseCheckInput {
  /** The parsed manifest document (untrusted). */
  readonly manifest: unknown
  /** The trust root this hubctl ships (or a rotated successor accepted through rotateTrustRoot). */
  readonly root: TrustRoot
  /** This host's target (targetOf); never a "close enough" one. */
  readonly target: string
  /** Size and digest of the downloaded hubctl (digestBytes). */
  readonly bytes: { readonly sha256: string; readonly size: number }
  /** The hubctl installed now, if any. */
  readonly installed?: { readonly version: string; readonly sha256: string }
  /** The highest security floor this machine has seen in a verified manifest. */
  readonly floor?: string
  /** Explicit --allow-downgrade (never below the floor). */
  readonly allowDowngrade?: boolean
  readonly verifier?: SignatureVerifier
}

export interface AcceptedRelease {
  readonly manifest: VerifiedManifest
  readonly artifact: ArtifactEntry
  readonly kind: InstallKind
  /** The security floor to persist after the install: max(seen floor, manifest floor). */
  readonly floor: string
}

/** Largest manifest accepted (a real one is a few kilobytes). */
export const MAX_MANIFEST_BYTES = 1_048_576

const maxVersion = (a: string, b?: string) => (b !== undefined && compareVersions(b, a) > 0 ? b : a)

export function verifyHubctlRelease(input: ReleaseCheckInput): Result<AcceptedRelease> {
  const verified = verifyManifest(input.manifest, input.root, input.verifier)
  if (!verified.ok) return verified
  const manifest = verified.value
  const artifact = selectArtifact(manifest, input.target)
  if (!artifact.ok) return artifact
  const bytes = checkArtifactBytes(artifact.value, input.bytes)
  if (!bytes.ok) return bytes
  const kind = decideInstall({
    candidate: { release: manifest.release, minimumVersion: manifest.minimumVersion, sha256: input.bytes.sha256 },
    ...(input.installed ? { installed: input.installed } : {}),
    ...(input.floor !== undefined ? { floor: input.floor } : {}),
    ...(input.allowDowngrade !== undefined ? { allowDowngrade: input.allowDowngrade } : {}),
  })
  if (!kind.ok) return kind
  return ok({ manifest, artifact: artifact.value, kind: kind.value, floor: maxVersion(manifest.minimumVersion, input.floor) })
}

/** Size and "sha256:<hex>" of some bytes, the form manifests list. */
export function digestBytes(bytes: Uint8Array): { size: number; sha256: string } {
  return { size: bytes.byteLength, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
}

/** JSON text of a downloaded manifest, bounded; the document still needs verifyHubctlRelease. */
export function parseManifest(text: string): Result<unknown> {
  if (text.length > MAX_MANIFEST_BYTES) return fail("", "invalid_value", `a manifest is at most ${MAX_MANIFEST_BYTES} bytes`)
  try {
    return ok(JSON.parse(text) as unknown)
  } catch {
    return fail("", "invalid_value", "the manifest is not JSON")
  }
}
