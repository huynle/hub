// hub's own streaming DEFLATE decoder (RFC 1951), gzip reader (RFC 1952) and CRC-32, for the archive readers
// (archive-stream.ts). Why not node:zlib: its one-shot calls hold the whole output (the OOM this replaces), and with
// the real OpenCode 2.2.0 darwin zip Bun 1.3.5's zlib *streams* stalled for good (no output, no error) in about half
// the runs, even when the pump yielded to the event loop after every chunk; Node does not stall. A decoder of our own
// is deterministic on every runtime.
//
// It reads the compressed bytes synchronously from a ByteReader by offset (the staged download), 64 KiB at a time,
// and keeps only the 32 KiB window plus one output chunk: output comes in chunks of at most OUTPUT_BYTES (64 KiB),
// whatever the compression ratio, so a bomb never allocates more than that at once (the readers bound the total).
// Small chunks also keep the garbage young: with 1 MiB chunks the collector lagged by ~50 MB. Everything it
// refuses is an InflateError: a reserved block type, a stored length that does not match its complement, an
// over-subscribed or incomplete code, a distance before the start of the output, an invalid symbol, a truncated
// stream, a gzip member whose CRC-32 or size does not match its trailer.
import type { ByteReader } from "../transaction/stream.ts"

export class InflateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InflateError"
  }
}

// ---------- CRC-32 (IEEE 802.3, reflected, as gzip and zip use it), slice-by-4 ----------

const CRC = (() => {
  const t = new Uint32Array(4 * 256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 4; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n]! >>> 8) ^ t[t[(k - 1) * 256 + n]! & 0xff]!
  return t
})()

/** The CRC-32 of `data` continuing from `crc` (0 to start). */
export function crc32(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0
  let i = 0
  const n = data.byteLength
  for (; i + 4 <= n; i += 4) {
    c ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)
    c = CRC[768 + (c & 0xff)]! ^ CRC[512 + ((c >>> 8) & 0xff)]! ^ CRC[256 + ((c >>> 16) & 0xff)]! ^ CRC[c >>> 24]!
  }
  for (; i < n; i++) c = CRC[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return ~c >>> 0
}

// ---------- DEFLATE ----------

const WINDOW = 32 * 1024
/** The largest output chunk. */
export const OUTPUT_BYTES = 64 * 1024
const MAX_MATCH = 258
const INPUT_BYTES = 64 * 1024
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** A decoding table: entries (symbol << 4 | code length) indexed by the next `bits` input bits (LSB first). */
interface Table {
  readonly entries: Uint16Array
  readonly bits: number
}

/**
 * The canonical Huffman table for `lengths`. An over-subscribed set is refused; an incomplete one too, except (as
 * zlib) a literal/length or distance code of at most one bit (a single code, or none: decoding it then fails).
 */
function table(lengths: ArrayLike<number>, allowIncomplete: boolean): Table {
  const count = new Uint16Array(16)
  let max = 0
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s]!
    count[l]!++
    if (l > max) max = l
  }
  count[0] = 0
  let left = 1
  for (let l = 1; l <= 15; l++) {
    left = (left << 1) - count[l]!
    if (left < 0) throw new InflateError("an over-subscribed Huffman code")
  }
  if (left > 0 && !(allowIncomplete && max <= 1)) throw new InflateError("an incomplete Huffman code")
  const bits = Math.max(1, max)
  const entries = new Uint16Array(1 << bits)
  const next = new Uint16Array(16)
  for (let l = 1, code = 0; l <= 15; l++) {
    code = (code + count[l - 1]!) << 1
    next[l] = code
  }
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s]!
    if (l === 0) continue
    let code = next[l]!++
    let rev = 0
    for (let k = 0; k < l; k++) {
      rev = (rev << 1) | (code & 1)
      code >>>= 1
    }
    const entry = (s << 4) | l
    for (let j = rev; j < entries.length; j += 1 << l) entries[j] = entry
  }
  return { entries, bits }
}

