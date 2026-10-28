// An in-house check of one OpenPGP detached signature (RFC 4880 v4, RSA), enough to verify Claude Code's signed
// per-release manifest.json without a hard dependency on gpg (contracts §5, decision Q3). It is deliberately
// narrow: a v4 RSA public key pinned by its fingerprint, a v4 binary-document signature, SHA-2 hashes. Every
// outcome is one of
//   verified     the pinned key signed exactly these bytes;
//   unavailable  this check cannot vouch either way (another or unpinned key, a format this verifier does not
//                read): recorded, never a pass;
//   failed       checked and wrong (a bad signature in the pinned key's name, a malformed signature packet).
// It never throws, and its detail is one short line with no input bytes in it.
import { createHash, createPublicKey, constants, verify, type KeyObject } from "node:crypto"

/** Anthropic's Claude Code release-signing key (upstream docs: `gpg --fingerprint security@anthropic.com`). */
export const CLAUDE_SIGNING_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"

export interface PgpOutcome {
  readonly status: "verified" | "unavailable" | "failed"
  readonly detail: string
}

export interface DetachedSignatureInput {
  /** The signed bytes (manifest.json, exactly as downloaded). */
  readonly data: Uint8Array
  /** The detached signature, ASCII-armored or binary. */
  readonly signature: string | Uint8Array
  /** The signer's transferable public key, ASCII-armored or binary. */
  readonly publicKey: string | Uint8Array
  /** The pinned v4 fingerprint (40 hex digits) the key must have. */
  readonly fingerprint: string
}

class Malformed extends Error {}

const RSA_ALGORITHMS = new Set([1, 2, 3])
/** OpenPGP hash IDs this verifier accepts (SHA-1 and MD5 are not accepted). */
const HASHES: Readonly<Record<number, string>> = { 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224" }
const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/

const outcome = (status: PgpOutcome["status"], detail: string): PgpOutcome => ({ status, detail: detail.slice(0, 200) })

/** The binary packets of an armored or binary OpenPGP message. */
function bytesOf(input: string | Uint8Array): Uint8Array {
  const text = typeof input === "string" ? input : input[0] === 0x2d ? new TextDecoder().decode(input) : undefined
  if (text === undefined) return input as Uint8Array
  const lines = text.split(/\r?\n/)
  let i = lines.findIndex((l) => /^-----BEGIN PGP [A-Z ]+-----$/.test(l.trim()))
  if (i < 0) throw new Malformed("not an armored OpenPGP block")
  // Armor headers end at the first blank line.
  for (i++; i < lines.length && lines[i]!.trim() !== ""; i++) if (!lines[i]!.includes(":")) break
  if (lines[i]?.trim() === "") i++
  const body: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith("-----END ")) break
    if (line.startsWith("=") && line.length === 5) continue // the armor checksum
    if (!BASE64_LINE.test(line)) throw new Malformed("the armor is not base64")
    body.push(line)
  }
  const bytes = Buffer.from(body.join(""), "base64")
  if (bytes.length === 0) throw new Malformed("the armor is empty")
  return new Uint8Array(bytes)
}

interface Packet {
  readonly tag: number
  readonly body: Uint8Array
}

