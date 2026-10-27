#!/usr/bin/env bun
// Generates Hub's icons from one mark: a central node (the hub, in the console's accent) joined by three
// spokes to satellite nodes (the harnesses and devices that connect to it), on the console's dark
// background. Writes web/public/icon.svg and renders the PNGs (and favicon.ico) with headless Chromium
// (the e2e setup's, see web/e2e/chromium.ts):
//
//   bun scripts/gen-icons.ts                  # writes web/public/{icon.svg,icon-192.png,icon-512.png,
//                                             #   icon-maskable-512.png,apple-touch-icon.png,favicon.ico}
//   bun scripts/gen-icons.ts --preview DIR    # also a preview sheet (all sizes, light and dark) in DIR
//
// The sidebar and sign-in page draw the same mark inline (web/src/app/HubMark.tsx); keep them in step.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { chromium, type Page } from "playwright-core"
import { chromiumPath } from "../web/e2e/chromium"

export const BG = "#101214"
export const LIGHT = "#e7e5e0"
export const ACCENT = "#3ad3bf"

const ROOT = path.join(import.meta.dir, "..")
const OUT = path.join(ROOT, "web", "public")

interface Variant {
  /** Rounded tile ("any" icons), full-bleed square (maskable, Apple touch, which round themselves), or none. */
  readonly tile: "rounded" | "square" | "none"
  /** Mark size relative to the 512 canvas (1 = the standard padding; maskable keeps inside the 80% safe zone). */
  readonly scale: number
  /** Heavier spokes and nodes for the smallest sizes. */
  readonly bold?: boolean
}

/** Satellite angles in degrees (0 = up, clockwise): one up, two below, like a three-legged hub. */
const ANGLES = [0, 120, 240]

/** The mark on a 512×512 canvas, centered on (256, 256). */
export function markSVG(variant: Variant): string {
  const c = 256
  const reach = 166 * variant.scale // center to satellite center
  const hub = (variant.bold ? 70 : 60) * variant.scale
  const node = (variant.bold ? 48 : 40) * variant.scale
  const spoke = (variant.bold ? 34 : 22) * variant.scale
  const points = ANGLES.map((deg) => {
    const rad = (deg * Math.PI) / 180
    return { x: +(c + reach * Math.sin(rad)).toFixed(1), y: +(c - reach * Math.cos(rad)).toFixed(1) }
  })
  // The whole mark sits a little above center optically (two satellites below, one above): shift it down.
  const dy = +((reach * (1 - Math.cos(Math.PI / 3))) / 4).toFixed(1)
  const tile =
    variant.tile === "rounded"
      ? `  <rect width="512" height="512" rx="112" fill="${BG}"/>\n`
      : variant.tile === "square"
        ? `  <rect width="512" height="512" fill="${BG}"/>\n`
        : ""
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    `  <title>Hub</title>`,
    tile.trimEnd(),
    `  <g transform="translate(0 ${dy})">`,
    `    <g stroke="${LIGHT}" stroke-width="${+spoke.toFixed(1)}" stroke-linecap="round">`,
    ...points.map((p) => `      <line x1="${c}" y1="${c}" x2="${p.x}" y2="${p.y}"/>`),
    `    </g>`,
    `    <g fill="${LIGHT}">`,
    ...points.map((p) => `      <circle cx="${p.x}" cy="${p.y}" r="${+node.toFixed(1)}"/>`),
    `    </g>`,
    `    <circle cx="${c}" cy="${c}" r="${+(hub + spoke / 2).toFixed(1)}" fill="${BG}"/>`,
    `    <circle cx="${c}" cy="${c}" r="${+hub.toFixed(1)}" fill="${ACCENT}"/>`,
    `  </g>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n")
    .concat("\n")
}

const STANDARD: Variant = { tile: "rounded", scale: 1 }
const SMALL: Variant = { tile: "rounded", scale: 1.08, bold: true }

const PNGS: ReadonlyArray<{ file: string; size: number; variant: Variant }> = [
  { file: "icon-192.png", size: 192, variant: STANDARD },
  { file: "icon-512.png", size: 512, variant: STANDARD },
  // Maskable: full bleed, mark within the central 80% circle (radius 204.8 of 512).
  { file: "icon-maskable-512.png", size: 512, variant: { tile: "square", scale: 0.78 } },
  // iOS masks the corners itself.
  { file: "apple-touch-icon.png", size: 180, variant: { tile: "square", scale: 0.9 } },
]
const FAVICON_SIZES = [16, 32, 48]

async function render(page: Page, svg: string, size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`,
  )
  await page.waitForFunction(() => document.images[0]?.complete)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

/** An .ico holding PNG images (valid since Windows Vista; every current browser reads it). */
export function icoFromPngs(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, at) // width (0 = 256)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1) // height
    header.writeUInt8(0, at + 2) // palette colors
    header.writeUInt8(0, at + 3) // reserved
    header.writeUInt16LE(1, at + 4) // color planes
    header.writeUInt16LE(32, at + 6) // bits per pixel
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((image) => image.png)])
}

async function main(argv: readonly string[]): Promise<void> {
  const previewAt = argv.indexOf("--preview")
  const previewDir = previewAt >= 0 ? argv[previewAt + 1] : undefined
  if (previewAt >= 0 && !previewDir) throw new Error("--preview needs a directory")

  writeFileSync(path.join(OUT, "icon.svg"), markSVG(STANDARD))
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    for (const { file, size, variant } of PNGS) {
      writeFileSync(path.join(OUT, file), await render(page, markSVG(variant), size))
      console.log(`wrote web/public/${file} (${size}×${size})`)
    }
    const favicons = []
    for (const size of FAVICON_SIZES) favicons.push({ size, png: await render(page, markSVG(size <= 32 ? SMALL : STANDARD), size) })
    writeFileSync(path.join(OUT, "favicon.ico"), icoFromPngs(favicons))
    console.log(`wrote web/public/favicon.ico (${FAVICON_SIZES.join(", ")} px)`)
    console.log("wrote web/public/icon.svg")

    if (previewDir) {
      mkdirSync(previewDir, { recursive: true })
      for (const { size, png } of favicons) writeFileSync(path.join(previewDir, `favicon-${size}.png`), png)
      const img = (svg: string, size: number) =>
        `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}">`
      const row = (bg: string) =>
        `<div style="display:flex;gap:24px;align-items:end;padding:24px;background:${bg}">` +
        [16, 24, 32, 48].map((s) => img(markSVG(s <= 32 ? SMALL : STANDARD), s)).join("") +
        img(markSVG(STANDARD), 96) +
        img(markSVG({ tile: "square", scale: 0.78 }), 96).replace("<img", '<img style="border-radius:50%"') +
        img(markSVG(STANDARD), 192) +
        `<span style="display:flex;align-items:center;gap:8px;font:17px Georgia,serif;color:${LIGHT};background:${BG};padding:8px 12px;border-radius:8px">` +
        img(markSVG({ tile: "none", scale: 1.25 }), 20) +
        `Hub</span></div>`
      await page.setViewportSize({ width: 860, height: 520 })
      await page.setContent(`<!doctype html><body style="margin:0">${row("#ffffff")}${row("#2a2a28")}${row(BG)}</body>`)
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete))
      const file = path.join(previewDir, "hub-icons-preview.png")
      await page.screenshot({ path: file, fullPage: true })
      console.log(`preview: ${file}`)
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) await main(process.argv.slice(2))
