// Streaming readers for the release archives harness adapters unpack (OpenCode's tar.gz and zip, Codex's tar.gz),
// so an archive and what it unpacks to are never in memory whole: gzip and raw deflate through hub's own streaming
// decoder (inflate.ts), tar parsed block by block from the inflated stream, zip members located through the central
// directory and inflated by offset. Each reader only reports what the archive says; the adapters decide what is acceptable
// (names, types, layout) before a member's body is written anywhere. Limits are enforced while streaming: the
// inflated total (a gzip bomb stops at `maxBytes`), and a zip member never inflates past its recorded size.
// No dependency.
import type { ByteReader } from "../transaction/stream.ts"
import { crc32, gunzipChunks, InflateError, inflateRawChunks } from "./inflate.ts"

/** Why an archive was refused (the adapters phrase it). */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArchiveError"
  }
}

const BLOCK = 512

const field = (block: Uint8Array, at: number, len: number) => {
  const raw = block.subarray(at, at + len)
  const end = raw.indexOf(0)
  return new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end))
}

/** An octal tar number, or GNU base-256 (high bit set) for large sizes; undefined when unreadable. */
function tarNumber(block: Uint8Array, at: number, len: number): number | undefined {
  if (block[at]! & 0x80) {
    let n = 0
    for (let i = at + 1; i < at + len; i++) n = n * 256 + block[i]!
    return Number.isSafeInteger(n) ? n : undefined
  }
  const text = field(block, at, len).trim()
  if (text === "") return 0
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : undefined
}

function checksumOK(block: Uint8Array): boolean {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!
  return tarNumber(block, 148, 8) === sum
}

/** Pulls exact byte counts out of a chunked stream, counting everything it pulls against a limit. */
class Pull {
  private chunk: Uint8Array = new Uint8Array()
  private at = 0
  private total = 0
  constructor(
    private readonly source: Iterator<Uint8Array>,
    private readonly maxBytes: number,
    private readonly overLimit: string,
    private readonly damaged: string,
  ) {}

  private async more(): Promise<boolean> {
    let next: IteratorResult<Uint8Array>
    try {
      next = this.source.next()
    } catch (error) {
      if (error instanceof InflateError) throw new ArchiveError(`${this.damaged} (${error.message})`)
      throw error
    }
    if (next.done) return false
    this.total += next.value.byteLength
    if (this.total > this.maxBytes) throw new ArchiveError(this.overLimit)
    this.chunk = next.value
    this.at = 0
    return true
  }

  /** Exactly `n` bytes (a header), or undefined at a clean end of the stream before any of them. */
  async exact(n: number): Promise<Uint8Array | undefined> {
    const out = new Uint8Array(n)
    let got = 0
    while (got < n) {
      if (this.at >= this.chunk.byteLength && !(await this.more())) {
        if (got === 0) return undefined
        throw new ArchiveError("it is truncated")
      }
      const take = Math.min(n - got, this.chunk.byteLength - this.at)
      out.set(this.chunk.subarray(this.at, this.at + take), got)
      this.at += take
      got += take
    }
    return out
  }

  /** The next `n` bytes, as the chunks they arrive in. */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    let left = n
    while (left > 0) {
      if (this.at >= this.chunk.byteLength && !(await this.more())) throw new ArchiveError("it is truncated")
      const take = Math.min(left, this.chunk.byteLength - this.at)
      const part = this.chunk.subarray(this.at, this.at + take)
      this.at += take
      left -= take
      yield part
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.take(n));
  }
}

export interface TarHeader {
  /** The member name as the header has it (ustar prefix joined), before pax or GNU long names. */
  readonly name: string
  /** The type flag; a NUL flag reads as "0". */
  readonly type: string
  readonly size: number
  /** The permission bits field, when readable. */
  readonly mode: number | undefined
}

export interface TarMember {
  readonly header: TarHeader
  /** The member's data, in chunks (once; what is not read is skipped). */
  body(): AsyncGenerator<Uint8Array>
  /** A small member's data whole (pax and GNU long-name records); ArchiveError beyond `limit`. */
  bytes(limit: number): Promise<Uint8Array>
}

/**
 * Reads a gzipped tar from `reader`, calling `visit` for each member in order until the end marker. `visit` may
 * refuse (throw ArchiveError) before reading the body. ArchiveError for a damaged, truncated or oversized archive:
 * `maxBytes` bounds the inflated stream, and the limit is enforced as it inflates.
 */
