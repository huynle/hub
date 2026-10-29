// Unpacks a Codex release archive (.tar.gz) into the immutable install tree, in memory and without a tar binary.
// It only ever sees bytes the install-harness executor's caller has already checked against hub's pinned digest
// (CodexHarnessSource.unpack), and it is still strict, because the tree is installed as is:
//
//   - regular files and directories only: symlinks, hard links, devices and FIFOs are refused;
//   - every name must be a safe relative path (no "..", no absolute path, no empty segment), after pax and GNU
//     long-name records; duplicates are refused; header checksums must match;
//   - modes keep only the permission bits (no setuid, setgid or sticky);
//   - two layouts are accepted: the upstream package (bin/codex plus its helpers, codex-package-<triple>.tar.gz,
//     what Codex's own install.sh installs) and the standalone binary (one codex-<triple> file, which becomes
//     bin/codex). Either way the tree has bin/codex.
import { gunzipSync } from "node:zlib"
import { isSafeRel } from "../../contracts/index.ts"
import type { TreeFile } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"

/** The executable inside an installed Codex tree. */
export const CODEX_BINARY_REL = "bin/codex"
/** Upstream archives inflate to ~0.5 GB today; anything far beyond that is refused rather than buffered. */
export const MAX_UNPACKED_BYTES = 2 * 1024 ** 3 - 1
const BLOCK = 512
const STANDALONE = /^codex-[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?$/

const bad = (why: string) => txFail("invalid", `the Codex archive is not acceptable: ${why}`)

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end))
}

function octal(block: Uint8Array, offset: number, length: number): number | undefined {
  if (block[offset]! & 0x80) {
    // GNU base-256 for large sizes.
    let n = 0
    for (let i = offset + 1; i < offset + length; i++) n = n * 256 + block[i]!
    return n
  }
  const text = field(block, offset, length).trim()
  if (text === "") return 0
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : undefined
}

function checksumOK(block: Uint8Array): boolean {
  const stored = octal(block, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!
  return stored === sum
}

/** "<len> key=value\n" records of a pax extended header. */
function paxPath(body: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(body)
  let path: string | undefined
  let at = 0
  while (at < text.length) {
    const space = text.indexOf(" ", at)
    const len = Number(text.slice(at, space))
    if (space < 0 || !Number.isInteger(len) || len <= 0) break
    const record = text.slice(space + 1, at + len - 1)
    const eq = record.indexOf("=")
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1)
    at += len
  }
  return path
}

const normalize = (name: string) => name.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")

/** The install tree of a verified Codex .tar.gz. Pure: nothing is written. */
export function unpackCodexArchive(bytes: Uint8Array, options: { readonly maxBytes?: number } = {}): TxResult<TreeFile[]> {
  const limit = options.maxBytes ?? MAX_UNPACKED_BYTES
  let data: Uint8Array
  try {
    data = new Uint8Array(gunzipSync(bytes, { maxOutputLength: limit }))
  } catch (cause) {
    return bad(/maxOutputLength|buffer|too large|exceed/i.test(String(cause)) ? `it inflates beyond ${limit} bytes` : "it is not a gzip stream")
  }
  if (data.byteLength > limit) return bad(`it inflates beyond ${limit} bytes`)

  const files: (TreeFile & { readonly bytes: Uint8Array })[] = []
  const seen = new Set<string>()
  let nextName: string | undefined
  let at = 0
  let ended = false
  while (at + BLOCK <= data.byteLength) {
    const block = data.subarray(at, at + BLOCK)
    if (block.every((b) => b === 0)) {
      ended = true
      break
    }
    if (!checksumOK(block)) return bad("a header checksum does not match")
    const size = octal(block, 124, 12)
    if (size === undefined) return bad("a header has an unreadable size")
    const type = String.fromCharCode(block[156]!)
    const bodyStart = at + BLOCK
    const bodyEnd = bodyStart + size
    if (bodyEnd > data.byteLength) return bad("it is truncated")
    const body = data.subarray(bodyStart, bodyEnd)
    at = bodyStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === "x") {
      nextName = paxPath(body) ?? nextName
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      nextName = field(body, 0, body.byteLength)
      continue
    }
    const ustar = field(block, 257, 6).startsWith("ustar")
    const prefix = ustar ? field(block, 345, 155) : ""
    const raw = nextName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100))
    nextName = undefined
    if (raw.startsWith("/")) return bad(`${JSON.stringify(raw)} is an absolute path`)
    const name = normalize(raw)
    if (type === "5") {
      if (name !== "" && !isSafeRel(name)) return bad(`${JSON.stringify(raw)} leaves the install directory`)
      continue
    }
    if (type !== "0" && type !== "\0" && type !== "7") return bad(`${JSON.stringify(raw)} is not a regular file (links and devices are never installed)`)
    if (!isSafeRel(name)) return bad(`${JSON.stringify(raw)} leaves the install directory`)
    if (seen.has(name)) return bad(`${name} appears twice`)
    seen.add(name)
    const mode = (octal(block, 100, 8) ?? 0o644) & 0o777
    files.push({ rel: name, bytes: body.slice(), mode })
  }
  if (!ended) return bad("it is truncated")

  if (files.length === 1 && STANDALONE.test(files[0]!.rel)) return txOk([{ rel: CODEX_BINARY_REL, bytes: files[0]!.bytes, mode: 0o755 }])
  if (!seen.has(CODEX_BINARY_REL)) return bad(`it has no ${CODEX_BINARY_REL}`)
  return txOk(files)
}
