// The built console (web/dist, `npm run build:web`) served by the hub: app routes, manifest, icons, service
// worker, hashed same-origin assets. scripts/test-ci.sh builds it before the tests.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { gunzipSync, brotliDecompressSync } from "node:zlib"
import path from "node:path"
import { harness, type Harness } from "./central-harness"

const WEB = path.join(import.meta.dir, "..", "web", "dist")
if (!existsSync(path.join(WEB, "index.html"))) throw new Error("web/dist is missing: run `npm run build:web` (scripts/test-ci.sh does)")

let h: Harness
afterEach(async () => {
  await h?.stop()
})

describe("console assets", () => {
  test("app routes serve the shell; it links the manifest and same-origin hashed module and styles", async () => {
    h = await harness({ webDir: WEB })
    for (const route of ["/", "/pair", "/approve", "/new", "/settings", "/s/ses_1"]) {
      const res = await fetch(`${h.url}${route}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(res.headers.get("cache-control")).toBe("no-cache")
    }
    const html = await (await fetch(`${h.url}/`)).text()
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/) // no external CDNs
    const script = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    const style = /<link rel="stylesheet"[^>]* href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1]
    expect(script).toBeDefined()
    expect(style).toBeDefined()
    const js = await fetch(`${h.url}${script}`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect((await fetch(`${h.url}${style}`)).headers.get("content-type")).toBe("text/css; charset=utf-8")
  })

  test("manifest is valid and every icon is served as a PNG/SVG", async () => {
    h = await harness({ webDir: WEB })
    const res = await fetch(`${h.url}/manifest.webmanifest`)
    expect(res.headers.get("content-type")).toBe("application/manifest+json")
    const manifest = (await res.json()) as any
    expect(manifest).toMatchObject({ start_url: "/", scope: "/", display: "standalone" })
    expect(typeof manifest.name).toBe("string")
    expect(manifest.icons.some((i: any) => i.purpose === "maskable")).toBe(true)
    for (const icon of manifest.icons) {
      const file = await fetch(`${h.url}${icon.src}`)
      expect(file.status).toBe(200)
      expect(file.headers.get("content-type")).toBe(icon.type)
    }
  })

  test("service worker handles push and notificationclick and never caches", async () => {
    h = await harness({ webDir: WEB })
    const res = await fetch(`${h.url}/sw.js`)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("service-worker-allowed")).toBe("/")
    const sw = await res.text()
    expect(sw).toContain('addEventListener("push"')
    expect(sw).toContain('addEventListener("notificationclick"')
    expect(sw).not.toMatch(/caches\.(open|match|keys)\(/)
  })

  test("the Voice mode VAD worklet is served as JavaScript and registers its processor", async () => {
    h = await harness({ webDir: WEB })
    const res = await fetch(`${h.url}/vad-worklet.js`)
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    const source = await res.text()
    expect(source).toContain('registerProcessor("vad-tap"')
    expect(() => new Function(source)).not.toThrow()
  })

  test("Silero VAD assets: the worker, onnxruntime's wasm and the model, hashed, typed, cached for good, outside the main chunk", async () => {
    h = await harness({ webDir: WEB })
    const assets = readdirSync(path.join(WEB, "assets"))
    const worker = assets.find((f) => /^silero-worker-.+\.js$/.test(f))
    const wasm = assets.find((f) => f.endsWith(".wasm"))
    const model = assets.find((f) => /^silero_vad-.+\.onnx$/.test(f))
    expect([worker, wasm, model].every(Boolean)).toBe(true)
    const workerSource = readFileSync(path.join(WEB, "assets", worker!), "utf8")
    expect(workerSource).toContain(wasm!)
    expect(workerSource).toContain(model!)
    // The main chunk only knows the worker's URL; onnxruntime stays out of it.
    const html = await (await fetch(`${h.url}/`)).text()
    const main = /<script type="module"[^>]* src="\/assets\/([^"]+\.js)"/.exec(html)![1]!
    const mainSource = readFileSync(path.join(WEB, "assets", main), "utf8")
    expect(mainSource).toContain(worker!)
    expect(mainSource).not.toContain("InferenceSession")
    for (const [file, type] of [
      [worker!, "text/javascript; charset=utf-8"],
      [wasm!, "application/wasm"],
      [model!, "application/octet-stream"],
    ] as const) {
      const res = await fetch(`${h.url}/assets/${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe(type)
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(readFileSync(path.join(WEB, "assets", file))))
    }
    // Files outside assets/ are not hashed: no long-lived caching.
    expect((await fetch(`${h.url}/vad-worklet.js`)).headers.get("cache-control")).toBeNull()
  })

  test("big compressible assets (the 12 MB wasm) are sent compressed when the browser accepts it", async () => {
    h = await harness({ webDir: WEB })
    const wasm = readdirSync(path.join(WEB, "assets")).find((f) => f.endsWith(".wasm"))!
    const bytes = new Uint8Array(readFileSync(path.join(WEB, "assets", wasm)))
    const get = (encoding: string) => fetch(`${h.url}/assets/${wasm}`, { headers: { "accept-encoding": encoding }, decompress: false } as RequestInit)
    const br = await get("gzip, deflate, br")
    expect(br.headers.get("content-encoding")).toBe("br")
    expect(br.headers.get("vary")).toBe("Accept-Encoding")
    const brBody = new Uint8Array(await br.arrayBuffer())
    expect(brBody.length).toBeLessThan(bytes.length / 3)
    expect(new Uint8Array(brotliDecompressSync(brBody))).toEqual(bytes)
    const gz = await get("gzip")
    expect(gz.headers.get("content-encoding")).toBe("gzip")
    expect(new Uint8Array(gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toEqual(bytes)
    const plain = await get("identity")
    expect(plain.headers.get("content-encoding")).toBeNull()
    expect(new Uint8Array(await plain.arrayBuffer()).length).toBe(bytes.length)
  }, 60_000)

  test("without a build the shell explains how to build it", async () => {
    h = await harness({ webDir: path.join(WEB, "missing") })
    const res = await fetch(`${h.url}/`)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).toContain("npm install && npm run build:web")
    expect(text).toContain("@huynle/hub")
    expect(text).toContain("release binary")
  })
})