let fixed: { lit: Table; dist: Table } | undefined
function fixedTables() {
  if (fixed) return fixed
  const lit = new Uint8Array(288)
  lit.fill(8, 0, 144)
  lit.fill(9, 144, 256)
  lit.fill(7, 256, 280)
  lit.fill(8, 280, 288)
  // The fixed distance code has 30 usable symbols of 32; 30 and 31 never occur in valid data.
  fixed = { lit: table(lit, false), dist: table(new Uint8Array(32).fill(5), false) }
  return fixed
}

/** LSB-first bits of `reader` from `start` to `end`, refilled synchronously 64 KiB at a time. */
class Bits {
  /** The current input slice and the next byte in it (the block decoder reads them directly). */
  buf: Uint8Array = new Uint8Array()
  bp = 0
  /** The absolute offset of buf[0]. */
  private base: number
  bitbuf = 0
  bitcnt = 0

  constructor(
    private readonly reader: ByteReader,
    start: number,
    private readonly end: number,
  ) {
    this.base = start
  }

  /** The next input byte, or -1 at the end of the input. */
  byte(): number {
    if (this.bp >= this.buf.byteLength) {
      const at = this.base + this.buf.byteLength
      if (at >= this.end) return -1
      this.buf = this.reader.read(at, Math.min(INPUT_BYTES, this.end - at))
      this.base = at
      this.bp = 0
      if (this.buf.byteLength === 0) return -1
    }
    return this.buf[this.bp++]!
  }

  /** Fills the bit buffer to at least `n` bits (n <= 24) where the input allows; false if it ran out. */
  fill(n: number): boolean {
    while (this.bitcnt < n) {
      let b: number
      if (this.bp < this.buf.byteLength) b = this.buf[this.bp++]!
      else if ((b = this.byte()) < 0) return false
      this.bitbuf |= b << this.bitcnt
      this.bitcnt += 8
    }
    return true
  }

  bits(n: number): number {
    if (n === 0) return 0
    if (this.bitcnt < n && !this.fill(n)) throw new InflateError("the compressed stream is truncated")
    const v = this.bitbuf & ((1 << n) - 1)
    this.bitbuf >>>= n
    this.bitcnt -= n
    return v
  }

  /** Drops the bits up to the next byte boundary. */
  align(): void {
    const drop = this.bitcnt & 7
    this.bitbuf >>>= drop
    this.bitcnt -= drop
  }

  /** The absolute offset of the first byte not consumed (at a byte boundary). */
  position(): number {
    return this.base + this.bp - (this.bitcnt >> 3)
  }

  decode(t: Table): number {
    if (this.bitcnt < t.bits) this.fill(t.bits)
    const e = t.entries[this.bitbuf & ((1 << t.bits) - 1)]!
    const l = e & 15
    if (l === 0) throw new InflateError("an invalid Huffman code")
    if (l > this.bitcnt) throw new InflateError("the compressed stream is truncated")
    this.bitbuf >>>= l
    this.bitcnt -= l
    return e >> 4
  }
}

/**
 * The raw DEFLATE stream at `start` (at most to `end`) of `reader`, decoded: `chunks` yields the output in pieces of
 * at most OUTPUT_BYTES (copies the caller may keep); once it is done, `consumed()` is how many input bytes the stream
 * took (what follows it is not read). InflateError for anything damaged.
 */