/** Packets (RFC 4880 §4.2), old and new format; partial lengths are not used by keys or signatures. */
function packets(b: Uint8Array): Packet[] {
  const out: Packet[] = []
  let i = 0
  const need = (n: number) => {
    if (i + n > b.length) throw new Malformed("a packet is truncated")
  }
  while (i < b.length) {
    const h = b[i]!
    if (!(h & 0x80)) throw new Malformed("not an OpenPGP packet")
    let tag: number
    let len: number
    let head: number
    if (h & 0x40) {
      tag = h & 0x3f
      need(2)
      const o = b[i + 1]!
      if (o < 192) [len, head] = [o, 2]
      else if (o < 224) {
        need(3)
        ;[len, head] = [((o - 192) << 8) + b[i + 2]! + 192, 3]
      } else if (o === 255) {
        need(6)
        ;[len, head] = [((b[i + 2]! << 24) >>> 0) + (b[i + 3]! << 16) + (b[i + 4]! << 8) + b[i + 5]!, 6]
      } else throw new Malformed("partial packet lengths are not used here")
    } else {
      tag = (h >> 2) & 0x0f
      const type = h & 3
      if (type === 3) throw new Malformed("indeterminate packet lengths are not used here")
      head = [2, 3, 5][type]!
      need(head)
      len = type === 0 ? b[i + 1]! : type === 1 ? (b[i + 1]! << 8) + b[i + 2]! : ((b[i + 1]! << 24) >>> 0) + (b[i + 2]! << 16) + (b[i + 3]! << 8) + b[i + 4]!
    }
    need(head + len)
    out.push({ tag, body: b.subarray(i + head, i + head + len) })
    i += head + len
  }
  return out
}

/** Reads MPIs from `body` starting at `at`. */
function mpis(body: Uint8Array, at: number, count: number): { values: Uint8Array[]; end: number } {
  const values: Uint8Array[] = []
  let p = at
  for (let k = 0; k < count; k++) {
    if (p + 2 > body.length) throw new Malformed("an MPI is truncated")
    const bytes = Math.ceil(((body[p]! << 8) + body[p + 1]!) / 8)
    if (bytes === 0 || p + 2 + bytes > body.length) throw new Malformed("an MPI is truncated")
    values.push(body.subarray(p + 2, p + 2 + bytes))
    p += 2 + bytes
  }
  return { values, end: p }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex").toUpperCase()

interface PublicKey {
  readonly fingerprint: string
  readonly key?: KeyObject
  readonly modulusBytes: number
  readonly problem?: string
}

function readPublicKey(input: string | Uint8Array): PublicKey | undefined {
  try {
    const primary = packets(bytesOf(input)).find((p) => p.tag === 6)
    if (!primary) return undefined
    const body = primary.body
    const fingerprint = createHash("sha1")
      .update(Buffer.concat([Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]), body]))
      .digest("hex")
      .toUpperCase()
    if (body[0] !== 4) return { fingerprint, modulusBytes: 0, problem: `a v${body[0]} key is not supported` }
    if (body.length < 6) throw new Malformed("the key is truncated")
    if (!RSA_ALGORITHMS.has(body[5]!)) return { fingerprint, modulusBytes: 0, problem: `key algorithm ${body[5]} is not supported (RSA only)` }
    const [n, e] = mpis(body, 6, 2).values as [Uint8Array, Uint8Array]
    const key = createPublicKey({ key: { kty: "RSA", n: Buffer.from(n).toString("base64url"), e: Buffer.from(e).toString("base64url") }, format: "jwk" })
    return { fingerprint, key, modulusBytes: n.length }
  } catch {
    return undefined
  }
}

/** The v4 fingerprint of a public key (40 hex digits), or undefined when it cannot be read. */
export function publicKeyFingerprint(input: string | Uint8Array): string | undefined {
  return readPublicKey(input)?.fingerprint
}

/** Issuer fingerprint (33) and issuer key ID (16) subpackets. */
function issuers(area: Uint8Array): { fingerprint?: string; keyID?: string } {
  const found: { fingerprint?: string; keyID?: string } = {}
  let r = 0
  while (r < area.length) {
    let len = area[r]!
    let o = 1
    if (len >= 192 && len < 255) {
      if (r + 1 >= area.length) throw new Malformed("a subpacket is truncated")
      len = ((len - 192) << 8) + area[r + 1]! + 192
      o = 2
    } else if (len === 255) {
      if (r + 5 > area.length) throw new Malformed("a subpacket is truncated")
      len = ((area[r + 1]! << 24) >>> 0) + (area[r + 2]! << 16) + (area[r + 3]! << 8) + area[r + 4]!
      o = 5
    }
    if (len < 1 || r + o + len > area.length) throw new Malformed("a subpacket is truncated")
    const type = area[r + o]! & 0x7f
    const value = area.subarray(r + o + 1, r + o + len)
    if (type === 33 && value[0] === 4 && value.length === 21) found.fingerprint = hex(value.subarray(1))
    if (type === 16 && value.length === 8) found.keyID = hex(value)
    r += o + len
  }
  return found
}

