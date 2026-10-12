// The real PWA in web/ served by the hub: app routes, manifest, icons, service worker.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { harness, type Harness } from "./central-harness"

const WEB = path.join(import.meta.dir, "..", "web")
let h: Harness
afterEach(async () => {
  await h?.stop()
})

describe("PWA assets", () => {
  test("app routes serve the shell; it links the manifest, styles and script", async () => {
    h = harness({ webDir: WEB })
    for (const route of ["/", "/pair", "/approve", "/s/ses_1"]) {
      const res = await fetch(`${h.url}${route}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
    }
    const html = await (await fetch(`${h.url}/`)).text()
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('src="/app.js"')
    expect(html).toContain('href="/app.css"')
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/) // no external CDNs
  })

  test("manifest is valid and every icon is served as a PNG/SVG", async () => {
    h = harness({ webDir: WEB })
    const res = await fetch(`${h.url}/manifest.webmanifest`)
    expect(res.headers.get("content-type")).toBe("application/manifest+json")
    const manifest = (await res.json()) as any
    expect(manifest).toMatchObject({
      name: "OpenCode Voice",
      short_name: "Voice",
      start_url: "/",
      scope: "/",
      display: "standalone",
    })
    expect(manifest.icons.some((i: any) => i.purpose === "maskable")).toBe(true)
    for (const icon of manifest.icons) {
      const file = await fetch(`${h.url}${icon.src}`)
      expect(file.status).toBe(200)
      expect(file.headers.get("content-type")).toBe(icon.type)
    }
  })

  test("service worker handles push and notificationclick and never caches", async () => {
    h = harness({ webDir: WEB })
    const res = await fetch(`${h.url}/sw.js`)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("service-worker-allowed")).toBe("/")
    const sw = await res.text()
    expect(sw).toContain('addEventListener("push"')
    expect(sw).toContain('addEventListener("notificationclick"')
    expect(sw).not.toMatch(/caches\.(open|match|keys)\(/)
  })
})
