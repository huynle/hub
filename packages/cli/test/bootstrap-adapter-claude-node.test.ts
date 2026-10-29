// The default Node implementations of the Claude Code adapter's ports: a fixed-argv process runner (no shell, an
// explicit environment, bounded time and output), an https-only size-capped downloader, and a private scratch file.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"
import type { InstallHarness } from "../src/bootstrap/contracts/index.ts"
import { createClaudeHarnessSource } from "../src/bootstrap/adapters/claude/index.ts"
import { httpsDownloader, nodeRunner, tempScratch } from "../src/bootstrap/adapters/claude/node.ts"
import { DownloadTooLarge } from "../src/bootstrap/adapters/claude/ports.ts"
import { CLAUDE_BINARIES, claudePin, FakeDownloads, signedHubManifest } from "./bootstrap/claude-adapter-fixtures.ts"
import { memoryStaging } from "../src/bootstrap/transaction/stream.ts"

const STAGING = memoryStaging()
const stage = (bytes: Uint8Array) => STAGING.write("artifact", bytes, { maxBytes: 1 << 30 })

const BUN = process.execPath
/** Child processes start slowly on a loaded machine; these tests allow for it. */
const SLOW = 20_000
const run = (args: string[], env: Record<string, string> = {}, more: Partial<{ timeoutMs: number; maxOutputBytes: number }> = {}) =>
  nodeRunner().run(BUN, args, { env: { BUN_BE_BUN: "1", ...env }, timeoutMs: 10_000, maxOutputBytes: 1 << 16, ...more })

describe("nodeRunner", () => {
  test("runs the program with exactly these arguments (no shell) and reports exit code and stdout", async () => {
    const r = await run(["-e", "console.log(JSON.stringify(process.argv.slice(1))); process.exit(3)", "--", "a b", "$(echo x)", ";rm"])
    expect(r.kind).toBe("exited")
    if (r.kind !== "exited") return
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout.trim())).toContain("$(echo x)")
  }, SLOW)

  test("the child gets only the environment it is given", async () => {
    process.env.HBS08_LEAK = "should-not-leak"
    try {
      const r = await run(["-e", "console.log(JSON.stringify({leak: process.env.HBS08_LEAK ?? null, mine: process.env.MINE}))"], { MINE: "yes" })
      expect(r.kind === "exited" && JSON.parse(r.stdout)).toEqual({ leak: null, mine: "yes" })
    } finally {
      delete process.env.HBS08_LEAK
    }
  }, SLOW)

  test("a missing program is not-found; a hung one times out", async () => {
    expect((await nodeRunner().run("/nonexistent/claude", ["--version"], { env: {}, timeoutMs: 1000, maxOutputBytes: 100 })).kind).toBe("not-found")
    expect((await run(["-e", "setTimeout(() => {}, 10000)"], {}, { timeoutMs: 300 })).kind).toBe("timeout")
  }, SLOW)

  test("output beyond the cap is cut, never buffered without bound", async () => {
    const r = await run(["-e", "process.stdout.write('x'.repeat(100000))"], {}, { maxOutputBytes: 1000 })
    expect(r.kind === "exited" ? r.stdout.length : r.kind === "error" ? 0 : -1).toBeLessThanOrEqual(1000)
  }, SLOW)
})

describe("httpsDownloader", () => {
  const response = (body: string, init: { status?: number; url?: string } = {}) => {
    const r = new Response(body, { status: init.status ?? 200 })
    Object.defineProperty(r, "url", { value: init.url ?? "https://downloads.claude.ai/x" })
    return r
  }

  test("returns the body of an https URL", async () => {
    const d = httpsDownloader({ fetch: async () => response("hello") })
    expect(new TextDecoder().decode(await d.get("https://downloads.claude.ai/x", 10))).toBe("hello")
  })

  test("refuses plain http, and a redirect away from https", async () => {
    let called = 0
    const d = httpsDownloader({ fetch: async () => (called++, response("x", { url: "http://evil.example/x" })) })
    await expect(d.get("http://downloads.claude.ai/x", 10)).rejects.toThrow()
    expect(called).toBe(0)
    await expect(d.get("https://downloads.claude.ai/x", 10)).rejects.toThrow()
  })

  test("a body over the cap is DownloadTooLarge; an error status throws", async () => {
    await expect(httpsDownloader({ fetch: async () => response("x".repeat(11)) }).get("https://downloads.claude.ai/x", 10)).rejects.toBeInstanceOf(DownloadTooLarge)
    await expect(httpsDownloader({ fetch: async () => response("nope", { status: 404 }) }).get("https://downloads.claude.ai/x", 10)).rejects.toThrow()
  })
})

describe("tempScratch", () => {
  let seen = ""
  afterEach(() => {
    if (seen) expect(existsSync(seen)).toBe(false)
    seen = ""
  })

  test("a private copy of the bytes exists only while it is used", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const mode = await tempScratch().withFile(bytes, async (path) => {
      seen = path
      expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
      return [statSync(path).mode & 0o777, statSync(dirname(path)).mode & 0o777]
    })
    expect(mode).toEqual([0o600, 0o700])
  })

  test("is removed when the use throws", async () => {
    await expect(
      tempScratch().withFile(new Uint8Array([1]), async (path) => {
        seen = path
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })
})

describe("download failures in the source keep their meaning", () => {
  const manifest = signedHubManifest()
  const pin = claudePin("darwin-arm64")
  const action: InstallHarness = {
    id: "install-claude-code",
    kind: "install-harness",
    escalation: "user",
    summary: "Install Claude Code",
    harness: "claude-code",
    version: pin.version,
    target: pin.target,
    source: { manifest: manifest.release, url: pin.url, file: pin.file },
    size: pin.size,
    sha256: pin.sha256,
    evidence: [],
    path: { root: "data", rel: `hub/harnesses/claude-code/${pin.version}` },
    owner: "hub",
    rollback: "restore-previous",
  }
  const codeOf = async (body: Uint8Array | Error) => {
    const src = createClaudeHarnessSource({ manifest, download: new FakeDownloads().set(pin.url, body), platform: "darwin" })
    return src.fetch(action, STAGING).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "thrown",
    )
  }

  test("a file much larger than pinned is an integrity mismatch; an unreachable one is offline", async () => {
    expect(await codeOf(new Uint8Array(CLAUDE_BINARIES["darwin-arm64"].byteLength + 100))).toBe("integrity_mismatch")
    expect(await codeOf(new Error("ECONNREFUSED"))).toBe("offline")
  })
})
