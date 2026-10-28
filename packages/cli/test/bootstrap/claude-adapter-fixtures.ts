// Fixtures for the Claude Code bootstrap adapter (packages/cli/src/bootstrap/adapters/claude). Owned by the
// bootstrap-adapter-claude*.test.ts files; the shared contract fixtures stay in ./fixtures.ts.
//
//   UPSTREAM   the real, public release-signing key, a real per-release manifest.json and its detached signature,
//              fetched read-only from downloads.claude.ai on 2026-10-28, so the in-house OpenPGP verifier is
//              checked against upstream's own bytes (no secrets: a public key, checksums and a signature).
//   pgpKey     an ephemeral RSA key generated at test time, with helpers that build OpenPGP v4 packets and
//              detached signatures for the threat cases (no key material is committed).
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { manifestPayload, verifyManifest, type ArtifactManifest, type HarnessPin, type VerifiedManifest } from "../../src/bootstrap/contracts/index.ts"
import type { Downloader, ProbeRunner, RunResult, Scratch } from "../../src/bootstrap/adapters/claude/source.ts"
import { MANIFEST_UNSIGNED, TRUST_ROOT_TEMPLATE } from "./fixtures.ts"

/** Upstream Claude Code release-signing material, fetched read-only on 2026-10-28 (public data, no secrets). */
export const UPSTREAM = {
  /** https://downloads.claude.ai/keys/claude-code.asc */
  publicKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGnK73ABEACnbytJXkjweYrwIr0aLEFRlH+C0nF44KxFc7gQmJ6PjSPMGZAD
dxZcaixU7zZl8WxEpVO0wLmIH8cf2zGOdyuZg1Yaugk1vHb2b8WBhAGCQJdPgB8W
XquedepEYtk56uP/gCoTjJDUZluEGBHnlnuujSJ4orxEdhSykEoAUfJZGEILPpMd
bphFt/Sn+Eb/TxM5jpKPdwnv8AShNF/1mZU1fWTQq9tRKJUakZj04gdaDFElQXak
CtTij+GT6yoYCARSHwGO+PC/Pr6q4tc+D7LRjxSBvUWDoFSmlqb/PJ1hj9D/7I2O
e4XXniAPWMR56KvxHlzOzrNQdJujbJdSkCwh1ZijkSd3y8ayW5WYUTGdRab99NUw
agzlabe/VVF6kzJ0Scn5q3PihB2Y9Bwo0CKnkYk7a7KT77EWv0Kkq+VHmOtqX3a2
hhX+b6a6ve9rzJ1qZYGj+obv/C3Sx1LzUjAfqVy7RJDf2uAoP5t2g8u/TkSpUxhM
VEjZBkSxYZhMyzQM6t8IgkUfnSrIPTHixbDWARZ4beMOBjxyPZK1nP7OOrNR3TkK
JtwLMQAabURCDnL0PjS0iwBTU4jtumBD1XSULyWuoTvMljrpQr1nV1oDyOt0OLqa
KA2McWtd9PdXhC8y2EIg7TmrTlJLfHYbdmkiCYj4J49Q8HWkN/6WE+RTUwARAQAB
tD5BbnRocm9waWMgQ2xhdWRlIENvZGUgUmVsZWFzZSBTaWduaW5nIDxzZWN1cml0
eUBhbnRocm9waWMuY29tPokCUQQTAQoAOxYhBDHd3iTd+rZ59C170rqpKf8afsrO
BQJpyu9wAhsPBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJELqpKf8afsrO
l5IP/2I8X1dFy5xYczWB/coIxGjuzS/V6ByZGZZEJsbr04pmuHiFUykJqPGWGQ6q
U0YF5iEwvEkaagS5m7DzhSEf3FM3Cgafax/6d70tar9Vr1D+w6uPfxetu7u/WYJp
aolIsdh5fTrBh9zSM1Njl8FM8wG8CwZQjS33Oa7d8cwRkgdUWbt6LXgz+cTQNuBn
BgW6Ks7oZFI25dfu0ojDR+aDFJg4+4wZoyDLPvJz1SIrJ5WFGs67zsx9SfS3yZnf
XKmBe+f0dUy+GJ2nFZrXFf99+c0dPEHYO8DCeAHZizjkFrdYtUHdDU0YDYEGkLJa
bE+pgcpkHf5EvsZzHsyDbl95W/eh7pcXMbwkN+W4CBYUE9X4uHhqzWaC5yAVRWUA
1BJ9V4LjZfHPLEJt0I3TxzXiEg9/BVeaTYq9RjaxIFo9Nfk158HqJY6SA5jslBlx
Gv/No8u+xVcze2UJyGVfEIUfm92+0UAIkny3+5cuVV0ICzJxXlXj0CnLM9Lt50wE
p3suVwuBEviCbZ08eAH1Ht8gbBdSsiOkIU8CX3v/scwHHx5q0+NBL6xLrQObg13a
tRXBlKObfElkPN3lTUbUnJOW4U8uSjH8VRP+AujKWMDFe7x0zCs+iYY1mTOvbrTS
9n3CmZUmbynZ+E/QWNENpW/pDNZdWFy43PASmML5FHu4m9Sn
=oqMI
-----END PGP PUBLIC KEY BLOCK-----
`,
  /** https://downloads.claude.ai/claude-code-releases/2.1.308/manifest.json (base64 of the exact bytes) */
  manifestBase64: [
    "ewogICJ2ZXJzaW9uIjogIjIuMS4zMDgiLAogICJtYW5pZmVzdFNpZ25hdHVyZUVuZm9yY2VtZW50IjogImZsYWciLAogICJjb21taXQiOiAiMzIwZjY2",
    "ZWI4ZjgzNGJlNThhMTBjOTgyODNlYmVmMTllMzY0MGMzNyIsCiAgImJ1aWxkRGF0ZSI6ICIyMDI2LTEwLTIyVDAzOjQ4OjM3WiIsCiAgInBsYXRmb3Jt",
    "cyI6IHsKICAgICJkYXJ3aW4tYXJtNjQiOiB7CiAgICAgICJiaW5hcnkiOiAiY2xhdWRlIiwKICAgICAgImNoZWNrc3VtIjogImNhOTIzYzg2YWM4NGIz",
    "MDU3NGE4MjMzMWEwNWI2ZTA2NmMyNzQ3N2E5MjZjZWFmZmU0NmE4NDVhMzNlNGRkMzciLAogICAgICAic2l6ZSI6IDI3NDY3NTY4MAogICAgfSwKICAg",
    "ICJkYXJ3aW4teDY0IjogewogICAgICAiYmluYXJ5IjogImNsYXVkZSIsCiAgICAgICJjaGVja3N1bSI6ICI5YTBiYzE0MGY1ZmIwNmU2MzY2NjI0ZDc3",
    "MDM3MWVmMjkwZTY3MzFkMWU4NGM0ZGVmNWRhZjRkZjk0NmQxYjU5IiwKICAgICAgInNpemUiOiAyODU5MDIzODQKICAgIH0sCiAgICAibGludXgtYXJt",
    "NjQiOiB7CiAgICAgICJiaW5hcnkiOiAiY2xhdWRlIiwKICAgICAgImNoZWNrc3VtIjogImZkZDIyZTZjYmI3MzRkNTgwZjU2NjRjNDhkZjQyOTRlZWVj",
    "ODUwMjE4ZmYwN2YxODZmOWFmMzA0MjYzOTZlZTEiLAogICAgICAic2l6ZSI6IDI5MjA4NTk0NAogICAgfSwKICAgICJsaW51eC14NjQiOiB7CiAgICAg",
    "ICJiaW5hcnkiOiAiY2xhdWRlIiwKICAgICAgImNoZWNrc3VtIjogIjM1NjczM2YxODVmYTk4OGU2YmYzYWE5YTU1NTI2OWZkZDE2Nzk4MmEyZTJhODBk",
    "M2M4YTc4MDM3YmI5MmFkNTgiLAogICAgICAic2l6ZSI6IDI5MjIzMjU2MAogICAgfSwKICAgICJsaW51eC1hcm02NC1tdXNsIjogewogICAgICAiYmlu",
    "YXJ5IjogImNsYXVkZSIsCiAgICAgICJjaGVja3N1bSI6ICJiODIwYmVjMjAxNzdhYTA5ODc1NTE1Y2Y1ZmZhZGI0NDVlY2Y4MTRlYzdjOGVkNTFiYTJm",
    "ODZjMzA5MGE2OTJkIiwKICAgICAgInNpemUiOiAyODQzMTM0NzIKICAgIH0sCiAgICAibGludXgteDY0LW11c2wiOiB7CiAgICAgICJiaW5hcnkiOiAi",
    "Y2xhdWRlIiwKICAgICAgImNoZWNrc3VtIjogIjQ1Y2MxMDA5MWUxMGNhNjU4ZGFhNjkxZTg3OTA1OGJhMWQ0NzUyMjE4YzYzNTc3ZDFjN2Q1NGIwYzdk",
    "YzlhNjgiLAogICAgICAic2l6ZSI6IDI4NTg5Njg0OAogICAgfSwKICAgICJ3aW4zMi14NjQiOiB7CiAgICAgICJiaW5hcnkiOiAiY2xhdWRlLmV4ZSIs",
    "CiAgICAgICJjaGVja3N1bSI6ICJjOTc5NmJhMjJhOTIyMTU4NmIzNjM3MWIzNmY1YjY2MTk4ZDY2ZWI0YmFkZjZhNGNmNGE1ZjdiMDdiZWNlYTUzIiwK",
    "ICAgICAgInNpemUiOiAyOTczNzY5MjgKICAgIH0sCiAgICAid2luMzItYXJtNjQiOiB7CiAgICAgICJiaW5hcnkiOiAiY2xhdWRlLmV4ZSIsCiAgICAg",
    "ICJjaGVja3N1bSI6ICIzNWI1YWY1ZGRlNDZhNzc1Y2NkNWE0ZDE1NzYwOTEzYzYwODhjZjcyOTJlMWIxNWYwYjA5YjFmZDNmOTNiZmQyIiwKICAgICAg",
    "InNpemUiOiAyODE0NTMyMTYKICAgIH0KICB9LAogICJzZGtDb21wYXQiOiB7CiAgICAidGVzdGVkV3JhcHBlclZlcnNpb25zIjogWwogICAgICAiMC4z",
    "LjI3NCIsCiAgICAgICIwLjMuMjc1IiwKICAgICAgIjAuMy4yNzYiLAogICAgICAiMC4zLjI3NyIsCiAgICAgICIwLjMuMjc4IiwKICAgICAgIjAuMy4y",
    "ODAiLAogICAgICAiMC4zLjI4MSIsCiAgICAgICIwLjMuMjgyIiwKICAgICAgIjAuMy4yODMiLAogICAgICAiMC4zLjI4NCIsCiAgICAgICIwLjMuMjg1",
    "IiwKICAgICAgIjAuMy4yODYiLAogICAgICAiMC4zLjI4NyIsCiAgICAgICIwLjMuMjg4IiwKICAgICAgIjAuMy4yODkiLAogICAgICAiMC4zLjI5MCIs",
    "CiAgICAgICIwLjMuMjkxIiwKICAgICAgIjAuMy4yOTIiLAogICAgICAiMC4zLjI5MyIsCiAgICAgICIwLjMuMjk0IiwKICAgICAgIjAuMy4yOTUiLAog",
    "ICAgICAiMC4zLjI5NiIsCiAgICAgICIwLjMuMjk5IiwKICAgICAgIjAuMy4zMDAiLAogICAgICAiMC4zLjMwMSIsCiAgICAgICIwLjMuMzAyIiwKICAg",
    "ICAgIjAuMy4zMDMiLAogICAgICAiMC4zLjMwNCIsCiAgICAgICIwLjMuMzA1IgogICAgXSwKICAgICJoYXJuZXNzU2NoZW1hIjogMQogIH0KfQo=",
  ].join(""),
  /** https://downloads.claude.ai/claude-code-releases/2.1.308/manifest.json.sig */
  signature: `-----BEGIN PGP SIGNATURE-----

iQIzBAABCgAdFiEEMd3eJN36tnn0LXvSuqkp/xp+ys4FAmrZh/oACgkQuqkp/xp+
ys6+Ig/6AsPZOzGG1y67pSfZN2w0gFglh13ERw4woXLWy1XGyChSXh2zTTH5X0bJ
58Lw1nVKKAym1h9BM51t8ON3AJaAQh8WbzNJSR08I6JZ7YLQKH4JR3nNegXrb76o
ZvPd7fsJgkRFl+mVtIYxSjAqfxkVobEbNeI0kJUyu1cBwabyco9GduN/wxRyDqJ7
BDFBkky4OlEzlDb7mE7TNFgrWtLZAV+al6tg1udKgewXS1Pws6XHLMgpjfSQpPI4
IUxKnWnAunSAMauCEc+FbOV4LX9i26NXsV+3wnbMWHkObFIuDgVBcXUyFkvHfUji
KM4PLL72ZZ1JApd/yajd1w2WoU9m8TyZyQ6zwOCYNEfTXsKphCbzNDuRJOlciUQd
3CItIf1hdycFIDTrTQU5y16kWDamQnmfMIVNpMf9MEwVj7y0fbOnUG6HjVzvGOzq
MtgtZGEp7uwBwr/xYBve7viJ6+DdjdnaPBd5CKFLnch9bzyQMJBauDvJztdZpwMF
F5SjqeU1FpjctB4mYOJJ42B84O34/ge7ZH9zbnW1zm4JE8/9ifmjLP2fMgX+xHhW
Vmr7EV3DUTZzd/YXBQcOVV3pvZODAVvxAHh+9btvHGF38O5UgyTxxtJ68VYq0XEv
wFUFoQYMS/5wvKV6nK93WInzIIGLNCMki0oVGI8dgtsgtzuPvfo=
=FEjn
-----END PGP SIGNATURE-----
`,
  /** sha256 of the manifest bytes, as computed on fetch. */
  manifestSha256: "9a01bbf1996be52f13508ef9e47ef3fcf544ac39037ca91b4c87f2b4efc425fb",
  version: "2.1.308",
  /** The darwin-arm64 binary in that manifest (platforms["darwin-arm64"]). */
  darwinArm64: { checksum: "ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37", size: 274675680 },
} as const

export const upstreamManifestBytes = (): Uint8Array => new Uint8Array(Buffer.from(UPSTREAM.manifestBase64, "base64"))

// ---------- an ephemeral OpenPGP signer ----------

/** A new-format OpenPGP packet (RFC 4880 §4.2.2). */
export function packet(tag: number, body: Uint8Array): Buffer {
  const n = body.length
  const len = n < 192 ? Buffer.from([n]) : n < 8384 ? Buffer.from([((n - 192) >> 8) + 192, (n - 192) & 0xff]) : Buffer.concat([Buffer.from([0xff]), u32(n)])
  return Buffer.concat([Buffer.from([0xc0 | tag]), len, body])
}

const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff])
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function mpi(bytes: Buffer): Buffer {
  let i = 0
  while (i < bytes.length - 1 && bytes[i] === 0) i++
  const v = bytes.subarray(i)
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(v[0]!))
  return Buffer.concat([u16(bits), v])
}

/** ASCII armor (RFC 4880 §6.2), without the optional checksum line's verification by readers. */
export function armor(kind: "PUBLIC KEY BLOCK" | "SIGNATURE", data: Uint8Array): string {
  const b64 = Buffer.from(data).toString("base64").match(/.{1,64}/g)!.join("\n")
  return `-----BEGIN PGP ${kind}-----\n\n${b64}\n-----END PGP ${kind}-----\n`
}

export interface PgpKey {
  readonly privateKey: KeyObject
  /** The v4 public-key packet body. */
  readonly body: Buffer
  readonly fingerprint: string
  /** The transferable public key (key packet + user ID), armored. */
  readonly armored: string
}

export function pgpKey(created = 0x69000000): PgpKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string }
  const body = Buffer.concat([Buffer.from([4]), u32(created), Buffer.from([1]), mpi(Buffer.from(jwk.n, "base64url")), mpi(Buffer.from(jwk.e, "base64url"))])
  const fingerprint = createHash("sha1").update(Buffer.concat([Buffer.from([0x99]), u16(body.length), body])).digest("hex").toUpperCase()
  const armored = armor("PUBLIC KEY BLOCK", Buffer.concat([packet(6, body), packet(13, Buffer.from("Test Signing <test@example.invalid>"))]))
  return { privateKey, body, fingerprint, armored }
}

export interface SignOptions {
  /** Signature type (0x00 binary document, 0x01 text). */
  readonly type?: number
  /** OpenPGP hash algorithm ID (8 SHA-256, 10 SHA-512, 2 SHA-1). */
  readonly hash?: number
  /** The issuer fingerprint subpacket; default the signing key's. */
  readonly issuer?: string | null
  readonly version?: number
}

const HASHES: Record<number, string> = { 2: "sha1", 8: "sha256", 9: "sha384", 10: "sha512" }

/** A detached v4 RSA signature over `data`, as an OpenPGP signature packet (binary). */
export function pgpSign(key: PgpKey, data: Uint8Array, options: SignOptions = {}): Buffer {
  const issuer = options.issuer === undefined ? key.fingerprint : options.issuer
  const sub = (type: number, value: Buffer) => Buffer.concat([Buffer.from([value.length + 1, type]), value])
  const hashedSubs = Buffer.concat([...(issuer ? [sub(33, Buffer.concat([Buffer.from([4]), Buffer.from(issuer, "hex")]))] : []), sub(2, u32(0x6a000000))])
  const hashAlg = options.hash ?? 10
  const head = Buffer.concat([Buffer.from([options.version ?? 4, options.type ?? 0, 1, hashAlg]), u16(hashedSubs.length), hashedSubs])
  const trailer = Buffer.concat([Buffer.from([4, 0xff]), u32(head.length)])
  const sig = sign(HASHES[hashAlg] ?? "sha512", Buffer.concat([Buffer.from(data), head, trailer]), key.privateKey)
  const digest = createHash(HASHES[hashAlg] ?? "sha512").update(Buffer.concat([Buffer.from(data), head, trailer])).digest()
  return packet(2, Buffer.concat([head, u16(0), digest.subarray(0, 2), mpi(sig)]))
}

export const armoredSignature = (key: PgpKey, data: Uint8Array, options?: SignOptions) => armor("SIGNATURE", pgpSign(key, data, options))

// ---------- a pinned Claude Code release (fake binaries) ----------

const MACHO = [0xcf, 0xfa, 0xed, 0xfe]
const ELF = [0x7f, 0x45, 0x4c, 0x46]
const binary = (magic: number[], text: string) => new Uint8Array([...magic, ...new TextEncoder().encode(text)])

export const CLAUDE_VERSION = "2.1.90"
/** Stand-ins for the upstream binaries: the right magic number, then a marker. */
export const CLAUDE_BINARIES = {
  "darwin-arm64": binary(MACHO, ` fake claude ${CLAUDE_VERSION} darwin-arm64`),
  "linux-x64": binary(ELF, ` fake claude ${CLAUDE_VERSION} linux-x64`),
} as const
export type ClaudeTarget = keyof typeof CLAUDE_BINARIES

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const RELEASES = "https://downloads.claude.ai/claude-code-releases"
export const KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc"
export const binaryURL = (version: string, target: string) => `${RELEASES}/${version}/${target}/claude`

export function claudePin(target: ClaudeTarget, version = CLAUDE_VERSION, bytes: Uint8Array = CLAUDE_BINARIES[target]): HarnessPin {
  return {
    harness: "claude-code",
    version,
    target,
    url: binaryURL(version, target),
    file: "claude",
    size: bytes.byteLength,
    sha256: `sha256:${sha256Hex(bytes)}`,
    evidence: target.startsWith("darwin") ? ["gpg-manifest", "macos-notarization"] : ["gpg-manifest"],
    minimumVersion: "2.1.89",
  }
}

/** A hub manifest signed with an ephemeral ed25519 key, pinning `pins` for Claude Code (the others kept). */
export function signedHubManifest(pins: readonly HarnessPin[] = [claudePin("darwin-arm64"), claudePin("linux-x64")]): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const body: Omit<ArtifactManifest, "signatures"> = { ...MANIFEST_UNSIGNED, harnesses: [...MANIFEST_UNSIGNED.harnesses.filter((h) => h.harness !== "claude-code"), ...pins] }
  const manifest: ArtifactManifest = { ...body, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const verified = verifyManifest(manifest, root)
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues))
  return verified.value
}

/** An upstream-shaped manifest.json listing these binaries (platforms.<target>.checksum, size). */
export function upstreamManifest(version: string, binaries: Partial<Record<ClaudeTarget, Uint8Array>> = CLAUDE_BINARIES): Uint8Array {
  const platforms = Object.fromEntries(Object.entries(binaries).map(([t, b]) => [t, { binary: "claude", checksum: sha256Hex(b!), size: b!.byteLength }]))
  return new TextEncoder().encode(`${JSON.stringify({ version, platforms }, null, 2)}\n`)
}

/** A fake https server: URL → bytes (or an Error to throw); records every request. */
export class FakeDownloads implements Downloader {
  readonly requests: string[] = []
  constructor(readonly files: Map<string, Uint8Array | string | Error> = new Map()) {}
  set(url: string, body: Uint8Array | string | Error) {
    this.files.set(url, body)
    return this
  }
  async get(url: string, maxBytes: number): Promise<Uint8Array> {
    this.requests.push(url)
    const body = this.files.get(url)
    if (body === undefined) throw new Error(`404 ${url}`)
    if (body instanceof Error) throw body
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
    if (bytes.byteLength > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`)
    return bytes
  }
}

