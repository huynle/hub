// Test fixtures for the Codex bootstrap adapter (packages/cli/src/bootstrap/adapters/codex). Owned by the Codex
// adapter tests; the shared contract fixtures stay in ./fixtures.ts. Nothing here is real upstream material:
// archives are built in memory, and sigstore material (CA, leaf certificate, Rekor key) is generated per test
// process from ephemeral keys, so no key, certificate or digest of a real release is committed.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { gzipSync } from "node:zlib"
import { manifestPayload, verifyManifest, type ArtifactManifest, type HarnessPin, type VerifiedManifest } from "../../src/bootstrap/contracts/index.ts"
import { MANIFEST_UNSIGNED, MINUTE, T0, TRUST_ROOT_TEMPLATE } from "./fixtures.ts"

// ---------- tar archives ----------

export interface TarEntry {
  readonly name: string
  /** "0" file (default), "5" directory, "2" symlink, "1" hard link, "x" pax header for the next entry. */
  readonly type?: "0" | "5" | "2" | "1" | "x" | "L" | "3"
  readonly text?: string
  readonly bytes?: Uint8Array
  readonly mode?: number
  readonly linkname?: string
}

const enc = (s: string) => new TextEncoder().encode(s)

function header(entry: TarEntry, size: number, corruptChecksum = false): Uint8Array {
  const h = new Uint8Array(512)
  const put = (offset: number, length: number, value: string) => h.set(enc(value).slice(0, length), offset)
  const octal = (offset: number, length: number, n: number) => put(offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`)
  put(0, 100, entry.name)
  octal(100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644))
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 1_793_000_000)
  h.fill(0x20, 148, 156)
  put(156, 1, entry.type ?? "0")
  if (entry.linkname) put(157, 100, entry.linkname)
  put(257, 6, "ustar\0")
  put(263, 2, "00")
  let sum = 0
  for (const b of h) sum += b
  if (corruptChecksum) sum += 1
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return h
}

/** An uncompressed ustar archive of `entries`. */
export function tar(entries: readonly TarEntry[], options: { corruptChecksum?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    const body = entry.bytes ?? enc(entry.text ?? "")
    parts.push(header(entry, body.byteLength, options.corruptChecksum))
    if (body.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512)
      padded.set(body)
      parts.push(padded)
    }
  }
  parts.push(new Uint8Array(1024))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** A pax extended header record list ("<len> key=value\n" each). */
export function pax(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([k, v]) => {
      const body = ` ${k}=${v}\n`
      let len = body.length + 1
      while (`${len}${body}`.length !== len) len = `${len}${body}`.length
      return `${len}${body}`
    })
    .join("")
}

export const tgz = (entries: readonly TarEntry[], options?: { corruptChecksum?: boolean }) => new Uint8Array(gzipSync(tar(entries, options)))

/** The upstream package layout (codex-package-<triple>.tar.gz): bin/codex plus its helpers. */
export const PACKAGE_ENTRIES: readonly TarEntry[] = [
  { name: "bin/", type: "5" },
  { name: "bin/codex", text: "#!codex 0.165.0", mode: 0o755 },
  { name: "bin/codex-code-mode-host", text: "#!code-mode-host", mode: 0o755 },
  { name: "codex-package.json", text: '{"version":"0.165.0"}', mode: 0o644 },
  { name: "codex-path/", type: "5" },
  { name: "codex-path/rg", text: "#!rg", mode: 0o755 },
  { name: "codex-resources/", type: "5" },
  { name: "codex-resources/bwrap", text: "#!bwrap", mode: 0o755 },
  { name: "codex-resources/voice/lib/libz.so.1", text: "lib", mode: 0o555 },
]

// ---------- sigstore (legacy cosign bundles, as openai/codex publishes them) ----------

/** Minimal DER encoding, enough to mint test certificates (node:crypto parses and verifies, it cannot issue). */
const der = {
  tlv(tag: number, body: Uint8Array): Uint8Array {
    const n = body.byteLength
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]
    const out = new Uint8Array(1 + len.length + n)
    out[0] = tag
    out.set(len, 1)
    out.set(body, 1 + len.length)
    return out
  },
  cat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.byteLength
    }
    return out
  },
  seq: (...parts: Uint8Array[]) => der.tlv(0x30, der.cat(...parts)),
  set: (...parts: Uint8Array[]) => der.tlv(0x31, der.cat(...parts)),
  int: (n: number) => der.tlv(0x02, new Uint8Array(n < 0x80 ? [n] : [0, n & 0xff])),
  bool: (b: boolean) => der.tlv(0x01, new Uint8Array([b ? 0xff : 0])),
  utf8: (s: string) => der.tlv(0x0c, enc(s)),
  octets: (b: Uint8Array) => der.tlv(0x04, b),
  bits: (b: Uint8Array) => der.tlv(0x03, der.cat(new Uint8Array([0]), b)),
  oid(dotted: string): Uint8Array {
    const [a, b, ...rest] = dotted.split(".").map(Number)
    const bytes = [a! * 40 + b!]
    for (const n of rest) {
      const chunk = [n & 0x7f]
      for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80)
      bytes.push(...chunk)
    }
    return der.tlv(0x06, new Uint8Array(bytes))
  },
  time(ms: number): Uint8Array {
    const d = new Date(ms).toISOString()
    return der.tlv(0x17, enc(`${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}Z`))
  },
  name: (org: string, cn: string) => der.seq(der.set(der.seq(der.oid("2.5.4.10"), der.utf8(org))), der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn)))),
  ext: (oid: string, value: Uint8Array, critical = false) => der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octets(value)),
}

const ECDSA_SHA256 = der.seq(der.oid("1.2.840.10045.4.3.2"))
const pem = (bytes: Uint8Array) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(bytes).toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`

interface CertSpec {
  readonly serial: number
  readonly issuer: Uint8Array
  readonly subject: Uint8Array
  readonly notBefore: number
  readonly notAfter: number
  readonly publicKey: KeyObject
  readonly signer: KeyObject
  readonly extensions: readonly Uint8Array[]
}

function mintCertificate(spec: CertSpec): Uint8Array {
  const spki = new Uint8Array(spec.publicKey.export({ format: "der", type: "spki" }))
  const tbs = der.seq(
    der.tlv(0xa0, der.int(2)),
    der.int(spec.serial),
    ECDSA_SHA256,
    spec.issuer,
    der.seq(der.time(spec.notBefore), der.time(spec.notAfter)),
    spec.subject,
    spki,
    der.tlv(0xa3, der.seq(...spec.extensions)),
  )
  return der.seq(tbs, ECDSA_SHA256, der.bits(new Uint8Array(sign("sha256", tbs, spec.signer))))
}

export const CODEX_SAN = "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.165.0"
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
/** When the fixture artifact was logged (inside the leaf's 10-minute validity). */
export const INTEGRATED_MS = T0 - 60 * MINUTE
/** An instant after every fixture leaf certificate expired. */
export const T0_FOR_SIGSTORE = T0

export interface SigstoreWorld {
  /** sigstore's trusted_root.json shape, with the test CA and Rekor key. */
  readonly trustedRoot: Record<string, unknown>
  bundle(artifact: Uint8Array, options?: BundleOptions): Uint8Array
}

export interface BundleOptions {
  readonly san?: string
  readonly issuer?: string
  /** The rekor body names this digest instead of the artifact's. */
  readonly bodyDigest?: string
  /** The signature covers these bytes instead of the artifact. */
  readonly signedBytes?: Uint8Array
  /** Signed by a CA with another name (not in the trusted root) or the same name but another key. */
  readonly ca?: "trusted" | "unknown" | "impostor"
  /** The SET is signed by another key under the trusted log ID, or the log ID is unknown. */
  readonly rekor?: "trusted" | "forged" | "unknown"
  readonly integratedMs?: number
  /** Drop the Fulcio issuer extensions. */
  readonly noIssuer?: boolean
}

let cachedSigstore: SigstoreWorld | undefined

/** A per-process fake sigstore: a root and intermediate CA, a Rekor log key, and leaf certificates on demand. */
export function sigstoreWorld(): SigstoreWorld {
  if (cachedSigstore) return cachedSigstore
  const ec = () => generateKeyPairSync("ec", { namedCurve: "P-256" })
  const root = ec()
  const inter = ec()
  const rogue = ec()
  const rekor = ec()
  const rogueRekor = ec()
  const caExt = [der.ext("2.5.29.19", der.seq(der.bool(true)), true)]
  const rootName = der.name("sigstore.dev", "sigstore")
  const interName = der.name("sigstore.dev", "sigstore-intermediate")
  const year = 365 * 24 * 60 * MINUTE
  const rootCert = mintCertificate({ serial: 1, issuer: rootName, subject: rootName, notBefore: T0 - year, notAfter: T0 + year, publicKey: root.publicKey, signer: root.privateKey, extensions: caExt })
  const interCert = mintCertificate({ serial: 2, issuer: rootName, subject: interName, notBefore: T0 - year, notAfter: T0 + year, publicKey: inter.publicKey, signer: root.privateKey, extensions: caExt })
  const rekorSPKI = new Uint8Array(rekor.publicKey.export({ format: "der", type: "spki" }))
  const logID = createHash("sha256").update(rekorSPKI).digest("hex")
  const trustedRoot = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [{ baseUrl: "https://rekor.example", hashAlgorithm: "SHA2_256", publicKey: { rawBytes: Buffer.from(rekorSPKI).toString("base64"), keyDetails: "PKIX_ECDSA_P256_SHA_256", validFor: { start: new Date(T0 - year).toISOString() } }, logId: { keyId: Buffer.from(logID, "hex").toString("base64") } }],
    certificateAuthorities: [{ subject: { organization: "sigstore.dev", commonName: "sigstore" }, uri: "https://fulcio.example", certChain: { certificates: [{ rawBytes: Buffer.from(interCert).toString("base64") }, { rawBytes: Buffer.from(rootCert).toString("base64") }] }, validFor: { start: new Date(T0 - year).toISOString() } }],
    ctlogs: [],
    timestampAuthorities: [],
  }
  const bundle = (artifact: Uint8Array, o: BundleOptions = {}): Uint8Array => {
    const leaf = ec()
    const integratedMs = o.integratedMs ?? INTEGRATED_MS
    const ca = o.ca ?? "trusted"
    const issuerName = ca === "unknown" ? der.name("rogue.example", "rogue-intermediate") : interName
    const issuer = o.issuer ?? GITHUB_ISSUER
    const extensions = [
      der.ext("2.5.29.15", der.tlv(0x03, new Uint8Array([7, 0x80])), true),
      der.ext("2.5.29.37", der.seq(der.oid("1.3.6.1.5.5.7.3.3"))),
      der.ext("2.5.29.17", der.seq(der.tlv(0x86, enc(o.san ?? CODEX_SAN))), true),
      ...(o.noIssuer ? [] : [der.ext("1.3.6.1.4.1.57264.1.1", enc(issuer)), der.ext("1.3.6.1.4.1.57264.1.8", der.utf8(issuer))]),
    ]
    const cert = mintCertificate({
      serial: 3,
      issuer: issuerName,
      subject: der.seq(),
      notBefore: T0 - 61 * MINUTE,
      notAfter: T0 - 51 * MINUTE,
      publicKey: leaf.publicKey,
      signer: ca === "trusted" ? inter.privateKey : rogue.privateKey,
      extensions,
    })
    const certPEM = pem(cert)
    const signature = sign("sha256", o.signedBytes ?? artifact, leaf.privateKey).toString("base64")
    const digest = o.bodyDigest ?? createHash("sha256").update(artifact).digest("hex")
    const body = Buffer.from(
      JSON.stringify({ apiVersion: "0.0.1", kind: "hashedrekord", spec: { data: { hash: { algorithm: "sha256", value: digest } }, signature: { content: signature, publicKey: { content: Buffer.from(certPEM).toString("base64") } } } }),
    ).toString("base64")
    const payload = { body, integratedTime: Math.floor(integratedMs / 1000), logIndex: 123_456_789, logID: o.rekor === "unknown" ? "f".repeat(64) : logID }
    const canonical = JSON.stringify({ body: payload.body, integratedTime: payload.integratedTime, logID: payload.logID, logIndex: payload.logIndex })
    const set = sign("sha256", Buffer.from(canonical), o.rekor === "forged" ? rogueRekor.privateKey : rekor.privateKey).toString("base64")
    return enc(JSON.stringify({ base64Signature: signature, cert: Buffer.from(certPEM).toString("base64"), rekorBundle: { SignedEntryTimestamp: set, Payload: payload } }))
  }
  cachedSigstore = { trustedRoot, bundle }
  return cachedSigstore
}

// ---------- a signed hub manifest pinning test Codex archives ----------

export const CODEX_VERSION = "0.165.0"
export const CODEX_RELEASE_BASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}`
/** The test archives (the upstream package layout); their digests are what the test manifest pins. */
export const CODEX_ARCHIVE_LINUX = tgz(PACKAGE_ENTRIES)
export const CODEX_ARCHIVE_DARWIN = tgz(PACKAGE_ENTRIES.filter((e) => !e.name.startsWith("codex-resources")))
const digestOf = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`

