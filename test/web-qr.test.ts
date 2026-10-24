// The dependency-free QR encoder behind Settings → Devices → Add app. Expected matrices come from two independent
// encoders that agree module for module: Nayuki's qrcodegen 1.8 (Python) and segno 1.6 (with its padding fixed:
// segno adds 8 extra zero bits to a byte-aligned stream). Byte mode, smallest version, no error boost, fixed
// mask; stored as SHA-256 of the rows ("0"/"1" per module, rows joined by "\n", no quiet zone).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { qrCode, qrSvgPath, type Ecc } from "../web/src/lib/qr"

const rows = (m: readonly (readonly boolean[])[]) => m.map((r) => r.map((c) => (c ? "1" : "0")).join("")).join("\n")
const sha = (m: readonly (readonly boolean[])[]) => createHash("sha256").update(rows(m)).digest("hex")

const URL = "hubapp://link?hub=https%3A%2F%2Fhub.example.com&code=Xq3v9Zl0aB7cD2eF4gH6iJ8kL1mN3oP5qR7sT9uV0wY"

const HELLO_M0 = [
  "111111100111001111111",
  "100000101011001000001",
  "101110100010001011101",
  "101110100011001011101",
  "101110101010101011101",
  "100000100110101000001",
  "111111101010101111111",
  "000000000101100000000",
  "101010100101000010010",
  "101010000110001000010",
  "000001100110100011111",
  "101011010110001000010",
  "011001110110101010100",
  "000000001011010100110",
  "111111100001011100111",
  "100000100011110110000",
  "101110101011011100111",
  "101110100100001100110",
  "101110101010100010101",
  "100000100110001010010",
  "111111101010101100111",
].join("\n")

const VECTORS: Array<[text: string, ecc: Ecc, mask: number, version: number, sha256: string]> = [
  [URL, "M", 0, 6, "bf4dfac8bfb18ce480614d82263b66208d29a5233dd5adb61dfaadd9ad7b70fa"],
  [URL, "M", 1, 6, "0e731a02bd7f99c6209bddcfe7e798a296e92326daf4a5e5bfc59ebd74484cbe"],
  [URL, "M", 2, 6, "ffcb15a51de8077038e9eeb36ba94b622c296de43937871aab0ba82196a65cb9"],
  [URL, "M", 3, 6, "888299e9411fa4faf57c177c93e4519a175023b4f9facf303b1423ebecc13340"],
  [URL, "M", 4, 6, "0edd2ed33d302da03b1ade4cd92e20b4c2c4fccd99961618c596f39ec102650f"],
  [URL, "M", 5, 6, "8935240e2e2488b7b280b7bcf2dbbe165296f059620c7e0e3661fce5e4a062cf"],
  [URL, "M", 6, 6, "edae8798d87ad17e85bfcc5206279e1979cc40eacef98f01cf307bbeb549fd34"],
  [URL, "M", 7, 6, "3c02cce228d2cc5fbd84d862771280c39e175191147725f0b39b6d8450c5451b"],
  ["héllo ✓", "Q", 2, 1, "4df296cba205f5a1f8ff937e904fc251a66f74e8d6db1c88d1686f6e8d9d98c0"],
  ["x".repeat(300), "L", 5, 11, "58c406cc390a51a7bb3249c31340f0737f79ecade99707e2ff6aa0cc163f5c29"],
  ["0123456789".repeat(17), "H", 4, 13, "24121fe0633965c3e7179b76fd2695a5b8998ed2b8d0423e8fe1a16447090ba9"],
  ["q".repeat(1290), "M", 0, 30, "a006c04fc4c877188dd4bca78e091f4861cd1ed17e3adafe70e66ca5df40e508"],
  ["ab".repeat(500), "Q", 6, 31, "c5c8f73c601303365098bf4730f642df2cbcc259c31a151d8ddee7d5b958642a"],
  ["w".repeat(1500), "M", 2, 32, "7293388cb41b20949e0094e23aebbcd4996d822723fc3d75a292266296b9a737"],
  ["z".repeat(2300), "L", 1, 35, "ad1e4720c17f7c14e383da3cff0c798177bfad45de620662529c0739136e6de1"],
  ["z".repeat(2953), "L", 3, 40, "65f68d60beeabca19855140c53b6ebbfccbce2609b77a1925a0ddc3c84b0f11f"],
]

describe("qrCode", () => {
  test("HELLO, version 1-M, mask 0: module for module", () => {
    const qr = qrCode("HELLO", { ecc: "M", mask: 0 })
    expect(qr.version).toBe(1)
    expect(qr.size).toBe(21)
    expect(rows(qr.modules)).toBe(HELLO_M0)
  })

  for (const [text, ecc, mask, version, hash] of VECTORS) {
    test(`${text.length} chars, ${ecc}, mask ${mask}: version ${version}, matches the reference`, () => {
      const qr = qrCode(text, { ecc, mask })
      expect(qr.version).toBe(version)
      expect(qr.size).toBe(version * 4 + 17)
      expect(qr.mask).toBe(mask)
      expect(sha(qr.modules)).toBe(hash)
    })
  }

  test("picks a mask itself by default (the result is the code for that mask), error correction M", () => {
    const qr = qrCode(URL)
    expect(qr.mask).toBeGreaterThanOrEqual(0)
    expect(qr.mask).toBeLessThanOrEqual(7)
    expect(qr.version).toBe(6)
    expect(rows(qr.modules)).toBe(rows(qrCode(URL, { ecc: "M", mask: qr.mask }).modules))
  })

  test("refuses text too long for version 40", () => {
    expect(() => qrCode("z".repeat(2954), { ecc: "L" })).toThrow(/too long/i)
  })
})

describe("qrSvgPath", () => {
  test("one unit square per dark module, offset by the quiet zone", () => {
    const qr = qrCode("HELLO", { ecc: "M", mask: 0 })
    const path = qrSvgPath(qr, 4)
    const dark = HELLO_M0.split("").filter((c) => c === "1").length
    expect(path.match(/M/g)?.length).toBe(dark)
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true)
  })
})
