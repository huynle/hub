// Conversation mode assets are served by the hub's static route as JavaScript, same origin, no CDN.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { harness, type Harness } from "./central-harness"

const WEB = path.join(import.meta.dir, "..", "web")
let h: Harness
afterEach(async () => {
  await h?.stop()
})

describe("conversation mode assets", () => {
  test("app.js is an ES module and its modules and the VAD worklet are served as JavaScript", async () => {
    h = harness({ webDir: WEB })
    const html = await (await fetch(`${h.url}/s/ses_1`)).text()
    expect(html).toContain('<script type="module" src="/app.js">')
    for (const file of ["/app.js", "/conversation.js", "/conversation-core.js", "/feedback-core.js", "/browser-core.js", "/picker-core.js", "/cues.js", "/vad-worklet.js"]) {
      const res = await fetch(`${h.url}${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    }
  })

  test("module imports are relative same-origin files that exist", () => {
    for (const file of ["app.js", "conversation.js"]) {
      const source = readFileSync(path.join(WEB, file), "utf8")
      const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!)
      expect(imports.length).toBeGreaterThan(0)
      for (const spec of imports) {
        expect(spec).toMatch(/^\.\/[a-z-]+\.js$/)
        expect(() => readFileSync(path.join(WEB, spec))).not.toThrow()
      }
    }
    const app = readFileSync(path.join(WEB, "conversation.js"), "utf8")
    expect(app).toContain('addModule("/vad-worklet.js")')
    expect(readFileSync(path.join(WEB, "vad-worklet.js"), "utf8")).toContain('registerProcessor("vad-tap"')
  })

  test("browser modules parse", async () => {
    // conversation.js and app.js touch DOM globals only when called, so importing the module graph is enough.
    const core = await import("../web/conversation-core.js")
    expect(typeof core.EnergyVad).toBe("function")
    expect(() => new Function(readFileSync(path.join(WEB, "vad-worklet.js"), "utf8"))).not.toThrow()
  })
})
