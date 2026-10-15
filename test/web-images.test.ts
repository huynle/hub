// Image attachments in the composer (web/src/lib/images.ts): which files are accepted, how big they may get,
// and the downscale/re-encode loop that fits each image (and all of them together) into the hub's budget.
import { describe, expect, test } from "bun:test"
import {
  acceptsImage,
  attachProblem,
  base64Length,
  encodeWithinBudget,
  fitWithin,
  IMAGE_LIMITS,
  imageBudget,
  ImageTooLargeError,
  renamed,
  type EncodeRequest,
} from "../web/src/lib/images"

describe("limits", () => {
  test("stay inside the hub's limits with room for text in one frame", () => {
    expect(IMAGE_LIMITS.maxImages).toBe(4)
    expect(IMAGE_LIMITS.maxSide).toBe(1600)
    expect(IMAGE_LIMITS.perImageBase64).toBeLessThanOrEqual(180_000)
    expect(IMAGE_LIMITS.totalBase64).toBeLessThanOrEqual(700_000)
    // The hub refuses more than 512 KB decoded or 750,000 base64 characters in total.
    expect(IMAGE_LIMITS.perImageBase64 * 3 / 4).toBeLessThan(512 * 1024)
    expect(IMAGE_LIMITS.totalBase64).toBeLessThan(750_000)
  })

  test("base64Length is the padded encoded size", () => {
    expect(base64Length(0)).toBe(0)
    expect(base64Length(1)).toBe(4)
    expect(base64Length(3)).toBe(4)
    expect(base64Length(4)).toBe(8)
    expect(base64Length(Buffer.alloc(1000).length)).toBe(Buffer.alloc(1000).toString("base64").length)
  })
})

describe("accepting files", () => {
  test("PNG, JPEG, WebP and GIF only", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(acceptsImage(type)).toBe(true)
    for (const type of ["image/svg+xml", "image/heic", "application/pdf", ""]) expect(acceptsImage(type)).toBe(false)
  })

  test("attachProblem: at most four, supported types, with a readable reason", () => {
    expect(attachProblem(0, "image/png")).toBeUndefined()
    expect(attachProblem(3, "image/gif")).toBeUndefined()
    expect(attachProblem(4, "image/png")).toMatch(/4 images/)
    expect(attachProblem(0, "image/svg+xml")).toMatch(/PNG, JPEG, WebP or GIF/)
  })

  test("imageBudget is the smaller of the per-image cap and what is left of the total", () => {
    expect(imageBudget(0)).toBe(IMAGE_LIMITS.perImageBase64)
    expect(imageBudget(IMAGE_LIMITS.totalBase64 - 50_000)).toBe(50_000)
    expect(imageBudget(IMAGE_LIMITS.totalBase64)).toBe(0)
  })

  test("renamed: the extension follows the encoded type", () => {
    expect(renamed("holiday.PNG", "image/jpeg")).toBe("holiday.jpg")
    expect(renamed("anim.gif", "image/png")).toBe("anim.png")
    expect(renamed("noext", "image/jpeg")).toBe("noext.jpg")
    expect(renamed("", "image/jpeg")).toBe("image.jpg")
  })
})

describe("fitWithin", () => {
  test("scales the longest side down to the limit, keeping the aspect ratio; never up", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(1000, 5000, 1600)).toEqual({ width: 320, height: 1600 })
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(10_000, 1, 1600)).toEqual({ width: 1600, height: 1 })
  })
})

describe("encodeWithinBudget", () => {
  /** A fake encoder: bytes proportional to pixels, times a quality factor (PNG is the biggest). */
  const fake = (bytesPerPixel: number) => {
    const calls: EncodeRequest[] = []
    const encode = async (r: EncodeRequest) => {
      calls.push(r)
      const factor = r.type === "image/png" ? 1.5 : (r.quality ?? 1)
      return { size: Math.round(r.width * r.height * bytesPerPixel * factor) }
    }
    return { calls, encode }
  }

  test("a small photo encodes once as JPEG at the first quality", async () => {
    const { calls, encode } = fake(0.05)
    const out = await encodeWithinBudget({ width: 800, height: 600, keepPng: false }, 180_000, encode)
    expect(calls).toHaveLength(1)
    expect(out.request).toEqual({ type: "image/jpeg", quality: 0.85, width: 800, height: 600 })
  })

  test("large photos are scaled to 1600px first, then quality steps down until it fits", async () => {
    const { calls, encode } = fake(0.1)
    const out = await encodeWithinBudget({ width: 4000, height: 3000, keepPng: false }, 180_000, encode)
    expect(calls[0]).toMatchObject({ width: 1600, height: 1200, quality: 0.85 })
    expect(calls.map((c) => c.quality)).toEqual([0.85, 0.72, 0.6])
    expect(base64Length(out.blob.size)).toBeLessThanOrEqual(180_000)
  })

  test("when no quality fits, the image gets smaller", async () => {
    const { calls, encode } = fake(1)
    const out = await encodeWithinBudget({ width: 1600, height: 1200, keepPng: false }, 180_000, encode)
    expect(out.request.width).toBeLessThan(1600)
    expect(base64Length(out.blob.size)).toBeLessThanOrEqual(180_000)
    expect(calls.every((c) => c.type === "image/jpeg")).toBe(true)
  })

  test("transparent images stay PNG when that fits, else fall back to JPEG", async () => {
    const small = fake(0.05)
    expect((await encodeWithinBudget({ width: 400, height: 400, keepPng: true }, 180_000, small.encode)).request).toEqual({ type: "image/png", width: 400, height: 400 })
    const big = fake(0.5)
    const out = await encodeWithinBudget({ width: 1600, height: 1600, keepPng: true }, 180_000, big.encode)
    expect(big.calls[0]!.type).toBe("image/png")
    expect(out.request.type).toBe("image/jpeg")
  })

  test("gives up with ImageTooLargeError when nothing fits (or there is no budget left)", async () => {
    const { encode } = fake(1000)
    await expect(encodeWithinBudget({ width: 1600, height: 1600, keepPng: false }, 180_000, encode)).rejects.toBeInstanceOf(ImageTooLargeError)
    await expect(encodeWithinBudget({ width: 10, height: 10, keepPng: false }, 0, fake(0.01).encode)).rejects.toBeInstanceOf(ImageTooLargeError)
  })
})
