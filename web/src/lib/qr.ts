// A small dependency-free QR code encoder (ISO/IEC 18004, model 2): byte mode (UTF-8), versions 1-40, error
// correction L/M/Q/H, automatic or fixed mask. Used for the app link QR in Settings → Devices → Add app,
// rendered as one inline SVG path. Structure follows Project Nayuki's reference encoder (MIT).

export type Ecc = "L" | "M" | "Q" | "H"

export interface QrCode {
  readonly version: number
  /** Modules per side (version * 4 + 17). */
  readonly size: number
  readonly mask: number
  /** modules[y][x]: true is dark. No quiet zone. */
  readonly modules: readonly (readonly boolean[])[]
}

const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 }
/** The two format-information bits of each level. */
const ECC_FORMAT: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }

// Per error-correction level (L, M, Q, H), indexed by version (index 0 unused).
// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
// prettier-ignore
const ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0

/** Data and error-correction modules of a version (all modules minus function patterns and format/version info). */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCodewords(version: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc]
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![version]! * ERROR_CORRECTION_BLOCKS[e]![version]!
}

// ---------- Reed-Solomon over GF(2^8), polynomial 0x11D ----------

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)))
  }
  return result
}

/** Splits data into blocks, appends each block's error correction, and interleaves the codewords. */
function withErrorCorrection(data: readonly number[], version: number, ecc: Ecc): number[] {
  const e = ECC_INDEX[ecc]
  const blocks = ERROR_CORRECTION_BLOCKS[e]![version]!
  const eccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += block.length
    const check = rsRemainder(block, divisor)
    if (i < shortBlocks) block.push(0)
    all.push(block.concat(check))
  }
  const result: number[] = []
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i]!)
    })
  }
  return result
}

// ---------- data encoding ----------

function encodeData(bytes: Uint8Array, version: number, ecc: Ecc): number[] {
  const bits: number[] = []
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(0b0100, 4) // byte mode
  append(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) append(b, 8)
  const capacity = dataCodewords(version, ecc) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))
  return out
}

// ---------- the matrix ----------

class Matrix {
  readonly size: number
  readonly modules: boolean[][]
  readonly fixed: boolean[][]

  constructor(readonly version: number, readonly ecc: Ecc) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.functionPatterns()
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark
    this.fixed[y]![x] = true
  }

  private functionPatterns(): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.finder(3, 3)
    this.finder(n - 4, 3)
    this.finder(3, n - 4)
    const positions = this.alignmentPositions()
    const last = positions.length - 1
    positions.forEach((px, i) =>
      positions.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
        this.alignment(px, py)
      }),
    )
    this.formatBits(0) // reserved; drawn for real once the mask is known
    this.versionBits()
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.set(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  private alignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
    return result
  }

  formatBits(mask: number): void {
    const data = (ECC_FORMAT[this.ecc] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const n = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i))
    this.set(8, n - 8, true) // the dark module
  }

  private versionBits(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, bit(bits, i))
      this.set(b, a, bit(bits, i))
    }
  }

  /** Places the codewords in the zigzag order, skipping function modules. */
  codewords(data: readonly number[]): void {
    const n = this.size
    let i = 0
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? n - 1 - vert : vert
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  /** XORs a mask pattern over the data modules (applying it twice undoes it). */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.fixed[y]![x]) continue
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x]
      }
    }
  }

  /** The standard's penalty score (lower is easier to scan). */
  penalty(): number {
    const n = this.size
    const m = this.modules
    let score = 0
    const lines: boolean[][] = []
    for (let i = 0; i < n; i++) {
      lines.push(m[i]!)
      lines.push(m.map((row) => row[i]!))
    }
    const finderLike = [true, false, true, true, true, false, true]
    for (const line of lines) {
      // N1: runs of five or more modules of one color
      let run = 1
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      // N3: 1:1:3:1:1 finder-like patterns with four light modules on either side
      for (let i = 0; i + 7 <= n; i++) {
        if (!finderLike.every((d, k) => line[i + k] === d)) continue
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k])
        const lightAfter = i + 11 <= n && [7, 8, 9, 10].every((k) => !line[i + k])
        if (lightBefore) score += 40
        if (lightAfter) score += 40
      }
    }
    // N2: 2x2 blocks of one color
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y]![x]
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3
      }
    }
    // N4: dark/light balance
    const dark = m.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const total = n * n
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
}

/** Encodes text (UTF-8, byte mode) in the smallest version that fits; error correction M by default. */
export function qrCode(text: string, options: { ecc?: Ecc; mask?: number } = {}): QrCode {
  const ecc = options.ecc ?? "M"
  const bytes = new TextEncoder().encode(text)
  let version = 1
  while (4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, ecc) * 8) {
    if (++version > 40) throw new Error("Text too long for a QR code")
  }
  const matrix = new Matrix(version, ecc)
  matrix.codewords(withErrorCorrection(encodeData(bytes, version, ecc), version, ecc))
  let mask = options.mask
  if (mask === undefined) {
    let best = Infinity
    for (let candidate = 0; candidate < 8; candidate++) {
      matrix.applyMask(candidate)
      matrix.formatBits(candidate)
      const score = matrix.penalty()
      if (score < best) {
        best = score
        mask = candidate
      }
      matrix.applyMask(candidate)
    }
  }
  if (mask === undefined || !Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error("Invalid QR mask")
  matrix.applyMask(mask)
  matrix.formatBits(mask)
  return { version, size: matrix.size, mask, modules: matrix.modules }
}

/** SVG path data drawing each dark module as a unit square, offset by a `border`-module quiet zone. */
export function qrSvgPath(qr: QrCode, border = 4): string {
  let d = ""
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + border} ${y + border}h1v1h-1z`
    }),
  )
  return d
}
