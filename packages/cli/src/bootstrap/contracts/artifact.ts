// ArtifactManifest and TrustRoot: how a hubctl download is authenticated before it is installed.
//   - A release publishes one manifest listing, per supported target, the file, its size and its sha256.
//   - The manifest is signed (ed25519, detached, over its canonical JSON without `signatures`) by release keys
//     listed in a trust root that ships inside hubctl. `threshold` distinct active keys must sign.
//   - The trust root rotates only forward: a new root (higher version) must be signed by the current root's keys.
//   - The installer picks the host's exact target (never a "close enough" one), checks size and digest of the
//     bytes, and refuses downgrades unless explicitly allowed; nothing goes below the security floor.
import { createPublicKey, verify } from "node:crypto"
import { canonicalJSON } from "./canonical.ts"
import type { InstallHarness } from "./actions.ts"
import { HARNESS_EVIDENCE, HARNESS_ORDER, type EvidenceKind, type HarnessID } from "./harness.ts"
import { checkTarget } from "./platform.ts"
import { Checker, digest, fail, FILE_NAME, header, httpsURL, instant, int, isRecord, list, ok, oneOf, pointer, semver, SEMVER, shape, subset, text, type Result } from "./validate.ts"

export const MANIFEST_SCHEMA = "hub.artifact-manifest"
export const MANIFEST_VERSION = 1
export const TRUST_ROOT_SCHEMA = "hub.trust-root"

export interface ArtifactEntry {
  readonly target: string
  /** A plain file name in the release (no directories). */
  readonly file: string
  readonly size: number
  readonly sha256: string
}

/**
 * A harness artifact pinned by hub's signed manifest: hub vouches for exactly this upstream file (transitive
 * trust), so even an upstream that publishes no signature (OpenCode) is installed only if its bytes match.
 */
export interface HarnessPin {
  readonly harness: HarnessID
  /** Exact version; never a range or channel. */
  readonly version: string
  readonly target: string
  /** The upstream download (https). */
  readonly url: string
  readonly file: string
  readonly size: number
  readonly sha256: string
  /** Upstream evidence available for this file (attempted at install, recorded, never required). */
  readonly evidence: readonly EvidenceKind[]
  /** This harness's security floor: no install below it, even with --allow-downgrade. */
  readonly minimumVersion?: string
}

export interface Signature {
  readonly keyID: string
  readonly algorithm: "ed25519"
  /** base64 of the raw signature. */
  readonly value: string
}

export interface ArtifactManifest {
  readonly schema: typeof MANIFEST_SCHEMA
  readonly version: typeof MANIFEST_VERSION
  readonly product: "hubctl"
  readonly release: string
  readonly channel: "stable" | "next"
  /** The security floor: no install of an older release than this is ever accepted once seen. */
  readonly minimumVersion: string
  readonly issuedAt: number
  readonly artifacts: readonly ArtifactEntry[]
  /** Harness artifacts this release pins, per harness and target (covered by the signatures). */
  readonly harnesses: readonly HarnessPin[]
  readonly signatures: readonly Signature[]
}

declare const VERIFIED: unique symbol
/** A manifest whose signatures verifyManifest checked; only it can produce one. */
export type VerifiedManifest = ArtifactManifest & { readonly [VERIFIED]: true }

export interface TrustKey {
  readonly keyID: string
  readonly algorithm: "ed25519"
  /** base64 of the DER (SPKI) public key. */
  readonly publicKey: string
  /** active: counts; retired: no longer signs new releases or roots; revoked: never counts. */
  readonly status: "active" | "retired" | "revoked"
}

