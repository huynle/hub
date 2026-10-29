// Offline verification of the sigstore bundles openai/codex publishes next to its Linux release assets
// (`<asset>.sigstore`; legacy cosign bundles: `{base64Signature, cert, rekorBundle: {SignedEntryTimestamp,
// Payload}}`), with node:crypto only (no sigstore dependency, no network). The upstream evidence is optional extra
// evidence on top of hub's pinned digest (docs/bootstrap-contracts.md §3.6.1, §5, Q4), so the result is one of:
//
//   verified     every check below passed;
//   unavailable  this hubctl cannot judge the bundle: it carries no sigstore trusted root, the certificate comes from
//                a CA it does not know, the entry is in a log it does not know, or the bundle is in a format it does
//                not read (sigstore bundle v0.3, say). The pinned digest still vouches for the bytes;
//   failed       a check it can run failed: the chain, the time, the identity, the signature over the artifact, the
//                Rekor SET, or the Rekor body's binding to this artifact, signature and certificate. The contract
//                rejects the artifact (evidence_failed).
//
// Checks, in order: the leaf certificate chains to a trusted Fulcio CA (each signature verified) and is a code
// signing certificate; the Rekor entry's integrated time lies inside the leaf's validity and the CA's and log's
// validFor; the leaf's SAN is exactly the expected workflow identity and its Fulcio OIDC-issuer extension
// (1.3.6.1.4.1.57264.1.8, or the older .1.1) the expected issuer; the signature verifies over the artifact bytes;
// the SET verifies with the trusted log key over the canonical {body, integratedTime, logID, logIndex}; and the
// hashedrekord body names this artifact's sha256, this signature and this certificate.
//
// Not checked (limitations, documented in the report): embedded SCTs (certificate transparency) and Merkle
// inclusion proofs (legacy bundles carry only the SET).
import { createHash, createPublicKey, createVerify, verify, X509Certificate, type KeyObject } from "node:crypto"
import type { EvidenceResult } from "../../contracts/index.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { CHUNK_BYTES, type ByteReader } from "../../transaction/stream.ts"

export interface SigstoreAuthority {
  /** Issuing CA first, root last. */
  readonly chain: readonly X509Certificate[]
  readonly validFor: Validity
}

export interface SigstoreLog {
  /** Hex sha256 of the log's DER public key (Rekor's log ID). */
  readonly logID: string
  readonly key: KeyObject
  readonly validFor: Validity
}

interface Validity {
  readonly start: number
  readonly end?: number
}

/** The trust material: Fulcio CAs and Rekor logs, from sigstore's trusted_root.json. */
export interface SigstoreTrust {
  readonly authorities: readonly SigstoreAuthority[]
  readonly logs: readonly SigstoreLog[]
}

/** Who must have signed: the certificate's SAN and its OIDC issuer. */
export interface SigstoreIdentity {
  readonly san: string
  readonly issuer: string
}

/** openai/codex signs its release assets from its rust-release workflow, at the release tag, through GitHub Actions OIDC. */
export const codexSigstoreIdentity = (version: string): SigstoreIdentity => ({
  san: `https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v${version}`,
  issuer: "https://token.actions.githubusercontent.com",
})

const CODE_SIGNING = "1.3.6.1.5.5.7.3.3"
const OIDC_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8"
const OIDC_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1"

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
const b64 = (s: unknown): Buffer | undefined => (typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? Buffer.from(s, "base64") : undefined)

function validity(v: unknown): Validity | undefined {
  if (!isObj(v)) return undefined
  const start = Date.parse(v.start)
  const end = v.end === undefined ? undefined : Date.parse(v.end)
  if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) return undefined
  return end === undefined ? { start } : { start, end }
}
const within = (t: number, v: Validity) => t >= v.start && (v.end === undefined || t <= v.end)

