// The filesystem operations the applier uses, and nothing more: no exec, no spawn, no network. Everything the
// transaction layer does to disk goes through a TxFs, so tests can inject faults (ENOSPC, a kill at any step
// boundary) and the engine stays a pure function of what this interface reports.
//
// Writes are only ever "create a new file exclusively" (O_CREAT|O_EXCL|O_NOFOLLOW, then fsync); replacing a file is
// always stage-then-rename, so a reader (or a crash) sees the old file or the new one, never a torn mix. Large files
// (a harness binary, hubctl itself) are written and read in chunks (createExclusive, readRange), never whole.
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
  readSync,
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

/** A file being created exclusively, written in chunks (createExclusive). */
export interface TxWriter {
  write(chunk: Uint8Array): void
  /** Sets the mode, fsyncs and closes: the file is complete. */
  close(): void
  /** Closes and removes the incomplete file. */
  abort(): void
}

export interface TxFs {
  /** Does not follow symlinks; undefined when nothing is there. */
  lstat(path: string): EntryInfo | undefined
  readFile(path: string): Uint8Array
  /** At most `length` bytes from `offset` (fewer at the end of the file). Does not follow a final symlink. */
  readRange(path: string, offset: number, length: number): Uint8Array
  readlink(path: string): string
  readdir(path: string): string[]
  /** Creates a new file (fails if anything exists there, a symlink included), writes it fully, sets `mode`, fsyncs. */
  writeExclusive(path: string, data: Uint8Array | string, mode: number): void
  /** Like writeExclusive, for content that arrives in chunks: the file is created now and completed by close(). */
  createExclusive(path: string, mode: number): TxWriter
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
  readRange(path, offset, length) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const out = new Uint8Array(length)
      let got = 0
      while (got < length) {
        const n = readSync(fd, out, got, length - got, offset + got)
        if (n === 0) break
        got += n
      }
      return got === length ? out : out.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  },
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
  createExclusive(path, mode) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
    let open = true
    const finish = (complete: boolean) => {
      if (!open) return
      open = false
      try {
        if (complete) {
          fchmodSync(fd, mode)
          fsyncSync(fd)
        }
      } finally {
        closeSync(fd)
        if (!complete) {
          try {
            unlinkSync(path)
          } catch {}
        }
      }
    }
    return {
      write(chunk) {
        if (!open) throw new Error(`${path} is already closed`)
        let offset = 0
        while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset, chunk.byteLength - offset)
      },
      close() {
        try {
          finish(true)
        } catch (error) {
          try {
            unlinkSync(path)
          } catch {}
          throw error
        }
      },
      abort: () => finish(false),
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
