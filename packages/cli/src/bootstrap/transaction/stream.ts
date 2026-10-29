// Bounded-memory plumbing for large artifacts (a harness archive, what it unpacks to, hubctl itself). Nothing here
// ever holds a whole file: bytes arrive as chunks (ByteSource), are hashed while they are written to disk, and are
// read back in chunks (ByteReader). A 4 GB host installs a 350 MB harness with a few MiB of buffers.
//
//   ByteSource    what a download yields: a Uint8Array (small things, test fakes) or an async iterable of chunks
//   StagingArea   the transaction's private scratch space for one step (state:hub/bootstrap/staging/<txID>, owner
//                 only): write() streams a source into a new file (O_EXCL, no symlinks) and records the sha256 and
//                 size of what it wrote, so the executor checks the pin against the engine's own digest, never one a
//                 source reports; open() reads a staged file back by offset (the zip central directory) or as a
//                 stream (gunzip). The engine moves staged files into the install tree and removes the rest.
//   fileDigest    the sha256 of a file on disk, read in chunks
//   copyFile      a streaming copy (exclusive create, fsync) that returns the digest of what it copied
import { createHash } from "node:crypto"
import type { TxFs } from "./fs.ts"

/** The largest piece of a file the transaction layer reads or writes at once. */
export const CHUNK_BYTES = 1024 * 1024

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>

/** A source yielded more than allowed. */
export class TooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`more than ${maxBytes} bytes`)
    this.name = "TooLarge"
  }
}

/** The chunks of a source, none larger than CHUNK_BYTES. */
export async function* chunksOf(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let at = 0; at < source.byteLength; at += CHUNK_BYTES) yield source.subarray(at, Math.min(source.byteLength, at + CHUNK_BYTES))
    return
  }
  for await (const chunk of source) {
    for (let at = 0; at < chunk.byteLength; at += CHUNK_BYTES) yield chunk.subarray(at, Math.min(chunk.byteLength, at + CHUNK_BYTES))
  }
}

/** A small source, whole (a signature, a manifest); TooLarge beyond `maxBytes`. */
export async function collect(source: ByteSource, maxBytes: number): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) throw new TooLarge(maxBytes)
    return source
  }
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > maxBytes) throw new TooLarge(maxBytes)
    parts.push(chunk)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/**
 * A response body as chunks, cancelled (and failing with tooLarge()) as soon as it runs past `maxBytes`: what the
 * https downloaders hand to a staging area.
 */
export async function* responseChunks(response: Response, maxBytes: number, tooLarge: () => Error): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** A file in a staging area (or, for hubctl's own executable, a file elsewhere), with its digest and size. */
export interface StagedFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/** Random and sequential access to a staged file, in bounded pieces. */
export interface ByteReader {
  readonly size: number
  /** At most `length` bytes from `offset`. */
  read(offset: number, length: number): Uint8Array
  /** The bytes from `start` (default 0) to `end` (default the size), in chunks of at most CHUNK_BYTES. */
  stream(start?: number, end?: number): AsyncGenerator<Uint8Array>
}

export function bytesReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.byteLength,
    read: (offset, length) => bytes.subarray(Math.max(0, offset), Math.max(0, Math.min(bytes.byteLength, offset + length))),
    async *stream(start = 0, end = bytes.byteLength) {
      yield* chunksOf(bytes.subarray(start, Math.min(end, bytes.byteLength)))
    },
  }
}

export function fileReader(fs: TxFs, path: string, size: number): ByteReader {
  return {
    size,
    read: (offset, length) => (offset >= size || length <= 0 ? new Uint8Array() : fs.readRange(path, offset, Math.min(length, size - offset))),
    async *stream(start = 0, end = size) {
      for (let at = start; at < Math.min(end, size); ) {
        const chunk = fs.readRange(path, at, Math.min(CHUNK_BYTES, end - at))
        if (chunk.byteLength === 0) return
        at += chunk.byteLength
        yield chunk
      }
    },
  }
}

export interface StagingArea {
  /**
   * Streams `source` into a new private file named after `name` (its last path segment), hashing it on the way;
   * TooLarge (and nothing left behind) beyond `maxBytes`. Errors of the source propagate the same way.
   */
  write(name: string, source: ByteSource, options: { readonly maxBytes: number }): Promise<StagedFile>
  /** Reads back a file this area wrote. */
  open(file: StagedFile): ByteReader
  /** The digest and size this area recorded while writing `file`; undefined for any file it did not write. */
  written(file: StagedFile): { readonly sha256: string; readonly size: number } | undefined
}

