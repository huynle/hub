// Browser side of image attachments: decode a picked/pasted/dropped file, then draw and re-encode it on a canvas
// within budget. The sizing and quality decisions live in lib/images.ts (unit-tested); this file only touches
// the DOM. GIFs become their first frame.
import type { ComposerImage } from "../lib/composer"
import { attachProblem, encodeWithinBudget, imageBudget, renamed, type EncodeRequest } from "../lib/images"

let seq = 0

/** Base64 characters the composer's images use now. */
export const usedBase64 = (images: readonly ComposerImage[]) => images.reduce((sum, image) => sum + image.data.length, 0)

/** Decodes and re-encodes `file` to fit what is left of the message's image budget. Throws with a readable message. */
export async function prepareImage(file: File, attached: readonly ComposerImage[]): Promise<ComposerImage> {
  const problem = attachProblem(attached.length, file.type)
  if (problem) throw new Error(problem)
  const source = await decode(file)
  try {
    const keepPng = file.type !== "image/jpeg" && hasAlpha(source)
    const { blob, request } = await encodeWithinBudget({ width: source.width, height: source.height, keepPng }, imageBudget(usedBase64(attached)), (r) => draw(source, r))
    const url = await dataURL(blob)
    return {
      id: `img${++seq}`,
      mime: request.type,
      data: url.slice(url.indexOf(",") + 1),
      name: renamed(file.name || "image", request.type),
      // A short blob: URL keeps the transcript's block snapshots small (a data: URL would be copied around).
      preview: URL.createObjectURL(blob),
    }
  } finally {
    if ("close" in source) source.close()
  }
}

type Source = ImageBitmap | HTMLImageElement

async function decode(file: File): Promise<Source> {
  try {
    return await createImageBitmap(file)
  } catch {
    // Older Safari: decode through an <img>.
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    } catch {
      throw new Error(`Could not read ${file.name || "this image"}`)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas")
  c.width = width
  c.height = height
  const ctx = c.getContext("2d")
  if (!ctx) throw new Error("This browser cannot process images")
  return [c, ctx]
}

/** Whether any pixel is transparent (checked on a small copy). */
function hasAlpha(source: Source): boolean {
  const w = Math.max(1, Math.min(64, source.width))
  const h = Math.max(1, Math.min(64, source.height))
  const [, ctx] = canvas(w, h)
  ctx.drawImage(source, 0, 0, w, h)
  const pixels = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) return true
  return false
}

function draw(source: Source, request: EncodeRequest): Promise<Blob> {
  const [c, ctx] = canvas(request.width, request.height)
  if (request.type === "image/jpeg") {
    // JPEG has no transparency: put transparent areas on white rather than black.
    ctx.fillStyle = "#fff"
    ctx.fillRect(0, 0, request.width, request.height)
  }
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(source, 0, 0, request.width, request.height)
  return new Promise((resolve, reject) => c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))), request.type, request.quality))
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read the encoded image"))
    reader.readAsDataURL(blob)
  })
}

/** Image files among clipboard or drop data. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = [...data.files].filter((f) => f.type.startsWith("image/"))
  if (files.length) return files
  return [...data.items].flatMap((item) => (item.kind === "file" && item.type.startsWith("image/") ? [item.getAsFile()].filter((f): f is File => !!f) : []))
}
