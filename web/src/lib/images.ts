// Image attachments for typed prompts, without the DOM: which files are accepted, the size budget (each image
// and all of them together must fit in one hub→spoke frame with the text), and the downscale/re-encode loop.
// The browser part (decode, draw, toBlob) lives in app/attach.ts and plugs in through `encode`.

export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"]

export const IMAGE_LIMITS = {
  maxImages: 4,
  /** Longest side after downscaling, in pixels. */
  maxSide: 1600,
  /** Largest base64 length of one image (the hub accepts up to 512 KB decoded). */
  perImageBase64: 180_000,
  /** Largest base64 length of all images of a message (the hub accepts up to 750,000). */
  totalBase64: 700_000,
} as const

export type Limits = typeof IMAGE_LIMITS

/** JPEG qualities tried in order at each size. */
const QUALITIES = [0.85, 0.72, 0.6, 0.48, 0.36]
/** Sizes tried (fractions of the fitted size) when no quality fits. */
const SCALES = [1, 0.75, 0.55, 0.4, 0.28, 0.2]

export class ImageTooLargeError extends Error {
  constructor(message = "This image is too large to attach, even after shrinking it") {
    super(message)
    this.name = "ImageTooLargeError"
  }
}

/** Length of the base64 encoding of `bytes` bytes (with padding). */
export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3)

export const acceptsImage = (type: string): boolean => IMAGE_TYPES.includes(type)

/** Why another file of `type` cannot be attached to a message that has `count` images, or undefined. */
export function attachProblem(count: number, type: string, limits: Limits = IMAGE_LIMITS): string | undefined {
  if (count >= limits.maxImages) return `Attach at most ${limits.maxImages} images to a message`
  if (!acceptsImage(type)) return "Only PNG, JPEG, WebP or GIF images can be attached"
  return undefined
}

/** Base64 characters the next image may use, given what the attached ones already use. */
export function imageBudget(usedBase64: number, limits: Limits = IMAGE_LIMITS): number {
  return Math.max(0, Math.min(limits.perImageBase64, limits.totalBase64 - usedBase64))
}

/** `width`×`height` scaled so the longest side is at most `maxSide` (never enlarged; at least 1px). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** `name` with the extension of `mime` (".jpg" or ".png"). */
export function renamed(name: string, mime: string): string {
  const ext = mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "jpg"
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "image"
  return `${base}.${ext}`
}

export interface EncodeRequest {
  readonly type: "image/png" | "image/jpeg"
  readonly quality?: number
  readonly width: number
  readonly height: number
}

/**
 * Encodes the image at most `budget` base64 characters big. Images are always re-encoded (which also drops
 * camera metadata such as location). Transparent images (`keepPng`) try PNG first at each size; otherwise
 * JPEG steps its quality down, and when no quality fits the image is made smaller.
 */
export async function encodeWithinBudget<T extends { readonly size: number }>(
  source: { readonly width: number; readonly height: number; readonly keepPng: boolean },
  budget: number,
  encode: (request: EncodeRequest) => Promise<T>,
  limits: Limits = IMAGE_LIMITS,
): Promise<{ blob: T; request: EncodeRequest }> {
  if (budget <= 0) throw new ImageTooLargeError("No room for another image in this message")
  const fitted = fitWithin(source.width, source.height, limits.maxSide)
  for (const scale of SCALES) {
    const width = Math.max(1, Math.round(fitted.width * scale))
    const height = Math.max(1, Math.round(fitted.height * scale))
    const tries: EncodeRequest[] = [
      ...(source.keepPng ? [{ type: "image/png" as const, width, height }] : []),
      ...QUALITIES.map((quality) => ({ type: "image/jpeg" as const, quality, width, height })),
    ]
    for (const request of tries) {
      const blob = await encode(request)
      if (base64Length(blob.size) <= budget) return { blob, request }
    }
  }
  throw new ImageTooLargeError()
}