export async function readTarGz(reader: ByteReader, options: { readonly maxBytes: number }, visit: (member: TarMember) => Promise<void>): Promise<void> {
  const iterator = gunzipChunks(reader)
  const pull = new Pull(iterator, options.maxBytes, `it inflates beyond ${options.maxBytes} bytes`, "it is not a gzip stream (or it is damaged)")
  try {
    for (;;) {
      const block = await pull.exact(BLOCK)
      if (!block) throw new ArchiveError("a tar without its end marker")
      if (block.every((b) => b === 0)) return
      if (!checksumOK(block)) throw new ArchiveError("a header checksum does not match")
      const size = tarNumber(block, 124, 12)
      if (size === undefined) throw new ArchiveError("a header has an unreadable size")
      const magic = field(block, 257, 6)
      const prefix = magic.startsWith("ustar") && magic !== "ustar " ? field(block, 345, 155) : ""
      const name = prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100)
      const flag = block[156]!
      const header: TarHeader = { name, type: flag === 0 ? "0" : String.fromCharCode(flag), size, mode: tarNumber(block, 100, 8) }
      let consumed = false
      const body = async function* () {
        if (consumed) throw new Error("a tar member's body is read once")
        consumed = true
        yield* pull.take(size)
      }
      await visit({
        header,
        body,
        async bytes(limit) {
          if (size > limit) throw new ArchiveError(`a ${header.type} record is larger than ${limit} bytes`)
          const out = new Uint8Array(size)
          let at = 0
          for await (const part of body()) {
            out.set(part, at)
            at += part.byteLength
          }
          return out
        },
      })
      if (!consumed) await pull.skip(size)
      await pull.skip((BLOCK - (size % BLOCK)) % BLOCK)
    }
  } finally {
    iterator.return(undefined)
  }
}

// ---------- zip ----------

export interface ZipMember {
  readonly name: string
  readonly kind: "file" | "directory" | "other"
  readonly encrypted: boolean
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  /** The CRC-32 the directory records for the member's data. */
  readonly crc32: number
  /** The local header's offset. */
  readonly local: number
}

/** The members a zip's central directory lists (zip64 is refused); ArchiveError when it is not a readable zip. */
export function zipMembers(reader: ByteReader, options: { readonly maxBytes: number; readonly maxEntries?: number }): ZipMember[] {
  const tailStart = Math.max(0, reader.size - 22 - 0xffff)
  const tail = reader.read(tailStart, reader.size - tailStart)
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--)
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new ArchiveError("not a zip archive")
  const count = tv.getUint16(eocd + 10, true)
  const cdSize = tv.getUint32(eocd + 12, true)
  const cdOffset = tv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > tailStart + eocd) throw new ArchiveError("an unsupported or damaged zip (zip64 or bad directory)")
  if (count > (options.maxEntries ?? 10_000) || cdSize > 16 * 1024 * 1024) throw new ArchiveError("a zip directory larger than any release has")
  const cd = reader.read(cdOffset, cdSize)
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const members: ZipMember[] = []
  let at = 0
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > cd.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new ArchiveError("a damaged zip directory")
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const madeBy = view.getUint8(at + 5)
    const external = view.getUint32(at + 38, true)
    const local = view.getUint32(at + 42, true)
    if (at + 46 + nameLen > cd.byteLength) throw new ArchiveError("a damaged zip directory")
    let name: string
    try {
      name = decoder.decode(cd.subarray(at + 46, at + 46 + nameLen))
    } catch {
      throw new ArchiveError("a member name that is not UTF-8")
    }
    at += 46 + nameLen + extraLen + commentLen
    const type = madeBy === 3 ? (external >>> 16) & 0o170000 : name.endsWith("/") ? 0o040000 : 0o100000
    const kind = type === 0o040000 ? "directory" : type === 0o100000 ? "file" : "other"
    if (kind === "file") {
      total += size
      if (total > options.maxBytes) throw new ArchiveError(`it unpacks to more than ${options.maxBytes} bytes`)
    }
    members.push({ name, kind, encrypted: (flags & 0x1) !== 0, method, compressedSize, size, crc32: crc, local })
  }
  return members
}

/**
 * One zip member's data, inflated as it streams, in chunks; ArchiveError if it is damaged, uses an unsupported
 * method, does not inflate to exactly its recorded size (it is cut off at that size, never past it), or does not
 * have its recorded CRC-32 (checked once the last chunk is out: the caller discards what it wrote).
 */
export async function* zipMemberData(reader: ByteReader, member: ZipMember): AsyncGenerator<Uint8Array> {
  if (member.encrypted) throw new ArchiveError(`${member.name} is encrypted`)
  if (member.method !== 0 && member.method !== 8) throw new ArchiveError(`${member.name} uses an unsupported compression method (${member.method})`)
  const header = reader.read(member.local, 30)
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (header.byteLength < 30 || hv.getUint32(0, true) !== 0x04034b50) throw new ArchiveError("a damaged zip member")
  const start = member.local + 30 + hv.getUint16(26, true) + hv.getUint16(28, true)
  if (start + member.compressedSize > reader.size) throw new ArchiveError("a truncated zip")
  let produced = 0
  let crc = 0
  const wrongSize = () => new ArchiveError(`${member.name} does not have its recorded size`)
  try {
    const chunks = member.method === 0 ? reader.stream(start, start + member.compressedSize) : inflateRawChunks(reader, start, start + member.compressedSize).chunks
    for await (const chunk of chunks) {
      produced += chunk.byteLength
      if (produced > member.size) throw wrongSize()
      crc = crc32(crc, chunk)
      yield chunk
    }
  } catch (error) {
    if (error instanceof InflateError) throw new ArchiveError(`${member.name} does not decompress (${error.message})`)
    throw error
  }
  if (produced !== member.size) throw wrongSize()
  if (crc !== member.crc32) throw new ArchiveError(`${member.name} does not have its recorded CRC-32`)
}