export function inflateRawChunks(reader: ByteReader, start: number, end: number): { readonly chunks: Generator<Uint8Array>; consumed(): number } {
  const input = new Bits(reader, start, end)
  let consumed = -1
  function* chunks(): Generator<Uint8Array> {
    const out = new Uint8Array(WINDOW + OUTPUT_BYTES)
    let op = 0
    let flushed = 0
    let total = 0
    const flushAt = OUTPUT_BYTES - MAX_MATCH
    // Yields what is not yet out, then slides the window down when there is no room for another chunk.
    const flush = function* (): Generator<Uint8Array> {
      if (op > flushed) yield out.slice(flushed, op)
      flushed = op
      if (op > WINDOW) {
        out.copyWithin(0, op - WINDOW, op)
        op = flushed = WINDOW
      }
    }
    let last = 0
    while (!last) {
      last = input.bits(1)
      const type = input.bits(2)
      if (type === 0) {
        input.align()
        const len = input.bits(16)
        if ((input.bits(16) ^ 0xffff) !== len) throw new InflateError("a stored block's length does not match its complement")
        for (let left = len; left > 0; left--) {
          let b: number
          if (input.bitcnt >= 8) b = input.bits(8)
          else if ((b = input.byte()) < 0) throw new InflateError("the compressed stream is truncated")
          out[op++] = b
          total++
          if (op - flushed >= flushAt) yield* flush()
        }
        continue
      }
      let lit: Table
      let dist: Table
      if (type === 1) ({ lit, dist } = fixedTables())
      else if (type === 2) {
        const hlit = input.bits(5) + 257
        const hdist = input.bits(5) + 1
        const hclen = input.bits(4) + 4
        if (hlit > 286 || hdist > 30) throw new InflateError("too many length or distance codes")
        const clens = new Uint8Array(19)
        for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]!] = input.bits(3)
        const clen = table(clens, false)
        const lengths = new Uint8Array(hlit + hdist)
        for (let i = 0; i < lengths.length; ) {
          const sym = input.decode(clen)
          if (sym < 16) lengths[i++] = sym
          else {
            let repeat: number
            let value = 0
            if (sym === 16) {
              if (i === 0) throw new InflateError("a repeated length with no previous length")
              value = lengths[i - 1]!
              repeat = 3 + input.bits(2)
            } else if (sym === 17) repeat = 3 + input.bits(3)
            else repeat = 11 + input.bits(7)
            if (i + repeat > lengths.length) throw new InflateError("code lengths run past their count")
            lengths.fill(value, i, i + repeat)
            i += repeat
          }
        }
        if (lengths[256] === 0) throw new InflateError("no end-of-block code")
        lit = table(lengths.subarray(0, hlit), true)
        dist = table(lengths.subarray(hlit), true)
      } else throw new InflateError("a reserved block type")
      // The hot loop: the bit buffer lives in locals (written back at the end of the block), the tables are
      // indexed directly, and input is taken straight from the current slice.
      const litE = lit.entries
      const litB = lit.bits
      const litM = (1 << litB) - 1
      const distE = dist.entries
      const distB = dist.bits
      const distM = (1 << distB) - 1
      let bb = input.bitbuf
      let bc = input.bitcnt
      const truncated = () => new InflateError("the compressed stream is truncated")
      for (;;) {
        // Up to litB bits (fewer only at the very end of the input).
        while (bc < litB) {
          let b: number
          if (input.bp < input.buf.byteLength) b = input.buf[input.bp++]!
          else if ((b = input.byte()) < 0) break
          bb |= b << bc
          bc += 8
        }
        const e = litE[bb & litM]!
        const l = e & 15
        if (l === 0) throw new InflateError("an invalid Huffman code")
        if (l > bc) throw truncated()
        bb >>>= l
        bc -= l
        const sym = e >> 4
        if (sym < 256) {
          out[op++] = sym
          total++
          if (op - flushed >= flushAt) yield* flush()
          continue
        }
        if (sym === 256) break
        const li = sym - 257
        if (li >= 29) throw new InflateError("an invalid length symbol")
        let len = LBASE[li]!
        let extra = LEXT[li]!
        if (extra) {
          while (bc < extra) {
            let b: number
            if (input.bp < input.buf.byteLength) b = input.buf[input.bp++]!
            else if ((b = input.byte()) < 0) throw truncated()
            bb |= b << bc
            bc += 8
          }
          len += bb & ((1 << extra) - 1)
          bb >>>= extra
          bc -= extra
        }
        while (bc < distB) {
          let b: number
          if (input.bp < input.buf.byteLength) b = input.buf[input.bp++]!
          else if ((b = input.byte()) < 0) break
          bb |= b << bc
          bc += 8
        }
        const de = distE[bb & distM]!
        const dl = de & 15
        if (dl === 0) throw new InflateError("an invalid Huffman code")
        if (dl > bc) throw truncated()
        bb >>>= dl
        bc -= dl
        const di = de >> 4
        if (di >= 30) throw new InflateError("an invalid distance symbol")
        let d = DBASE[di]!
        extra = DEXT[di]!
        if (extra) {
          while (bc < extra) {
            let b: number
            if (input.bp < input.buf.byteLength) b = input.buf[input.bp++]!
            else if ((b = input.byte()) < 0) throw truncated()
            bb |= b << bc
            bc += 8
          }
          d += bb & ((1 << extra) - 1)
          bb >>>= extra
          bc -= extra
        }
        if (d > total || d > WINDOW) throw new InflateError("a distance before the start of the output")
        if (d >= len) out.copyWithin(op, op - d, op - d + len)
        else for (let k = 0; k < len; k++) out[op + k] = out[op + k - d]!
        op += len
        total += len
        if (op - flushed >= flushAt) yield* flush()
      }
      input.bitbuf = bb
      input.bitcnt = bc
    }
    if (op > flushed) yield out.slice(flushed, op)
    input.align()
    consumed = input.position() - start
  }
  return {
    chunks: chunks(),
    consumed: () => {
      if (consumed < 0) throw new Error("the stream has not been decoded yet")
      return consumed
    },
  }
}