export interface TrustRoot {
  readonly schema: typeof TRUST_ROOT_SCHEMA
  readonly version: number
  readonly threshold: number
  readonly keys: readonly TrustKey[]
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function checkSignatures(c: Checker, path: string, v: unknown) {
  list(c, path, v, 16, (p, s) => {
    const r = shape(c, p, s, ["keyID", "algorithm", "value"])
    if (!r) return
    text(c, pointer(p, "keyID"), r.keyID, 64, KEY_ID)
    oneOf(c, pointer(p, "algorithm"), r.algorithm, ["ed25519"] as const)
    text(c, pointer(p, "value"), r.value, 1024, BASE64)
  })
}

export function validateArtifactManifest(value: unknown): Result<ArtifactManifest> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "product", "release", "channel", "minimumVersion", "issuedAt", "artifacts", "harnesses", "signatures"])
  if (!r) return c.result(value)
  header(c, "", r, MANIFEST_SCHEMA, MANIFEST_VERSION)
  if (r.product !== "hubctl") c.add("/product", "invalid_value", "expected product hubctl")
  const releaseOK = semver(c, "/release", r.release)
  const floorOK = semver(c, "/minimumVersion", r.minimumVersion)
  if (releaseOK && floorOK && compareVersions(r.minimumVersion as string, r.release as string) > 0) c.add("/minimumVersion", "inconsistent", "the security floor cannot be above the release")
  oneOf(c, "/channel", r.channel, ["stable", "next"] as const)
  instant(c, "/issuedAt", r.issuedAt)
  if (Array.isArray(r.artifacts) && r.artifacts.length === 0) c.add("/artifacts", "invalid_value", "a manifest lists at least one artifact")
  list(c, "/artifacts", r.artifacts, 16, (p, a) => {
    const e = shape(c, p, a, ["target", "file", "size", "sha256"])
    if (!e) return
    if (typeof e.target !== "string" || !checkTarget(e.target).ok) c.add(pointer(p, "target"), "unsupported_platform", `${String(e.target)} is not a supported target`)
    if (typeof e.file !== "string" || !FILE_NAME.test(e.file)) c.add(pointer(p, "file"), "invalid_path", "expected a plain file name")
    int(c, pointer(p, "size"), e.size, 1, 2 ** 40)
    digest(c, pointer(p, "sha256"), e.sha256)
  }, (a) => (isRecord(a) && typeof a.target === "string" ? a.target : undefined))
  list(c, "/harnesses", r.harnesses, 64, (p, h) => checkHarnessPinShape(c, p, h), (h) => (isRecord(h) ? `${String(h.harness)}@${String(h.target)}` : undefined))
  checkSignatures(c, "/signatures", r.signatures)
  return c.result(value)
}

function checkHarnessPinShape(c: Checker, p: string, v: unknown) {
  const h = shape(c, p, v, ["harness", "version", "target", "url", "file", "size", "sha256", "evidence"], ["minimumVersion"])
  if (!h) return
  const harnessOK = oneOf(c, pointer(p, "harness"), h.harness, HARNESS_ORDER)
  const versionOK = semver(c, pointer(p, "version"), h.version)
  if (typeof h.target !== "string" || !checkTarget(h.target).ok) c.add(pointer(p, "target"), "unsupported_platform", `${String(h.target)} is not a supported target`)
  httpsURL(c, pointer(p, "url"), h.url)
  if (typeof h.file !== "string" || !FILE_NAME.test(h.file)) c.add(pointer(p, "file"), "invalid_path", "expected a plain file name")
  int(c, pointer(p, "size"), h.size, 1, 2 ** 40)
  digest(c, pointer(p, "sha256"), h.sha256)
  if (harnessOK) subset(c, pointer(p, "evidence"), h.evidence, HARNESS_EVIDENCE[h.harness as HarnessID])
  if (h.minimumVersion !== undefined && semver(c, pointer(p, "minimumVersion"), h.minimumVersion) && versionOK && compareVersions(h.minimumVersion as string, h.version as string) > 0)
    c.add(pointer(p, "minimumVersion"), "inconsistent", "the harness floor cannot be above the pinned version")
}

export function validateTrustRoot(value: unknown): Result<TrustRoot> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "threshold", "keys"])
  if (!r) return c.result(value)
  if (r.schema !== TRUST_ROOT_SCHEMA) c.add("/schema", "invalid_value", `expected schema ${TRUST_ROOT_SCHEMA}`)
  int(c, "/version", r.version, 1, 2 ** 31)
  list(c, "/keys", r.keys, 32, (p, k) => {
    const e = shape(c, p, k, ["keyID", "algorithm", "publicKey", "status"])
    if (!e) return
    text(c, pointer(p, "keyID"), e.keyID, 64, KEY_ID)
    oneOf(c, pointer(p, "algorithm"), e.algorithm, ["ed25519"] as const)
    text(c, pointer(p, "publicKey"), e.publicKey, 1024, BASE64)
    oneOf(c, pointer(p, "status"), e.status, ["active", "retired", "revoked"] as const)
  }, (k) => (isRecord(k) && typeof k.keyID === "string" ? k.keyID : undefined))
  const active = Array.isArray(r.keys) ? r.keys.filter((k) => isRecord(k) && k.status === "active").length : 0
  if (int(c, "/threshold", r.threshold, 1, 32) && (r.threshold as number) > active) c.add("/threshold", "inconsistent", "the threshold exceeds the active keys")
  return c.result(value)
}