/** Verifies a detached signature over `data` by the pinned key. */
export function verifyDetachedSignature(input: DetachedSignatureInput): PgpOutcome {
  const pinned = input.fingerprint.replace(/\s+/g, "").toUpperCase()
  const key = readPublicKey(input.publicKey)
  if (!key) return outcome("unavailable", "the published signing key cannot be read")
  if (key.fingerprint !== pinned) return outcome("unavailable", `the published signing key ${key.fingerprint} is not the pinned key ${pinned}`)
  if (!key.key) return outcome("unavailable", `the signing key cannot be used here: ${key.problem}`)
  try {
    const sig = packets(bytesOf(input.signature)).find((p) => p.tag === 2)?.body
    if (!sig) throw new Malformed("no signature packet")
    if (sig[0] !== 4) return outcome("unavailable", `a v${sig[0]} signature is not supported`)
    if (sig.length < 6) throw new Malformed("the signature is truncated")
    const [, type, algorithm, hashID] = sig as unknown as [number, number, number, number]
    const hashedLen = (sig[4]! << 8) + sig[5]!
    if (6 + hashedLen + 2 > sig.length) throw new Malformed("the signature is truncated")
    const hashed = sig.subarray(6, 6 + hashedLen)
    const unhashedLen = (sig[6 + hashedLen]! << 8) + sig[7 + hashedLen]!
    const unhashedAt = 8 + hashedLen
    if (unhashedAt + unhashedLen + 2 > sig.length) throw new Malformed("the signature is truncated")
    const unhashed = sig.subarray(unhashedAt, unhashedAt + unhashedLen)
    const [value] = mpis(sig, unhashedAt + unhashedLen + 2, 1).values as [Uint8Array]
    if (type !== 0x00) return outcome("unavailable", `signature type 0x${type.toString(16).padStart(2, "0")} is not supported (binary documents only)`)
    if (!RSA_ALGORITHMS.has(algorithm)) return outcome("unavailable", `signature algorithm ${algorithm} is not supported (RSA only)`)
    const hash = HASHES[hashID]
    if (!hash) return outcome("unavailable", `hash algorithm ${hashID} is not accepted`)
    const ids = { ...issuers(unhashed), ...issuers(hashed) }
    if (ids.fingerprint && ids.fingerprint !== pinned) return outcome("unavailable", `signed by another key ${ids.fingerprint}`)
    if (!ids.fingerprint && ids.keyID && ids.keyID !== pinned.slice(-16)) return outcome("unavailable", `signed by another key ${ids.keyID}`)
    const trailer = Buffer.alloc(6)
    trailer[0] = 4
    trailer[1] = 0xff
    trailer.writeUInt32BE(6 + hashedLen, 2)
    const signed = Buffer.concat([input.data, sig.subarray(0, 6 + hashedLen), trailer])
    const padded = Buffer.concat([Buffer.alloc(Math.max(0, key.modulusBytes - value.length)), value])
    const good = verify(hash, signed, { key: key.key, padding: constants.RSA_PKCS1_PADDING }, padded)
    return good ? outcome("verified", `good signature by ${pinned}`) : outcome("failed", `the signature by ${pinned} does not match these bytes`)
  } catch (error) {
    return outcome("failed", `the signature is malformed: ${error instanceof Malformed ? error.message : "unreadable"}`)
  }
}
