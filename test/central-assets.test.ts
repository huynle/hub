// web/ assets behind one abstraction: read from disk (dev, npm, Docker) or from files embedded in a
// compiled binary. Both refuse traversal and unknown names; the hub serves either the same way.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { diskAssets, embeddedAssets, webAssetModule, webFiles } from "../src/central/assets"
import { harness, type Harness } from "./central-harness"

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined)

function webFolder() {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-assets-"))
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>disk</title>")
  writeFileSync(path.join(dir, "app.js"), "console.log('disk')")
  mkdirSync(path.join(dir, "sub"))
  writeFileSync(path.join(dir, "sub", "x.js"), "nested")
  writeFileSync(path.join(path.dirname(dir), "secret.txt"), "nope")
  return dir
}

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

describe("diskAssets", () => {
  test("reads files under the folder; nothing outside it, no folders, nothing missing", () => {
    const web = diskAssets(webFolder())
    expect(text(web.read("app.js"))).toBe("console.log('disk')")
    expect(text(web.read("sub/x.js"))).toBe("nested")
    for (const name of ["../secret.txt", "sub", "missing.js", "/etc/passwd", ""]) expect(web.read(name)).toBeUndefined()
  })
})

describe("embeddedAssets", () => {
  test("reads the files of a name → path map (as `with { type: \"file\" }` imports give them)", () => {
    const dir = webFolder()
    const web = embeddedAssets({ "index.html": path.join(dir, "index.html"), "app.js": path.join(dir, "app.js") })
    expect(text(web.read("app.js"))).toBe("console.log('disk')")
    expect(web.read("sub/x.js")).toBeUndefined()
    expect(web.read("../secret.txt")).toBeUndefined()
    expect(web.read("toString")).toBeUndefined()
  })

  test("the hub serves embedded assets like disk ones (app routes → index.html, sw.js headers)", async () => {
    const dir = webFolder()
    writeFileSync(path.join(dir, "sw.js"), "self.x = 1")
    h = await harness({ web: embeddedAssets({ "index.html": path.join(dir, "index.html"), "app.js": path.join(dir, "app.js"), "sw.js": path.join(dir, "sw.js") }) })
    const page = await h.api("/s/ses_1", { cookie: null })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("disk")
    const sw = await h.api("/sw.js", { cookie: null })
    expect(sw.headers.get("service-worker-allowed")).toBe("/")
    expect((await h.api("/sub/x.js", { cookie: null })).status).toBe(404)
  })
})

describe("webAssetModule", () => {
  test("generates a module importing each file as an embedded file, keyed by its web/ name", () => {
    const source = webAssetModule(["app.js", "icon-192.png", "index.html"], "../web")
    expect(source).toContain('import f0 from "../web/app.js" with { type: "file" }')
    expect(source).toContain('import f1 from "../web/icon-192.png" with { type: "file" }')
    expect(source).toContain('"index.html": f2')
    expect(source).toContain("export default")
  })

  test("skips type declarations, source maps and hidden files, nested ones too", () => {
    const source = webAssetModule(["app.js", "browser-core.d.ts", ".DS_Store", "assets/.DS_Store", "assets/index-x.js.map", "assets/index-x.js"], "../web/dist")
    expect(source).not.toContain("browser-core.d.ts")
    expect(source).not.toContain(".DS_Store")
    expect(source).not.toContain(".map")
    expect(source).toContain('"assets/index-x.js": f1')
  })
})

describe("webFiles", () => {
  test("lists every file of the build, nested ones as relative / paths, sorted", () => {
    expect(webFiles(webFolder())).toEqual(["app.js", "index.html", "sub/x.js"])
  })

  test("the hub serves a nested embedded asset (Vite's assets/ folder)", async () => {
    const dir = webFolder()
    h = await harness({ web: embeddedAssets({ "index.html": path.join(dir, "index.html"), "sub/x.js": path.join(dir, "sub", "x.js") }) })
    const res = await h.api("/sub/x.js", { cookie: null })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("nested")
  })
})
