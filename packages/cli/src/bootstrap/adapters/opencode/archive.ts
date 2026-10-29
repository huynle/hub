// Unpacking a verified OpenCode release archive into the files of its immutable version directory (contract §3.6.1,
// data:hub/harnesses/opencode/<version>). Upstream (github.com/anomalyco/opencode releases) ships exactly one file,
// `opencode`, in a zip for macOS (opencode-darwin-<arch>.zip, deflate) and a gzipped tar for Linux
// (opencode-linux-<arch>.tar.gz). The executor has already checked the download against hub's pinned digest; this
// still refuses anything an archive could smuggle in: links, devices, names that climb out or are absolute, extra
// files (an installer script beside the binary), a duplicate, or no binary at all. The binary always becomes
// bin/opencode, mode 0755.
//
// Streaming (HBS-12: a 4 GB host was OOM-killed holding the archive and the ~350 MB binary several times over): the
// archive is read from the staging area in chunks (archive-stream.ts), every member is judged before its body is
// read, and the binary is streamed straight into a staging file, hashed as it is written. Nothing is held whole.
import { ArchiveError, readTarGz, zipMemberData, zipMembers } from "../archive-stream.ts"
import type { TreeFile } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { bytesReader, memoryStaging, type ByteReader, type StagedFile, type StagingArea } from "../../transaction/stream.ts"

/** Where the binary goes inside the version directory. */
export const OPENCODE_BINARY_REL = "bin/opencode"
const BINARY_NAME = "opencode"
/** A generous bound on what one release may unpack to (the 2.2.0 binary is about 350 MB). */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

const invalid = (file: string, why: string) => txFail("invalid", `${file}: ${why}; refusing to install it`)

/** An archive member name, normalized: "./x" and "x/" are fine; empty, absolute, "..", backslashes and NUL are not. */
function memberName(raw: string): string | undefined {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\u0000")) return undefined
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".")
  if (parts.some((p) => p === "..")) return undefined
  return parts.join("/")
}

/** Judges one member: undefined to skip it (the archive's own root directory), "binary" to unpack it. */
function judge(raw: string, kind: "file" | "directory" | "other", hasBinary: boolean): "binary" | undefined {
  const name = memberName(raw)
  if (name === undefined) throw new ArchiveError(`the member ${JSON.stringify(raw)} has an unsafe name`)
  if (kind === "directory" && name === "") return undefined
  if (kind !== "file") throw new ArchiveError(`${JSON.stringify(raw)} is not a regular file (links and devices are never installed)`)
  if (name !== BINARY_NAME) throw new ArchiveError(`unexpected member ${JSON.stringify(raw)} (an OpenCode release holds only the ${BINARY_NAME} binary)`)
  if (hasBinary) throw new ArchiveError(`${BINARY_NAME} appears twice`)
  return "binary"
}

const tarKind = (type: string) => (type === "0" || type === "7" ? "file" : type === "5" ? "directory" : "other")

async function fromTarGz(reader: ByteReader, staging: StagingArea, maxBytes: number): Promise<StagedFile | undefined> {
  let binary: StagedFile | undefined
  // Symlinks (2), hard links (1), devices (3, 4), FIFOs (6), and pax/GNU headers that could rename a member (x, g,
  // L, K) are all "other": refused.
  await readTarGz(reader, { maxBytes }, async (member) => {
    if (judge(member.header.name, tarKind(member.header.type), binary !== undefined) !== "binary") return
    binary = await staging.write(BINARY_NAME, member.body(), { maxBytes: member.header.size })
  })
  return binary
}

async function fromZip(reader: ByteReader, staging: StagingArea, maxBytes: number): Promise<StagedFile | undefined> {
  // The whole directory is judged before any member is inflated.
  const members = zipMembers(reader, { maxBytes })
  let chosen: (typeof members)[number] | undefined
  for (const m of members) if (judge(m.name, m.kind, chosen !== undefined) === "binary") chosen = m
  if (!chosen) return undefined
  return staging.write(BINARY_NAME, zipMemberData(reader, chosen), { maxBytes: chosen.size })
}

/**
 * The install tree of a verified OpenCode archive named `file` (its format follows the upstream asset name), read
 * from `reader`; the binary is streamed into `staging`. `maxBytes` (default MAX_UNPACKED_BYTES) bounds what it
 * inflates to.
 */
export async function unpackOpencodeFile(file: string, reader: ByteReader, staging: StagingArea, options: { readonly maxBytes?: number } = {}): Promise<TxResult<TreeFile[]>> {
  const maxBytes = options.maxBytes ?? MAX_UNPACKED_BYTES
  const zip = file.endsWith(".zip")
  if (!zip && !file.endsWith(".tar.gz") && !file.endsWith(".tgz")) return invalid(file, "not an OpenCode CLI archive (expected .zip or .tar.gz)")
  let binary: StagedFile | undefined
  try {
    binary = zip ? await fromZip(reader, staging, maxBytes) : await fromTarGz(reader, staging, maxBytes)
  } catch (error) {
    if (error instanceof ArchiveError) return invalid(file, error.message)
    throw error
  }
  if (!binary) return invalid(file, `no ${BINARY_NAME} binary inside`)
  return txOk([{ rel: OPENCODE_BINARY_REL, staged: binary, mode: 0o755 }])
}

/** unpackOpencodeFile over bytes in memory, the tree as bytes (small archives: tests, fixtures). */
export async function unpackOpencodeArchive(file: string, bytes: Uint8Array, options: { readonly maxBytes?: number } = {}): Promise<TxResult<TreeFile[]>> {
  const staging = memoryStaging()
  const r = await unpackOpencodeFile(file, bytesReader(bytes), staging, options)
  return r.ok ? txOk(r.value.map((f) => ("staged" in f ? { rel: f.rel, mode: f.mode, bytes: staging.bytes(f.staged) } : f))) : r
}
