// HBS-12: the Claude Code source streams its ~200 MB binary. The download goes straight into the step's staging
// area in chunks; the GPG-signed manifest is checked against the staged digest; codesign gets a scratch copy written
// in chunks; and the install tree names the staged download itself (no second copy, never bytes). No read or write
// carries more than one chunk.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InstallHarness } from "../src/bootstrap/contracts/index.ts"
import { tempScratch } from "../src/bootstrap/adapters/claude/node.ts"
import type { Downloader, Scratch } from "../src/bootstrap/adapters/claude/ports.ts"
import { createClaudeHarnessSource } from "../src/bootstrap/adapters/claude/source.ts"
import { nodeFs, type TxFs } from "../src/bootstrap/transaction/fs.ts"
import { CHUNK_BYTES, fsStaging, type ByteSource } from "../src/bootstrap/transaction/stream.ts"
import { binaryURL, CLAUDE_BINARIES, CLAUDE_VERSION, claudePin, FakeRunner, signedHubManifest, upstreamRelease } from "./bootstrap/claude-adapter-fixtures.ts"

const MiB = 1024 * 1024
/** These tests build multi-MiB archives and keys; a loaded machine needs time. */
const SLOW = 60_000
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
/** A 3 MiB Mach-O: more than any single chunk. */
const BIG = (() => {
  const b = new Uint8Array(3 * MiB)
  for (let i = 0; i < b.byteLength; i++) b[i] = (i * 13 + (i >> 10)) & 0xff
  b.set(CLAUDE_BINARIES["darwin-arm64"].subarray(0, 4))
  return b
})()
const PIN = claudePin("darwin-arm64", CLAUDE_VERSION, BIG)
const MANIFEST = signedHubManifest([PIN])
const ACTION: InstallHarness = {
  id: "install-claude-code",
  kind: "install-harness",
  escalation: "user",
  summary: "Install Claude Code",
  harness: "claude-code",
  version: PIN.version,
  target: PIN.target,
  source: { manifest: MANIFEST.release, url: PIN.url, file: PIN.file },
  size: PIN.size,
  sha256: PIN.sha256,
  evidence: [...PIN.evidence],
  path: { root: "data", rel: `hub/harnesses/claude-code/${PIN.version}` },
  owner: "hub",
  rollback: "restore-previous",
}

async function* chunked(bytes: Uint8Array, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += size) yield bytes.slice(at, at + size)
}

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function countingStaging() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hub-claude-stream-"))
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

/** A scratch that only ever sees the content as chunks, and records them. */
class ChunkScratch implements Scratch {
  largest = 0
  digests: string[] = []
  async withFile<T>(content: ByteSource, use: (path: string) => Promise<T>): Promise<T> {
    const hash = createHash("sha256")
    for await (const chunk of content instanceof Uint8Array ? [content] : content) {
      this.largest = Math.max(this.largest, chunk.byteLength)
      hash.update(chunk)
    }
    this.digests.push(hash.digest("hex"))
    return use(`/scratch/claude-${this.digests.length}`)
  }
}

describe("the Claude Code source streams", () => {
  test("download, signed manifest, codesign copy and unpack in chunks: the tree is the staged download", async () => {
    const release = upstreamRelease({ binaries: { ...CLAUDE_BINARIES, "darwin-arm64": BIG } })
    const download: Downloader = {
      get: async (url, maxBytes) => (url === binaryURL(CLAUDE_VERSION, "darwin-arm64") ? (release.downloads.requests.push(url), chunked(BIG)) : release.downloads.get(url, maxBytes)),
    }
    const scratch = new ChunkScratch()
    const runner = new FakeRunner(() => ({ kind: "exited", code: 0, stdout: "" }))
    const source = createClaudeHarnessSource({ manifest: MANIFEST, download, runner, scratch, platform: "darwin", signingKey: { fingerprint: release.key.fingerprint } })
    const { staging, seen } = countingStaging()

    const fetched = await source.fetch(ACTION, staging)
    expect(staging.written(fetched.file)).toEqual({ sha256: ACTION.sha256, size: ACTION.size })
    expect(fetched.evidence.map((e) => `${e.kind}:${e.status}`)).toEqual(["gpg-manifest:verified", "macos-notarization:verified"])
    expect(scratch.digests).toEqual([digest(BIG)])
    expect(scratch.largest).toBeLessThanOrEqual(CHUNK_BYTES)

    const tree = await source.unpack(ACTION, fetched.file, staging)
    if (!tree.ok) throw new Error(tree.message)
    expect(tree.value).toEqual([{ rel: "claude", staged: fetched.file, mode: 0o755 }])
    expect(seen.largestWrite).toBeLessThanOrEqual(CHUNK_BYTES)
    expect(seen.largestRead).toBeLessThanOrEqual(CHUNK_BYTES)
    expect(seen.wholeReads).toBe(0)
    staging.dispose()
  }, SLOW)

  test("tempScratch writes streamed content into its private copy", async () => {
    const got = await tempScratch().withFile(chunked(BIG), async (path) => digest(new Uint8Array(readFileSync(path))))
    expect(got).toBe(digest(BIG))
  }, SLOW)
})
