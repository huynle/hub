// Unpacks a Codex release archive (.tar.gz) into the immutable install tree, without a tar binary, streaming: the
// package inflates to ~0.5 GB, so the archive is read from the staging area in chunks (archive-stream.ts) and each
// member is streamed into its own staging file, hashed as it is written (HBS-12; nothing is held whole). It only
// ever sees a download the install-harness executor has already checked against hub's pinned digest
// (CodexHarnessSource.unpack), and it is still strict, because the tree is installed as is:
//
//   - regular files and directories only: symlinks, hard links, devices and FIFOs are refused;
//   - every name must be a safe relative path (no "..", no absolute path, no empty segment), after pax and GNU
//     long-name records; duplicates are refused; header checksums must match;
//   - modes keep only the permission bits (no setuid, setgid or sticky);
//   - two layouts are accepted: the upstream package (bin/codex plus its helpers, codex-package-<triple>.tar.gz,
//     what Codex's own install.sh installs) and the standalone binary (one codex-<triple> file, which becomes
//     bin/codex). Either way the tree has bin/codex.
import { isSafeRel } from "../../contracts/index.ts"
import type { TreeFile } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { bytesReader, memoryStaging, type ByteReader, type StagedFile, type StagingArea } from "../../transaction/stream.ts"
import { ArchiveError, readTarGz } from "../archive-stream.ts"

/** The executable inside an installed Codex tree. */
export const CODEX_BINARY_REL = "bin/codex"
/** Upstream archives inflate to ~0.5 GB today; anything far beyond that is refused, as it inflates. */
export const MAX_UNPACKED_BYTES = 2 * 1024 ** 3 - 1
/** pax and GNU long-name records are small; a larger one is not a name. */
const MAX_NAME_RECORD = 64 * 1024
const STANDALONE = /^codex-[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?$/

const bad = (why: string) => txFail("invalid", `the Codex archive is not acceptable: ${why}`)

function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end))
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

/**
 * The install tree of a verified Codex .tar.gz read from `reader`: every file is streamed into `staging` (judged
 * before its body is read). `maxBytes` (default MAX_UNPACKED_BYTES) bounds what the archive inflates to.
 */
export async function unpackCodexFile(reader: ByteReader, staging: StagingArea, options: { readonly maxBytes?: number } = {}): Promise<TxResult<TreeFile[]>> {
  const files: { rel: string; staged: StagedFile; mode: number }[] = []
  const seen = new Set<string>()
  let nextName: string | undefined
  try {
    await readTarGz(reader, { maxBytes: options.maxBytes ?? MAX_UNPACKED_BYTES }, async (member) => {
      const { type } = member.header
      if (type === "x") {
        nextName = paxPath(await member.bytes(MAX_NAME_RECORD)) ?? nextName
        return
      }
      if (type === "g") return
      if (type === "L") {
        nextName = field(await member.bytes(MAX_NAME_RECORD))
        return
      }
      const raw = nextName ?? member.header.name
      nextName = undefined
      if (raw.startsWith("/")) throw new ArchiveError(`${JSON.stringify(raw)} is an absolute path`)
      const name = normalize(raw)
      if (type === "5") {
        if (name !== "" && !isSafeRel(name)) throw new ArchiveError(`${JSON.stringify(raw)} leaves the install directory`)
        return
      }
      if (type !== "0" && type !== "7") throw new ArchiveError(`${JSON.stringify(raw)} is not a regular file (links and devices are never installed)`)
      if (!isSafeRel(name)) throw new ArchiveError(`${JSON.stringify(raw)} leaves the install directory`)
      if (seen.has(name)) throw new ArchiveError(`${name} appears twice`)
      seen.add(name)
      const staged = await staging.write(name, member.body(), { maxBytes: member.header.size })
      files.push({ rel: name, staged, mode: (member.header.mode ?? 0o644) & 0o777 })
    })
  } catch (error) {
    if (error instanceof ArchiveError) return bad(error.message)
    throw error
  }
  if (files.length === 1 && STANDALONE.test(files[0]!.rel)) return txOk([{ rel: CODEX_BINARY_REL, staged: files[0]!.staged, mode: 0o755 }])
  if (!seen.has(CODEX_BINARY_REL)) return bad(`it has no ${CODEX_BINARY_REL}`)
  return txOk(files)
}

/** unpackCodexFile over bytes in memory, the tree as bytes (small archives: tests, fixtures). */
export async function unpackCodexArchive(bytes: Uint8Array, options: { readonly maxBytes?: number } = {}): Promise<TxResult<(TreeFile & { readonly bytes: Uint8Array })[]>> {
  const staging = memoryStaging()
  const r = await unpackCodexFile(bytesReader(bytes), staging, options)
  return r.ok ? txOk(r.value.map((f) => ({ rel: f.rel, mode: f.mode, bytes: "bytes" in f ? f.bytes : staging.bytes(f.staged) }))) : r
}