const safeName = (name: string) => (name.slice(name.lastIndexOf("/") + 1).replace(/[^A-Za-z0-9._-]/g, "_") || "file").slice(0, 100)
const hex = (hash: ReturnType<typeof createHash>) => `sha256:${hash.digest("hex")}`

/** A staging area in `dir` (created owner-only on first use, below an existing, symlink-checked parent). */
export function fsStaging(fs: TxFs, dir: string): StagingArea & { dispose(): void } {
  const files = new Map<string, { sha256: string; size: number }>()
  let count = 0
  const ensure = () => {
    const info = fs.lstat(dir)
    if (!info) {
      const parent = dir.slice(0, dir.lastIndexOf("/"))
      if (!fs.lstat(parent)) fs.mkdir(parent, 0o700)
      else if (fs.lstat(parent)?.kind !== "directory") throw new Error(`${parent} is not a directory`)
      fs.mkdir(dir, 0o700)
    } else if (info.kind !== "directory") throw new Error(`${dir} is not a directory`)
  }
  const remove = (path: string) => {
    const info = fs.lstat(path)
    if (!info) return
    if (info.kind === "directory") {
      for (const name of fs.readdir(path)) remove(`${path}/${name}`)
      fs.rmdir(path)
    } else fs.unlink(path)
  }
  return {
    async write(name, source, { maxBytes }) {
      ensure()
      const path = `${dir}/${++count}-${safeName(name)}`
      const out = fs.createExclusive(path, 0o600)
      const hash = createHash("sha256")
      let size = 0
      try {
        for await (const chunk of chunksOf(source)) {
          size += chunk.byteLength
          if (size > maxBytes) throw new TooLarge(maxBytes)
          hash.update(chunk)
          out.write(chunk)
        }
        out.close()
      } catch (error) {
        out.abort()
        throw error
      }
      const file = { path, sha256: hex(hash), size }
      files.set(path, { sha256: file.sha256, size })
      return file
    },
    open: (file) => {
      const known = files.get(file.path)
      if (!known) throw new Error(`${file.path} is not a file of this staging area`)
      return fileReader(fs, file.path, known.size)
    },
    written: (file) => files.get(file.path),
    dispose() {
      files.clear()
      remove(dir)
    },
  }
}

/** An in-memory staging area (tests, and the pure in-memory unpack helpers); `bytes` reads a file back whole. */
export function memoryStaging(): StagingArea & { bytes(file: StagedFile): Uint8Array } {
  const files = new Map<string, Uint8Array>()
  let count = 0
  const get = (file: StagedFile) => {
    const bytes = files.get(file.path)
    if (!bytes) throw new Error(`${file.path} is not a file of this staging area`)
    return bytes
  }
  return {
    async write(name, source, { maxBytes }) {
      const path = `memory:/${++count}-${safeName(name)}`
      const bytes = await collect(chunksOf(source), maxBytes)
      files.set(path, bytes)
      return { path, sha256: hex(createHash("sha256").update(bytes)), size: bytes.byteLength }
    },
    open: (file) => bytesReader(get(file)),
    written: (file) => {
      const bytes = files.get(file.path)
      return bytes ? { sha256: hex(createHash("sha256").update(bytes)), size: bytes.byteLength } : undefined
    },
    bytes: get,
  }
}

/** The sha256 of the regular file at `path`, read in chunks. */
export function fileDigest(fs: TxFs, path: string): string {
  const hash = createHash("sha256")
  for (let at = 0; ; ) {
    const chunk = fs.readRange(path, at, CHUNK_BYTES)
    if (chunk.byteLength === 0) break
    hash.update(chunk)
    at += chunk.byteLength
  }
  return hex(hash)
}

/** Copies `from` into a new file `to` (exclusive, `mode`, fsynced) in chunks; returns the digest of what it copied. */
export function copyFile(fs: TxFs, from: string, to: string, mode: number): string {
  const out = fs.createExclusive(to, mode)
  const hash = createHash("sha256")
  try {
    for (let at = 0; ; ) {
      const chunk = fs.readRange(from, at, CHUNK_BYTES)
      if (chunk.byteLength === 0) break
      hash.update(chunk)
      out.write(chunk)
      at += chunk.byteLength
    }
    out.close()
  } catch (error) {
    out.abort()
    throw error
  }
  return hex(hash)
}
