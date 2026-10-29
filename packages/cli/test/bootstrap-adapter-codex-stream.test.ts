// HBS-12: the Codex source streams (its package unpacks to ~0.5 GB). The pinned archive arrives in chunks and goes
// straight into the step's staging area; the sigstore evidence is checked over the staged file; every member of the
// package is streamed into its own staging file. No read or write ever carries more than one chunk, and the tree the
// executor gets names staged files, never bytes.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { harnessVersionRef, type InstallHarness } from "../src/bootstrap/contracts/index.ts"
import { createCodexHarnessSource, httpsDownloader } from "../src/bootstrap/adapters/codex/source.ts"
import { trustFromTrustedRoot } from "../src/bootstrap/adapters/codex/sigstore.ts"
import { nodeFs, type TxFs } from "../src/bootstrap/transaction/fs.ts"
import { CHUNK_BYTES, fsStaging } from "../src/bootstrap/transaction/stream.ts"
import { CODEX_VERSION, PACKAGE_ENTRIES, codexManifest, sigstoreWorld, tgz } from "./bootstrap/codex-fixtures.ts"

const MiB = 1024 * 1024
/** These tests build multi-MiB archives and keys; a loaded machine needs time. */
const SLOW = 60_000
const digest = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`
/** A 3 MiB binary: more than any single chunk. */
const BIG = (() => {
  const b = new Uint8Array(3 * MiB)
  for (let i = 0; i < b.byteLength; i++) b[i] = (i * 7 + (i >> 12)) & 0xff
  return b
})()
const ARCHIVE = tgz(PACKAGE_ENTRIES.map((e) => (e.name.endsWith("bin/codex") ? { ...e, text: undefined, bytes: BIG } : e)))
const URL = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-x86_64-unknown-linux-musl.tar.gz`
const ACTION: InstallHarness = {
  id: "install-codex",
  kind: "install-harness",
  escalation: "user",
  summary: "Install Codex",
  harness: "codex",
  version: CODEX_VERSION,
  target: "linux-x64",
  source: { manifest: codexManifest().release, url: URL, file: "codex-package-x86_64-unknown-linux-musl.tar.gz" },
  size: ARCHIVE.byteLength,
  sha256: digest(ARCHIVE),
  evidence: ["sigstore"],
  path: harnessVersionRef("codex", CODEX_VERSION),
  owner: "hub",
  rollback: "restore-previous",
}
const trust = (() => {
  const t = trustFromTrustedRoot(sigstoreWorld().trustedRoot)
  if (!t.ok) throw new Error(t.message)
  return t.value
})()

async function* chunked(bytes: Uint8Array, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.slice(at, at + size)
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function countingStaging() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hub-codex-stream-"))
  dirs.push(dir)
  const seen = { largestWrite: 0, largestRead: 0, wholeReads: 0 }
  const fs: TxFs = {
    ...nodeFs,
    readFile: (path) => (seen.wholeReads++, nodeFs.readFile(path)),
    readRange: (path, offset, length) => {
      const bytes = nodeFs.readRange(path, offset, length)
      seen.largestRead = Math.max(seen.largestRead, bytes.byteLength)
      return bytes
    },
    createExclusive: (path, mode) => {
      const inner = nodeFs.createExclusive(path, mode)
      return { ...inner, write: (chunk) => ((seen.largestWrite = Math.max(seen.largestWrite, chunk.byteLength)), inner.write(chunk)) }
    },
  }
  return { staging: fsStaging(fs, join(dir, "staging")), seen }
}

describe("the Codex source streams", () => {
  test("download, sigstore and unpack in chunks: the tree names staged files, never bytes", async () => {
    const { staging, seen } = countingStaging()
    const requests: string[] = []
    const download = {
      get: async (url: string) => {
        requests.push(url)
        if (url === URL) return { status: "ok" as const, bytes: chunked(ARCHIVE) }
        if (url === `${URL}.sigstore`) return { status: "ok" as const, bytes: sigstoreWorld().bundle(ARCHIVE) }
        return { status: "missing" as const }
      },
    }
    const source = createCodexHarnessSource({ manifest: codexManifest(), download, trust })
    const fetched = await source.fetch(ACTION, staging)
    expect(requests).toEqual([URL, `${URL}.sigstore`])
    expect(staging.written(fetched.file)).toEqual({ sha256: ACTION.sha256, size: ACTION.size })
    expect(fetched.evidence.map((e) => `${e.kind}:${e.status}`)).toEqual(["sigstore:verified"])

    const tree = await source.unpack(ACTION, fetched.file, staging)
    if (!tree.ok) throw new Error(tree.message)
    expect(tree.value.every((f) => "staged" in f)).toBe(true)
    const codex = tree.value.find((f) => f.rel === "bin/codex")!
    expect("staged" in codex && staging.written(codex.staged)).toEqual({ sha256: digest(BIG), size: BIG.byteLength })
    expect(tree.value.map((f) => f.rel)).toEqual(["bin/codex", "bin/codex-code-mode-host", "codex-package.json", "codex-path/rg", "codex-resources/bwrap", "codex-resources/voice/lib/libz.so.1"])
    expect(seen.largestWrite).toBeLessThanOrEqual(CHUNK_BYTES)
    expect(seen.largestRead).toBeLessThanOrEqual(CHUNK_BYTES)
    expect(seen.wholeReads).toBe(0)
    staging.dispose()
  }, SLOW)

  test("a substituted archive is staged as is (the executor rejects its digest) and not inspected further", async () => {
    const { staging } = countingStaging()
    const other = new TextEncoder().encode("a substituted archive")
    const requests: string[] = []
    const download = { get: async (url: string) => (requests.push(url), { status: "ok" as const, bytes: chunked(other, 4) }) }
    const fetched = await createCodexHarnessSource({ manifest: codexManifest(), download, trust }).fetch(ACTION, staging)
    expect(requests).toEqual([URL])
    expect(fetched.evidence).toEqual([])
    expect(staging.written(fetched.file)?.sha256).toBe(digest(other))
  }, SLOW)

  test("httpsDownloader hands over the body as a stream, bounded while it streams", async () => {
    const body = new Uint8Array(5)
    const response = () => Object.defineProperty(new Response(body as BodyInit), "url", { value: "https://objects.githubusercontent.com/x" }) as Response
    const ok = await httpsDownloader(async () => response()).get("https://github.com/x", { maxBytes: 5 })
    expect(ok.status).toBe("ok")
    expect(ok.status === "ok" && ok.bytes instanceof Uint8Array).toBe(false)
    const tooLong = await httpsDownloader(async () => response()).get("https://github.com/x", { maxBytes: 4 })
    const { staging } = countingStaging()
    await expect(tooLong.status === "ok" ? staging.write("x", tooLong.bytes, { maxBytes: 4 }) : Promise.reject(new Error("larger"))).rejects.toThrow(/larger|more than/)
  }, SLOW)
})