export type SignatureVerifier = (payload: string, signature: string, publicKey: string) => boolean

/** ed25519 over the payload's UTF-8 bytes; false on any malformed input. */
export const ed25519Verify: SignatureVerifier = (payload, signature, publicKey) => {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64"))
  } catch {
    return false
  }
}

/** The bytes a manifest's signatures cover: its canonical JSON without `signatures`. */
export function manifestPayload(manifest: Omit<ArtifactManifest, "signatures"> & { readonly signatures?: unknown }): string {
  const { signatures: _signatures, ...body } = manifest
  return canonicalJSON(body)
}

/** How many distinct active keys of `root` validly signed `payload`. */
function countSigners(payload: string, signatures: readonly Signature[], root: TrustRoot, verifier: SignatureVerifier): number {
  const signed = new Set<string>()
  for (const s of signatures) {
    const key = root.keys.find((k) => k.keyID === s.keyID && k.status === "active" && k.algorithm === s.algorithm)
    if (key && !signed.has(key.keyID) && verifier(payload, s.value, key.publicKey)) signed.add(key.keyID)
  }
  return signed.size
}

export function verifyManifest(manifest: unknown, root: TrustRoot, verifier: SignatureVerifier = ed25519Verify): Result<VerifiedManifest> {
  const m = validateArtifactManifest(manifest)
  if (!m.ok) return m as Result<VerifiedManifest>
  const r = validateTrustRoot(root)
  if (!r.ok) return fail("/signatures", "signature_invalid", `no usable trust root: ${r.issues.map((i) => i.message).join("; ")}`)
  const signers = countSigners(manifestPayload(m.value), m.value.signatures, root, verifier)
  if (signers < root.threshold) return fail("/signatures", "signature_invalid", `the manifest needs ${root.threshold} valid signature(s) from trusted keys, found ${signers}`)
  return ok(m.value as VerifiedManifest)
}

/** Accepts `next` only if it is newer and signed (over its canonical JSON) by `threshold` active keys of `current`. */
export function rotateTrustRoot(current: TrustRoot, next: unknown, signatures: readonly Signature[], verifier: SignatureVerifier = ed25519Verify): Result<TrustRoot> {
  const n = validateTrustRoot(next)
  if (!n.ok) return n
  if (n.value.version <= current.version) return fail("/version", "trust_root_rollback", `trust root version ${n.value.version} is not newer than ${current.version}`)
  const signers = countSigners(canonicalJSON(n.value), signatures, current, verifier)
  if (signers < current.threshold) return fail("/signatures", "signature_invalid", "the new trust root is not signed by the current root's keys")
  return n
}

/** The manifest's artifact for exactly this target. */
export function selectArtifact(manifest: ArtifactManifest, target: string): Result<ArtifactEntry> {
  if (!checkTarget(target).ok) return fail("", "wrong_platform", `${target} is not a supported target`)
  const entry = manifest.artifacts.find((a) => a.target === target)
  return entry ? ok(entry) : fail("", "wrong_platform", `release ${manifest.release} has no hubctl for ${target}`)
}

/** The downloaded bytes against the manifest entry. */
export function checkArtifactBytes(entry: ArtifactEntry, bytes: { readonly sha256: string; readonly size: number }): Result<ArtifactEntry> {
  if (bytes.size !== entry.size) return fail("/size", "integrity_mismatch", `expected ${entry.size} bytes, got ${bytes.size}`)
  if (bytes.sha256 !== entry.sha256) return fail("/sha256", "integrity_mismatch", "the download does not match the manifest digest")
  return ok(entry)
}

type Parsed = { core: [number, number, number]; pre: string[] }

function parse(version: string): Parsed {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`not a semantic version: ${version}`)
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] }
}

/** Semantic-version order (build metadata ignored; a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export interface InstallDecisionInput {
  readonly candidate: { readonly release: string; readonly minimumVersion: string; readonly sha256: string }
  readonly installed?: { readonly version: string; readonly sha256: string }
  /** The highest minimumVersion this machine has seen in a verified manifest. */
  readonly floor?: string
  /** Explicit user consent to install an older release (still never below the floor). */
  readonly allowDowngrade?: boolean
}

export type InstallKind = "install" | "upgrade" | "reinstall" | "downgrade"

