// Hub's icons: web/public is what scripts/gen-icons.ts generates, the inline mark (web/src/app/HubMark.tsx)
// has the same geometry, and the manifest, page and service worker reference files that exist.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ACCENT, BG, icoFromPngs, LIGHT, markSVG } from "../scripts/gen-icons"

const root = path.join(import.meta.dir, "..")
const pub = (file: string) => path.join(root, "web", "public", file)
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
/** The line and circle elements, attributes only, in order. */
const shapes = (svg: string) => [...svg.matchAll(/<(line|circle)\b([^>]*?)\/?>/g)].map((m) => `${m[1]} ${m[2]!.replace(/\s*(class|fill)="[^"]*"/g, "").trim()}`)

describe("icons", () => {
  test("web/public/icon.svg is the generator's output (run bun scripts/gen-icons.ts after changing it)", () => {
    expect(readFileSync(pub("icon.svg"), "utf8")).toBe(markSVG({ tile: "rounded", scale: 1 }))
  })

  test("uses the console dark palette and teal brand hub", () => {
    const css = read("web/src/styles.css")
    expect(css).toContain(`--bg: ${BG};`)
    expect(css).toContain(`--text: ${LIGHT};`)
    expect(css).toContain(`--accent: ${ACCENT};`)
    expect(ACCENT).toBe("#3ad3bf")
    const svg = markSVG({ tile: "rounded", scale: 1 })
    for (const color of [BG, LIGHT, ACCENT]) expect(svg).toContain(color)
  })

  test("the inline mark has the same geometry as the icon", () => {
    const inline = shapes(read("web/src/app/HubMark.tsx")).map((s) => s.replace(/\s+/g, " "))
    expect(inline).toEqual(shapes(markSVG({ tile: "none", scale: 1 })))
  })

  test("the maskable mark stays inside the 80% safe zone", () => {
    const svg = markSVG({ tile: "square", scale: 0.78 })
    const dy = Number(/translate\(0 ([\d.]+)\)/.exec(svg)![1])
    for (const m of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
      const [x, y, r] = [Number(m[1]), Number(m[2]) + dy, Number(m[3])]
      expect(Math.hypot(x - 256, y - 256) + r).toBeLessThanOrEqual(0.4 * 512)
    }
  })

  test("every referenced icon exists", () => {
    const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"))
    expect(manifest.name).toBe("Hub")
    expect(manifest.short_name).toBe("Hub")
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose)
    expect(purposes).toContain("maskable")
    const html = read("web/index.html")
    const sw = readFileSync(pub("sw.js"), "utf8")
    const refs = [
      ...manifest.icons.map((i: { src: string }) => i.src),
      ...[...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]),
      ...[...sw.matchAll(/(?:icon|badge): "([^"]+)"/g)].map((m) => m[1]),
    ]
    expect(refs).toContain("/favicon.ico")
    expect(refs).toContain("/apple-touch-icon.png")
    for (const ref of refs) expect(existsSync(pub(ref.slice(1)))).toBe(true)
  })

  test("PNG sizes match their names", () => {
    const size = (file: string) => {
      const png = readFileSync(pub(file))
      return [png.readUInt32BE(16), png.readUInt32BE(20)]
    }
    expect(size("icon-192.png")).toEqual([192, 192])
    expect(size("icon-512.png")).toEqual([512, 512])
    expect(size("icon-maskable-512.png")).toEqual([512, 512])
    expect(size("apple-touch-icon.png")).toEqual([180, 180])
  })

  test("favicon.ico is an icon directory of PNGs (16, 32, 48)", () => {
    const ico = readFileSync(pub("favicon.ico"))
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    expect([0, 1, 2].map((i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 32, 48])
    const first = ico.readUInt32LE(6 + 12)
    expect(ico.subarray(first, first + 4).toString("latin1")).toBe("\x89PNG")
  })

  test("icoFromPngs lays out the directory and data", () => {
    const a = Buffer.from("AAAA")
    const b = Buffer.from("BBBBBB")
    const ico = icoFromPngs([{ size: 16, png: a }, { size: 256, png: b }])
    expect(ico.length).toBe(6 + 32 + 10)
    expect(ico.readUInt8(6 + 16)).toBe(0) // 256 is written as 0
    expect(ico.readUInt32LE(6 + 8)).toBe(4)
    expect(ico.readUInt32LE(6 + 12)).toBe(38)
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(42)
    expect(ico.subarray(38).toString()).toBe("AAAABBBBBB")
  })
})
