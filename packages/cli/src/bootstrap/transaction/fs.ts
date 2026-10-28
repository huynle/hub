// The filesystem operations the applier uses, and nothing more: no exec, no spawn, no network. Everything the
// transaction layer does to disk goes through a TxFs, so tests can inject faults (ENOSPC, a kill at any step
// boundary) and the engine stays a pure function of what this interface reports.
//
// Writes are only ever "create a new file exclusively" (O_CREAT|O_EXCL|O_NOFOLLOW, then fsync); replacing a file is
// always stage-then-rename, so a reader (or a crash) sees the old file or the new one, never a torn mix.
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import type { EntryKind } from "../contracts/index.ts"

export interface EntryInfo {
  readonly kind: EntryKind
  /** Permission bits (0..0o7777). */
  readonly mode: number
  readonly size: number
}

export interface TxFs {
  /** Does not follow symlinks; undefined when nothing is there. */
  lstat(path: string): EntryInfo | undefined
  readFile(path: string): Uint8Array
  readlink(path: string): string
  readdir(path: string): string[]
  /** Creates a new file (fails if anything exists there, a symlink included), writes it fully, sets `mode`, fsyncs. */
  writeExclusive(path: string, data: Uint8Array | string, mode: number): void
  /** Atomic replace of `to`'s directory entry. */
  rename(from: string, to: string): void
  /** Hard link; fails if `to` exists (an atomic create-if-absent of complete content). */
  link(from: string, to: string): void
  unlink(path: string): void
  /** One level; fails if it exists. */
  mkdir(path: string, mode: number): void
  /** Creates every missing level with `mode`. */
  mkdirp(path: string, mode: number): void
  /** Fails if not empty. */
  rmdir(path: string): void
  symlink(target: string, path: string): void
  chmod(path: string, mode: number): void
  /** Best effort: makes a rename in `path` durable. */
  fsyncDir(path: string): void
}

function kindOf(mode: number): EntryKind {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFREG:
      return "file"
    case constants.S_IFDIR:
      return "directory"
    case constants.S_IFLNK:
      return "symlink"
    default:
      return "other"
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

export const nodeFs: TxFs = {
  lstat(path) {
    try {
      const s = lstatSync(path)
      return { kind: kindOf(s.mode), mode: s.mode & 0o7777, size: s.size }
    } catch (error) {
      if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") return undefined
      throw error
    }
  },
  readFile: (path) => new Uint8Array(readFileSync(path)),
  readlink: (path) => readlinkSync(path),
  readdir: (path) => readdirSync(path),
  writeExclusive(path, data, mode) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
    let ok = false
    try {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data
      let offset = 0
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset)
      fchmodSync(fd, mode)
      fsyncSync(fd)
      ok = true
    } finally {
      closeSync(fd)
      if (!ok) {
        try {
          unlinkSync(path)
        } catch {}
      }
    }
  },
  rename: (from, to) => renameSync(from, to),
  link: (from, to) => linkSync(from, to),
  unlink: (path) => unlinkSync(path),
  mkdir: (path, mode) => mkdirSync(path, { mode }),
  mkdirp: (path, mode) => void mkdirSync(path, { recursive: true, mode }),
  rmdir: (path) => rmdirSync(path),
  symlink: (target, path) => symlinkSync(target, path),
  chmod: (path, mode) => chmodSync(path, mode),
  fsyncDir(path) {
    try {
      const fd = openSync(path, constants.O_RDONLY)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {}
  },
}
