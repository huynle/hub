// HBS-12 acceptance: installing a harness must not hold its archive (or what it unpacks to) in memory. A 4 GB host
// was OOM-killed installing OpenCode 2.2.0 (115 MB tar.gz, ~350 MB binary) because download, gunzip, the tar members,
// the tree change and the staging writes each kept another whole copy. These tests install synthetic releases through
// the real engine, the built-in install-harness executor and the OpenCode source, in a child process
// (test/bootstrap/memory-probe.ts) so the runner's own heap stays out of the numbers:
//
//   always on      32 MiB releases (tar.gz and zip): peak RSS growth stays a bounded constant (the runtime and
//                  garbage not yet collected: ~70-80 MB however large the release) instead of a multiple of the
//                  binary (it was ~6.5x: ~435 MB for 64 MiB), and no filesystem write or read ever carries more than
//                  one chunk (no whole-file buffering);
//   HUB_MEMORY_TEST=1  300 MiB releases, the size of the real thing: growth stays well under 1 GB (it was ~2 GB).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeHarnessSource, httpsDownload } from "../src/bootstrap/adapters/opencode/apply.ts"
import { planDigest, type Action, type SetupPlan } from "../src/bootstrap/contracts/index.ts"
import { builtinExecutors } from "../src/bootstrap/transaction/builtin.ts"
import { createApplier } from "../src/bootstrap/transaction/engine.ts"
import type { ActionExecutor } from "../src/bootstrap/transaction/executor.ts"
import { nodeFs, type TxFs } from "../src/bootstrap/transaction/fs.ts"
import { txOk } from "../src/bootstrap/transaction/result.ts"
import { ACTIONS, HOST, MINUTE, PREVIEW, T0 } from "./bootstrap/fixtures.ts"
import { sha256Of, signedManifest } from "./bootstrap/opencode-adapter-fixtures.ts"
import { sandbox } from "./bootstrap/transaction-fixtures.ts"


/** A response body that streams `path` from disk in 64 KiB reads (a web stream pulled on demand). */
function fileBody(path: string): ReadableStream<Uint8Array> {
  let fd: number | undefined
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      fd ??= openSync(path, "r")
      const chunk = new Uint8Array(64 * 1024)
      const n = readSync(fd, chunk, 0, chunk.byteLength, null)
      if (n > 0) return controller.enqueue(chunk.subarray(0, n))
      closeSync(fd)
      controller.close()
    },
    cancel() {
      if (fd !== undefined) closeSync(fd)
    },
  })
}

const MiB = 1024 * 1024
const PROBE = join(import.meta.dir, "bootstrap/memory-probe.ts")
let dir = ""

async function probe(...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, PROBE, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`memory-probe ${args[0]} exited ${code}: ${err}`)
  return out
}

interface Measured {
  readonly ok: boolean
  readonly error?: string
  readonly growth: number
  readonly unpacked: number
}
const install = async (archive: string): Promise<Measured> => JSON.parse((await probe("install", archive)).trim().split("\n").pop()!)

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hub-mem-"))
  await Promise.all([probe("gen", join(dir, "small.tar.gz"), "32", "tar.gz"), probe("gen", join(dir, "small.zip"), "32", "zip")])
}, 300_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("installing a harness keeps memory bounded", () => {
  for (const format of ["tar.gz", "zip"]) {
    test(`a 32 MiB OpenCode release (${format}): peak RSS grows by a bounded constant, not a multiple of the binary`, async () => {
      const r = await install(join(dir, `small.${format}`))
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
      expect(r.unpacked).toBe(32 * MiB)
      // Before streaming: ~6.5x the binary (~210 MB here, 2 GB for 300 MiB). Streaming: a constant ~70-80 MB.
      expect(r.growth).toBeLessThan(128 * MiB)
    }, 300_000)
  }

  test("no filesystem write or read carries more than one chunk of the archive", async () => {
    const archive = join(dir, "small.tar.gz")
    const size = statSync(archive).size
    let largestWrite = 0
    let largestRead = 0
    const counting: TxFs = {
      ...nodeFs,
      readFile(path) {
        const bytes = nodeFs.readFile(path)
        largestRead = Math.max(largestRead, bytes.byteLength)
        return bytes
      },
      writeExclusive(path, data, mode) {
        largestWrite = Math.max(largestWrite, typeof data === "string" ? data.length : data.byteLength)
        nodeFs.writeExclusive(path, data, mode)
      },
    }
    const box = sandbox()
    try {
      const VERSION = "9.9.8"
      const file = "opencode-linux-x64.tar.gz"
      const url = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/${file}`
      const sha256 = sha256Of(new Uint8Array(await Bun.file(archive).arrayBuffer()))
      const manifest = signedManifest([{ harness: "opencode", version: VERSION, target: "linux-x64", url, file, size, sha256, evidence: [] }])
      const plan: SetupPlan = {
        schema: "hub.setup-plan",
        version: 1,
        hostFingerprint: HOST,
        snapshotDigest: PREVIEW.snapshotDigest,
        target: "linux-x64",
        profile: { id: "session-only", version: 1 },
        requiresEscalation: false,
        activatesServices: false,
        actions: [
          { ...ACTIONS["install-harness"], version: VERSION, target: "linux-x64", source: { manifest: manifest.release, url, file }, size, sha256, path: { root: "data", rel: `hub/harnesses/opencode/${VERSION}` } } as Action,
          { ...ACTIONS["select-harness-version"], version: VERSION, target: { root: "data", rel: `hub/harnesses/opencode/${VERSION}` } } as Action,
          { ...ACTIONS["verify-harness"], probes: ["version-exec"] } as Action,
        ],
      }
      const passes: ActionExecutor<"verify-harness"> = { kind: "verify-harness", plan: () => ({ class: "external" }), change: async () => txOk({ type: "effect", perform: async () => txOk(undefined) }) }
      const fetchImpl = async () => new Response(fileBody(archive))
      const source = createOpencodeHarnessSource({ manifest, download: httpsDownload(fetchImpl) })
      const now = T0 + MINUTE
      const applier = createApplier({ roots: box.roots, host: { fingerprint: HOST, target: "linux-x64" }, fs: counting, executors: { ...builtinExecutors({ harness: source }), "verify-harness": passes }, now: () => now, pid: process.pid, isAlive: () => true })
      const token = { ...PREVIEW, planDigest: planDigest(plan), issuedAt: now - 1000, expiresAt: now + 10 * MINUTE, nonce: "nonce-chunks-0123456789abcdef" }
      const r = await applier.apply({ token, replan: async () => ({ plan }) })
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
      expect(statSync(box.path("data", `hub/harnesses/opencode/${VERSION}/bin/opencode`)).size).toBe(32 * MiB)
      expect(largestWrite).toBeLessThanOrEqual(MiB)
      expect(largestRead).toBeLessThanOrEqual(MiB)
    } finally {
      box.cleanup()
    }
  }, 300_000)

  test.if(process.env.HUB_MEMORY_TEST === "1")(
    "a 300 MiB OpenCode release, the size of 2.2.0's binary: peak RSS growth stays well under 1 GB",
    async () => {
      for (const format of ["tar.gz", "zip"]) {
        const archive = join(dir, `large.${format}`)
        await probe("gen", archive, "300", format)
        const r = await install(archive)
        expect(r.error).toBeUndefined()
        expect(r.unpacked).toBe(300 * MiB)
        expect(r.growth).toBeLessThan(128 * MiB)
        rmSync(archive)
      }
    },
    1_200_000,
  )
})