/** The upstream bucket for one release, signed by `key` (default: a fresh ephemeral key). */
export function upstreamRelease(options: { key?: PgpKey; version?: string; binaries?: Partial<Record<ClaudeTarget, Uint8Array>>; manifest?: Uint8Array; signature?: string | Error } = {}) {
  const key = options.key ?? pgpKey()
  const version = options.version ?? CLAUDE_VERSION
  const manifest = options.manifest ?? upstreamManifest(version, options.binaries)
  const downloads = new FakeDownloads()
  for (const [target, bytes] of Object.entries(CLAUDE_BINARIES)) downloads.set(binaryURL(version, target), bytes)
  downloads.set(`${RELEASES}/${version}/manifest.json`, manifest)
  downloads.set(`${RELEASES}/${version}/manifest.json.sig`, options.signature ?? armoredSignature(key, manifest))
  downloads.set(KEY_URL, key.armored)
  return { key, downloads, manifest }
}

export interface RunCall {
  readonly file: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** A fake process runner: answers by (file, args) through `script`; records every call. */
export class FakeRunner implements ProbeRunner {
  readonly calls: RunCall[] = []
  constructor(private readonly script: (file: string, args: readonly string[]) => RunResult) {}
  async run(file: string, args: readonly string[], options: { readonly env: Readonly<Record<string, string>> }): Promise<RunResult> {
    this.calls.push({ file, args: [...args], env: { ...options.env } })
    return this.script(file, args)
  }
}

/** A scratch area that only records what it was given (no files are written). */
export class FakeScratch implements Scratch {
  readonly files: Uint8Array[] = []
  async withFile<T>(bytes: Uint8Array, use: (path: string) => Promise<T>): Promise<T> {
    this.files.push(bytes)
    return use(`/scratch/claude-${this.files.length}`)
  }
}