/** Reads sigstore's trusted_root.json (mediaType application/vnd.dev.sigstore.trustedroot+json). */
export function trustFromTrustedRoot(json: unknown): TxResult<SigstoreTrust> {
  if (!isObj(json) || !Array.isArray(json.certificateAuthorities) || !Array.isArray(json.tlogs)) return txFail("invalid", "not a sigstore trusted root")
  const authorities: SigstoreAuthority[] = []
  const logs: SigstoreLog[] = []
  try {
    for (const ca of json.certificateAuthorities) {
      const raw = isObj(ca) && isObj(ca.certChain) && Array.isArray(ca.certChain.certificates) ? ca.certChain.certificates : []
      const chain = raw.map((c: unknown) => b64(isObj(c) ? c.rawBytes : undefined)).filter((b: Buffer | undefined): b is Buffer => b !== undefined && b.byteLength > 0)
      const v = validity(isObj(ca) ? ca.validFor : undefined)
      if (chain.length > 0 && chain.length === raw.length && v) authorities.push({ chain: chain.map((b: Buffer) => new X509Certificate(b)), validFor: v })
    }
    for (const log of json.tlogs) {
      const raw = isObj(log) && isObj(log.publicKey) ? b64(log.publicKey.rawBytes) : undefined
      const id = isObj(log) && isObj(log.logId) ? b64(log.logId.keyId) : undefined
      const v = validity(isObj(log) && isObj(log.publicKey) ? log.publicKey.validFor : undefined)
      if (raw && id && v) logs.push({ logID: id.toString("hex"), key: createPublicKey({ key: raw, format: "der", type: "spki" }), validFor: v })
    }
  } catch (cause) {
    return txFail("invalid", `the sigstore trusted root has an unreadable key or certificate: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (authorities.length === 0 || logs.length === 0) return txFail("invalid", "the sigstore trusted root has no usable CA or transparency log")
  return txOk({ authorities, logs })
}

// ---------- DER, just enough to read certificate extensions ----------

interface Tlv {
  readonly tag: number
  readonly body: Uint8Array
  readonly end: number
}

function tlv(buf: Uint8Array, at: number): Tlv {
  const tag = buf[at]!
  let len = buf[at + 1]!
  let start = at + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n < 1 || n > 4) throw new Error("bad DER length")
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!
    start += n
  }
  if (start + len > buf.byteLength) throw new Error("truncated DER")
  return { tag, body: buf.subarray(start, start + len), end: start + len }
}

function children(buf: Uint8Array): Tlv[] {
  const out: Tlv[] = []
  for (let at = 0; at < buf.byteLength; ) {
    const t = tlv(buf, at)
    out.push(t)
    at = t.end
  }
  return out
}

function oidText(body: Uint8Array): string {
  const parts = [Math.floor(body[0]! / 40), body[0]! % 40]
  let n = 0
  for (const b of body.subarray(1)) {
    n = n * 128 + (b & 0x7f)
    if (!(b & 0x80)) {
      parts.push(n)
      n = 0
    }
  }
  return parts.join(".")
}

/** The certificate's extensions, OID → value bytes (the content of the extnValue OCTET STRING). */
function extensions(cert: X509Certificate): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const tbs = children(tlv(new Uint8Array(cert.raw), 0).body)[0]!
  const wrapper = children(tbs.body).find((t) => t.tag === 0xa3)
  if (!wrapper) return out
  for (const ext of children(tlv(wrapper.body, 0).body)) {
    const parts = children(ext.body)
    const value = parts[parts.length - 1]
    if (parts[0]?.tag === 0x06 && value?.tag === 0x04) out.set(oidText(parts[0].body), value.body)
  }
  return out
}

function oidcIssuer(cert: X509Certificate): string | undefined {
  const ext = extensions(cert)
  const v2 = ext.get(OIDC_ISSUER_V2)
  if (v2) {
    const s = tlv(v2, 0)
    if (s.tag === 0x0c) return new TextDecoder().decode(s.body)
  }
  const v1 = ext.get(OIDC_ISSUER_V1)
  return v1 ? new TextDecoder().decode(v1) : undefined
}

// ---------- the bundle ----------

interface LegacyBundle {
  readonly signature: Buffer
  readonly certPEM: string
  readonly set: Buffer
  readonly payload: { readonly body: string; readonly integratedTime: number; readonly logID: string; readonly logIndex: number }
}

function parseLegacy(bytes: Uint8Array): LegacyBundle | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  if (!isObj(raw) || !isObj(raw.rekorBundle) || !isObj(raw.rekorBundle.Payload)) return undefined
  const p = raw.rekorBundle.Payload
  const signature = b64(raw.base64Signature)
  const cert = b64(raw.cert)
  const set = b64(raw.rekorBundle.SignedEntryTimestamp)
  if (!signature || !cert || !set || typeof p.body !== "string" || !Number.isSafeInteger(p.integratedTime) || typeof p.logID !== "string" || !Number.isSafeInteger(p.logIndex)) return undefined
  return { signature, certPEM: cert.toString("utf8"), set, payload: { body: p.body, integratedTime: p.integratedTime, logID: p.logID, logIndex: p.logIndex } }
}

const result = (status: EvidenceResult["status"], detail: string): EvidenceResult => ({ kind: "sigstore", status, detail })
const failed = (why: string) => result("failed", `sigstore: ${why}`)
const unavailable = (why: string) => result("unavailable", `sigstore: ${why}`)

const issued = (child: X509Certificate, parent: X509Certificate) => Boolean(child.checkIssued(parent))

function verifySET(log: SigstoreLog, b: LegacyBundle): boolean {
  // Rekor signs the canonical JSON of the entry (keys sorted, no whitespace).
  const canonical = JSON.stringify({ body: b.payload.body, integratedTime: b.payload.integratedTime, logID: b.payload.logID, logIndex: b.payload.logIndex })
  try {
    return verify(log.key.asymmetricKeyType === "ed25519" ? null : "sha256", Buffer.from(canonical), log.key, b.set)
  } catch {
    return false
  }
}

/** The artifact's bytes in chunks: a staged artifact (a ~150 MB Codex package) is never read whole. */
function* piecesOf(artifact: Uint8Array | ByteReader): Generator<Uint8Array> {
  if (artifact instanceof Uint8Array) {
    yield artifact
    return
  }
  for (let at = 0; at < artifact.size; ) {
    const piece = artifact.read(at, CHUNK_BYTES)
    if (piece.byteLength === 0) return
    at += piece.byteLength
    yield piece
  }
}

/** One sigstore evidence result for `artifact`, in memory or staged (never throws). */
export function verifySigstoreBundle(bundle: Uint8Array, artifact: Uint8Array | ByteReader, options: { readonly trust?: SigstoreTrust; readonly identity: SigstoreIdentity }): EvidenceResult {
  const { trust, identity } = options
  if (!trust) return unavailable("this hubctl carries no sigstore trusted root")
  const b = parseLegacy(bundle)
  if (!b) return unavailable("the bundle is not in a format this hubctl reads (legacy cosign bundle)")
  try {
    let leaf: X509Certificate
    try {
      leaf = new X509Certificate(b.certPEM)
    } catch {
      return failed("the bundle's certificate cannot be read")
    }
    // The chain: an authority whose issuing CA issued the leaf, every signature up to its self-signed root.
    const authority = trust.authorities.find((a) => issued(leaf, a.chain[0]!))
    if (!authority) return unavailable("the certificate comes from a CA this hubctl does not trust")
    const chain = [leaf, ...authority.chain]
    for (let i = 0; i < chain.length - 1; i++)
      if (!issued(chain[i]!, chain[i + 1]!) || !chain[i]!.verify(chain[i + 1]!.publicKey)) return failed("the certificate chain does not verify")
    const root = chain[chain.length - 1]!
    if (!root.verify(root.publicKey)) return failed("the certificate chain does not verify")
    if (leaf.keyUsage !== undefined && !leaf.keyUsage.includes(CODE_SIGNING)) return failed("the certificate is not for code signing")

    const t = b.payload.integratedTime * 1000
    if (t < Date.parse(leaf.validFrom) || t > Date.parse(leaf.validTo)) return failed("the entry was logged outside the certificate's validity")
    if (!within(t, authority.validFor)) return failed("the entry was logged outside the CA's validity")

    const sans = (leaf.subjectAltName ?? "").split(/,\s*/)
    if (!sans.includes(`URI:${identity.san}`)) return failed(`the certificate is not for ${identity.san}`)
    const issuer = oidcIssuer(leaf)
    if (issuer !== identity.issuer) return failed(`the certificate's OIDC issuer is not ${identity.issuer}`)

    let signed = false
    try {
      const verifier = createVerify("sha256")
      for (const piece of piecesOf(artifact)) verifier.update(piece)
      signed = verifier.verify(leaf.publicKey, b.signature)
    } catch {}
    if (!signed) return failed("the signature does not match the artifact")

    const log = trust.logs.find((l) => l.logID === b.payload.logID.toLowerCase())
    if (!log) return unavailable("the entry is in a transparency log this hubctl does not trust")
    if (!within(t, log.validFor)) return failed("the entry was logged outside the log key's validity")
    if (!verifySET(log, b)) return failed("the transparency log's signed entry timestamp does not verify")

    let body: any
    try {
      body = JSON.parse(Buffer.from(b.payload.body, "base64").toString("utf8"))
    } catch {
      return failed("the transparency log entry cannot be read")
    }
    const hash = createHash("sha256")
    for (const piece of piecesOf(artifact)) hash.update(piece)
    const digest = hash.digest("hex")
    const spec = isObj(body) && body.kind === "hashedrekord" && isObj(body.spec) ? body.spec : undefined
    if (!spec || spec.data?.hash?.algorithm !== "sha256" || spec.data?.hash?.value !== digest) return failed("the transparency log entry is for another artifact")
    if (spec.signature?.content !== b.signature.toString("base64")) return failed("the transparency log entry has another signature")
    let logged: X509Certificate | undefined
    try {
      logged = new X509Certificate(Buffer.from(String(spec.signature?.publicKey?.content ?? ""), "base64").toString("utf8"))
    } catch {}
    if (!logged || !Buffer.from(logged.raw).equals(Buffer.from(leaf.raw))) return failed("the transparency log entry has another certificate")

    return result("verified", `sigstore: signed by ${identity.san} (log index ${b.payload.logIndex})`)
  } catch (cause) {
    return failed(`the bundle is malformed (${cause instanceof Error ? cause.message : String(cause)})`)
  }
}