// ---------- gzip ----------

/**
 * The gzip stream in `reader`, decoded, member after member (concatenated members are one stream); each member's
 * CRC-32 and size are checked against its trailer. Bytes after the last member that do not start another member are
 * ignored, as gzip does. InflateError for anything damaged.
 */
export function* gunzipChunks(reader: ByteReader): Generator<Uint8Array> {
  let at = 0
  let members = 0
  for (;;) {
    const head = reader.read(at, 10)
    if (head.byteLength < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
      if (members === 0) throw new InflateError("not a gzip stream")
      return
    }
    if (head.byteLength < 10) throw new InflateError("a truncated gzip header")
    if (head[2] !== 8) throw new InflateError("a gzip member that is not deflate")
    const flags = head[3]!
    if (flags & 0xe0) throw new InflateError("a gzip header with reserved flags")
    at += 10
    if (flags & 0x04) {
      const xlen = reader.read(at, 2)
      if (xlen.byteLength < 2) throw new InflateError("a truncated gzip header")
      at += 2 + (xlen[0]! | (xlen[1]! << 8))
    }
    for (const flag of [0x08, 0x10]) {
      if (!(flags & flag)) continue
      // A zero-terminated name or comment.
      for (;;) {
        const part = reader.read(at, 4096)
        if (part.byteLength === 0) throw new InflateError("a truncated gzip header")
        const nul = part.indexOf(0)
        if (nul >= 0) {
          at += nul + 1
          break
        }
        at += part.byteLength
      }
    }
    if (flags & 0x02) at += 2
    if (at > reader.size) throw new InflateError("a truncated gzip header")
    const member = inflateRawChunks(reader, at, reader.size)
    let crc = 0
    let size = 0
    for (const chunk of member.chunks) {
      crc = crc32(crc, chunk)
      size += chunk.byteLength
      yield chunk
    }
    at += member.consumed()
    const trailer = reader.read(at, 8)
    if (trailer.byteLength < 8) throw new InflateError("a truncated gzip trailer")
    const view = new DataView(trailer.buffer, trailer.byteOffset, 8)
    if (view.getUint32(0, true) !== crc) throw new InflateError("a gzip member whose CRC-32 does not match")
    if (view.getUint32(4, true) !== size >>> 0) throw new InflateError("a gzip member whose size does not match")
    at += 8
    members++
  }
}