export const CODEX_PINS: readonly HarnessPin[] = [
  {
    harness: "codex",
    version: CODEX_VERSION,
    target: "linux-x64",
    url: `${CODEX_RELEASE_BASE}/codex-package-x86_64-unknown-linux-musl.tar.gz`,
    file: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    size: CODEX_ARCHIVE_LINUX.byteLength,
    sha256: digestOf(CODEX_ARCHIVE_LINUX),
    evidence: ["sigstore"],
    minimumVersion: "0.160.0",
  },
  {
    harness: "codex",
    version: CODEX_VERSION,
    target: "darwin-arm64",
    url: `${CODEX_RELEASE_BASE}/codex-package-aarch64-apple-darwin.tar.gz`,
    file: "codex-package-aarch64-apple-darwin.tar.gz",
    size: CODEX_ARCHIVE_DARWIN.byteLength,
    sha256: digestOf(CODEX_ARCHIVE_DARWIN),
    evidence: [],
  },
]

let cachedCodexManifest: VerifiedManifest | undefined

/** MANIFEST_UNSIGNED with CODEX_PINS instead of its codex pin, signed once per process by an ephemeral key. */
export function codexManifest(): VerifiedManifest {
  if (cachedCodexManifest) return cachedCodexManifest
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const body: Omit<ArtifactManifest, "signatures"> = { ...MANIFEST_UNSIGNED, harnesses: [...MANIFEST_UNSIGNED.harnesses.filter((h) => h.harness !== "codex"), ...CODEX_PINS] }
  const manifest: ArtifactManifest = { ...body, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const verified = verifyManifest(manifest, root)
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues))
  cachedCodexManifest = verified.value
  return verified.value
}

/** A fake https downloader: url → bytes (absent: 404), recording every request. */
export function fakeDownloads(files: Record<string, Uint8Array | "error">) {
  const requests: string[] = []
  return {
    requests,
    get: async (url: string, options: { readonly maxBytes: number }) => {
      requests.push(url)
      const f = files[url]
      if (f === undefined) return { status: "missing" as const }
      if (f === "error") return { status: "error" as const, detail: "connection reset" }
      if (f.byteLength > options.maxBytes) return { status: "error" as const, detail: "too large" }
      return { status: "ok" as const, bytes: f }
    },
  }
}
