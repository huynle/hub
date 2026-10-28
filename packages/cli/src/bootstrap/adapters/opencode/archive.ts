// Unpacking a verified OpenCode release archive into the files of its immutable version directory (contract §3.6.1,
// data:hub/harnesses/opencode/<version>). Upstream (github.com/anomalyco/opencode releases) ships exactly one file,
// `opencode`, in a zip for macOS (opencode-darwin-<arch>.zip, deflate) and a gzipped tar for Linux
// (opencode-linux-<arch>.tar.gz). The executor has already checked the bytes against hub's pinned digest; this is a
// pure reader (no writes, no processes) that still refuses anything an archive could smuggle in: links, devices,
// names that climb out or are absolute, extra files (an installer script beside the binary), a duplicate, or no
// binary at all. The binary always becomes bin/opencode, mode 0755. No dependency: zlib from node, small readers.
import { gunzipSync, inflateRawSync } from "node:zlib"
import type { TreeFile } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"

/** Where the binary goes inside the version directory. */
export const OPENCODE_BINARY_REL = "bin/opencode"
const BINARY_NAME = "opencode"
/** A generous bound on what one release may unpack to (the 2.2.0 binary is about 220 MB). */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

interface Entry {
  readonly name: string
  readonly kind: "file" | "directory" | "other"
  readonly bytes?: Uint8Array
}

const invalid = (file: string, why: string) => txFail("invalid", `${file}: ${why}; refusing to install it`)

/** An archive member name, normalized: "./x" and "x/" are fine; empty, absolute, "..", backslashes and NUL are not. */
function memberName(raw: string): string | undefined {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\u0000")) return undefined
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".")
  if (parts.some((p) => p === "..")) return undefined
  return parts.join("/")
}

// ---------- zip ----------

function readZip(bytes: Uint8Array): Entry[] | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) return "not a zip archive"
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocd) return "an unsupported or damaged zip (zip64 or bad directory)"
  const entries: Entry[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let at = cdOffset
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) return "a damaged zip directory"
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const madeBy = view.getUint8(at + 5)
    const external = view.getUint32(at + 38, true)
    const local = view.getUint32(at + 42, true)
    let name: string
    try {
      name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen))
    } catch {
      return "a member name that is not UTF-8"
    }
    at += 46 + nameLen + extraLen + commentLen
    const type = madeBy === 3 ? (external >>> 16) & 0o170000 : name.endsWith("/") ? 0o040000 : 0o100000
    if (type === 0o040000) {
      entries.push({ name, kind: "directory" })
      continue
    }
    if (type !== 0o100000) {
      entries.push({ name, kind: "other" })
      continue
    }
    if (flags & 0x1) return `${name} is encrypted`
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) return "a damaged zip member"
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + compressed > bytes.byteLength) return "a truncated zip"
    total += size
    if (total > MAX_UNPACKED_BYTES) return "more data than any OpenCode release unpacks to"
    const data = bytes.subarray(start, start + compressed)
    let out: Uint8Array
    try {
      if (method === 0) out = data.slice()
      else if (method === 8) out = new Uint8Array(inflateRawSync(data, { maxOutputLength: size + 1 }))
      else return `${name} uses an unsupported compression method (${method})`
    } catch {
      return `${name} does not decompress`
    }
    if (out.byteLength !== size) return `${name} does not have its recorded size`
    entries.push({ name, kind: "file", bytes: out })
  }
  return entries
}

// ---------- tar.gz ----------

const field = (block: Uint8Array, at: number, len: number) => {
  const raw = block.subarray(at, at + len)
  const end = raw.indexOf(0)
  return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end))
}
const octal = (block: Uint8Array, at: number, len: number) => {
  const s = field(block, at, len).trim()
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : s === "" ? 0 : Number.NaN
}

function readTarGz(bytes: Uint8Array): Entry[] | string {
  let tar: Uint8Array
  try {
    tar = new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }))
  } catch {
    return "not a gzip archive (or larger than any OpenCode release)"
  }
  const entries: Entry[] = []
  for (let at = 0; at + 512 <= tar.byteLength; ) {
    const header = tar.subarray(at, at + 512)
    if (header.every((b) => b === 0)) return entries
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    if (octal(header, 148, 8) !== sum) return "a damaged tar header"
    const size = octal(header, 124, 12)
    if (!Number.isSafeInteger(size)) return "a damaged tar header"
    const type = field(header, 156, 1) || "0"
    const magic = field(header, 257, 6)
    const prefix = magic.startsWith("ustar") && magic !== "ustar " ? field(header, 345, 155) : ""
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100)
    const dataStart = at + 512
    if (dataStart + size > tar.byteLength) return "a truncated tar"
    if (type === "0" || type === "7") entries.push({ name, kind: "file", bytes: tar.slice(dataStart, dataStart + size) })
    else if (type === "5") entries.push({ name, kind: "directory" })
    // Symlinks (2), hard links (1), devices (3, 4), FIFOs (6), and pax/GNU headers that could rename a member (x, g, L, K).
    else entries.push({ name, kind: "other" })
    at = dataStart + Math.ceil(size / 512) * 512
  }
  return "a tar without its end marker"
}

// ---------- the tree ----------

/** The install tree of a verified OpenCode archive named `file` (its format follows the upstream asset name). */
export function unpackOpencodeArchive(file: string, bytes: Uint8Array): TxResult<TreeFile[]> {
  const read = file.endsWith(".zip") ? readZip(bytes) : file.endsWith(".tar.gz") || file.endsWith(".tgz") ? readTarGz(bytes) : `not an OpenCode CLI archive (expected .zip or .tar.gz)`
  if (typeof read === "string") return invalid(file, read)
  let binary: Uint8Array | undefined
  for (const entry of read) {
    const name = memberName(entry.name)
    if (name === undefined) return invalid(file, `the member ${JSON.stringify(entry.name)} has an unsafe name`)
    if (entry.kind === "directory" && name === "") continue
    if (entry.kind !== "file") return invalid(file, `${JSON.stringify(entry.name)} is not a regular file (links and devices are never installed)`)
    if (name !== BINARY_NAME) return invalid(file, `unexpected member ${JSON.stringify(entry.name)} (an OpenCode release holds only the ${BINARY_NAME} binary)`)
    if (binary) return invalid(file, `${BINARY_NAME} appears twice`)
    binary = entry.bytes!
  }
  if (!binary) return invalid(file, `no ${BINARY_NAME} binary inside`)
  return txOk([{ rel: OPENCODE_BINARY_REL, bytes: binary, mode: 0o755 }])
}