export function decideInstall(input: InstallDecisionInput): Result<InstallKind> {
  const { candidate, installed } = input
  const floors = [candidate.minimumVersion, ...(input.floor ? [input.floor] : [])]
  const floor = floors.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
  if (compareVersions(candidate.release, floor) < 0) return fail("/release", "below_security_floor", `${candidate.release} is below the security floor ${floor}`)
  if (!installed) return ok("install")
  const order = compareVersions(candidate.release, installed.version)
  if (order > 0) return ok("upgrade")
  if (order === 0) return installed.sha256 === candidate.sha256 ? ok("reinstall") : fail("/sha256", "integrity_mismatch", `${candidate.release} is already installed with different bytes`)
  return input.allowDowngrade ? ok("downgrade") : fail("/release", "downgrade_rejected", `${candidate.release} is older than the installed ${installed.version}; pass --allow-downgrade to install it`)
}

// ---------- pinned harness installs ----------

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))

/**
 * An install-harness action against the verified manifest it names: the pin for exactly this harness and target
 * must exist at exactly this version (else unpinned_artifact), with the same source, size and digest (else
 * integrity_mismatch), and the action must attempt exactly the upstream evidence the pin lists (inconsistent).
 */
export function checkHarnessPin(manifest: VerifiedManifest, action: InstallHarness): Result<HarnessPin> {
  if (action.source.manifest !== manifest.release) return fail("/source/manifest", "unpinned_artifact", `the install names hub ${action.source.manifest}, but the verified manifest is ${manifest.release}`)
  const pin = manifest.harnesses.find((h) => h.harness === action.harness && h.target === action.target)
  if (!pin) return fail("", "unpinned_artifact", `hub ${manifest.release} pins no ${action.harness} for ${action.target}`)
  if (pin.version !== action.version) return fail("/version", "unpinned_artifact", `hub ${manifest.release} pins ${action.harness} ${pin.version}, not ${action.version}`)
  if (pin.url !== action.source.url || pin.file !== action.source.file) return fail("/source", "integrity_mismatch", "the download source differs from the pinned one")
  if (pin.sha256 !== action.sha256 || pin.size !== action.size) return fail("/sha256", "integrity_mismatch", "the digest or size differs from the pinned one")
  if (!sameSet(pin.evidence, action.evidence)) return fail("/evidence", "inconsistent", `the install attempts exactly the available evidence (${pin.evidence.join(", ") || "none"})`)
  return ok(pin)
}

/** The result of one evidence check on a downloaded harness artifact. */
export interface EvidenceResult {
  readonly kind: EvidenceKind | "sha256-pin"
  readonly status: "verified" | "unavailable" | "failed"
  /** One line ("no gpg on PATH", "Good signature"); never a credential. */
  readonly detail?: string
}

/**
 * Checks the downloaded bytes against the pinned digest first (mandatory: there is always at least this
 * evidence), then folds in the upstream checks: any failure rejects the artifact (evidence_failed), a planned check
 * that did not run is "unavailable", and a check nobody planned is refused. Returns the report to record.
 */
export function checkHarnessEvidence(action: InstallHarness, bytes: { readonly sha256: string; readonly size: number }, results: readonly EvidenceResult[]): Result<EvidenceResult[]> {
  if (bytes.sha256 !== action.sha256 || bytes.size !== action.size) return fail("/sha256", "integrity_mismatch", "the download does not match the pinned digest")
  for (const result of results) {
    if (result.kind === "sha256-pin" || !action.evidence.includes(result.kind)) return fail("/evidence", "inconsistent", `${result.kind} was not planned for this install`)
    if (result.status === "failed") return fail("/evidence", "evidence_failed", `${result.kind} verification failed${result.detail ? `: ${result.detail}` : ""}`)
  }
  return ok([{ kind: "sha256-pin", status: "verified" }, ...action.evidence.map((kind): EvidenceResult => results.find((r) => r.kind === kind) ?? { kind, status: "unavailable" })])
}

/** The downgrade policy for a pinned harness (decideInstall with the pin's floor). */
export function decideHarnessInstall(
  pin: HarnessPin,
  options: { readonly installed?: { readonly version: string; readonly sha256: string }; readonly floor?: string; readonly allowDowngrade?: boolean },
): Result<InstallKind> {
  return decideInstall({ candidate: { release: pin.version, minimumVersion: pin.minimumVersion ?? "0.0.0", sha256: pin.sha256 }, ...options })
}
