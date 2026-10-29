// HBS-12: large content never passes through the engine as bytes. install-artifact installs hubctl from its own
// executable by a chunked copy whose digest is checked while it is made (a file that changed since it was digested
// is refused, and nothing is replaced), backs up the hubctl it replaces in chunks and restores it the same way on
// rollback; the step's staging area is removed after the step, and a crashed apply's staging is swept under the lock.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { manifestPayload, planDigest, verifyManifest, type Action, type ArtifactManifest, type SetupPlan, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { installArtifactExecutor } from "../src/bootstrap/transaction/builtin.ts"
import { createApplier } from "../src/bootstrap/transaction/engine.ts"
import type { ActionExecutor, ExecutorMap } from "../src/bootstrap/transaction/executor.ts"
import { nodeFs, type TxFs } from "../src/bootstrap/transaction/fs.ts"
import { txFail, txOk } from "../src/bootstrap/transaction/result.ts"
import { CHUNK_BYTES } from "../src/bootstrap/transaction/stream.ts"
import { ACTIONS, HOST, MANIFEST_UNSIGNED, MINUTE, PREVIEW, T0, TRUST_ROOT_TEMPLATE } from "./bootstrap/fixtures.ts"
import { sandbox, type Sandbox } from "./bootstrap/transaction-fixtures.ts"

const MiB = 1024 * 1024
const NOW = T0 + MINUTE
const digest = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`
const filled = (size: number, seed: number) => {
  const b = new Uint8Array(size)
  for (let i = 0; i < size; i++) b[i] = (i * seed + (i >> 9)) & 0xff
  return b
}
/** A 3 MiB hubctl, and the 2 MiB one it replaces: both larger than a chunk. */
const NEW_HUBCTL = filled(3 * MiB, 7)
const OLD_HUBCTL = filled(2 * MiB, 11)

function manifestFor(bytes: Uint8Array): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const body: Omit<ArtifactManifest, "signatures"> = {
    ...MANIFEST_UNSIGNED,
    artifacts: MANIFEST_UNSIGNED.artifacts.map((a) => (a.target === "darwin-arm64" ? { ...a, size: bytes.byteLength, sha256: digest(bytes) } : a)),
  }
  const manifest: ArtifactManifest = { ...body, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const verified = verifyManifest(manifest, root)
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues))
  return verified.value
}

let boxes: Sandbox[] = []
afterEach(() => {
  for (const b of boxes) b.cleanup()
  boxes = []
})

/** A host with an old hubctl in user-bin, and a release hubctl at `source` (its own executable, say). */
function world(options: { failAfter?: boolean } = {}) {
  const box = sandbox()
  boxes.push(box)
  const target = box.path("user-bin", "hubctl")
  writeFileSync(target, OLD_HUBCTL, { mode: 0o755 })
  const source = `${box.dir}/release/hubctl`
  mkdirSync(`${box.dir}/release`)
  writeFileSync(source, NEW_HUBCTL, { mode: 0o755 })
  const seen = { wholeReads: [] as string[], largestRead: 0, largestWrite: 0 }
  const fs: TxFs = {
    ...nodeFs,
    readFile: (path) => (seen.wholeReads.push(path), nodeFs.readFile(path)),
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
  const manifest = manifestFor(NEW_HUBCTL)
  const fails: ActionExecutor<"verify-runtime"> = { kind: "verify-runtime", plan: () => ({ class: "external" }), change: async () => txOk({ type: "effect", perform: async () => txFail("internal", "a later step fails") }) }
  const executors: ExecutorMap = { "install-artifact": installArtifactExecutor({ manifest, fetch: async () => ({ path: source }) }), "verify-runtime": fails }
  const actions: Action[] = [{ ...(ACTIONS["install-artifact"] as Extract<Action, { kind: "install-artifact" }>), sha256: digest(NEW_HUBCTL) }, ...(options.failAfter ? [ACTIONS["verify-runtime"]] : [])]
  const plan: SetupPlan = {
    schema: "hub.setup-plan",
    version: 1,
    hostFingerprint: HOST,
    snapshotDigest: PREVIEW.snapshotDigest,
    target: "darwin-arm64",
    profile: { id: "session-only", version: 1 },
    requiresEscalation: false,
    activatesServices: false,
    actions,
  }
  let nonce = 0
  const apply = (hooks = {}) =>
    createApplier({ roots: box.roots, host: { fingerprint: HOST, target: "darwin-arm64" }, fs, executors, now: () => NOW, pid: process.pid, isAlive: () => true, hooks }).apply({
      token: { ...PREVIEW, planDigest: planDigest(plan), issuedAt: NOW - 1000, expiresAt: NOW + 10 * MINUTE, nonce: `nonce-staging-${++nonce}-0123456789abcdef` },
      replan: async () => ({ plan }),
    })
  return { box, target, source, seen, apply, staging: box.path("state", "hub/bootstrap/staging") }
}

describe("large files go through the engine in chunks", () => {
  test("hubctl installs from its own executable by a chunked copy; the hubctl it replaces is backed up in chunks", async () => {
    const w = world()
    const r = await w.apply()
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    expect(readFileSync(w.target)).toEqual(Buffer.from(NEW_HUBCTL))
    expect(w.seen.wholeReads.filter((p) => p === w.target || p === w.source)).toEqual([])
    expect(w.seen.largestRead).toBeLessThanOrEqual(CHUNK_BYTES)
    expect(w.seen.largestWrite).toBeLessThanOrEqual(CHUNK_BYTES)
  }, 60_000)

  test("a failure later rolls back: the old hubctl comes back byte for byte, restored in chunks", async () => {
    const w = world({ failAfter: true })
    const r = await w.apply()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.report?.state).toBe("rolled-back")
    expect(readFileSync(w.target)).toEqual(Buffer.from(OLD_HUBCTL))
    expect(w.seen.wholeReads.filter((p) => p === w.target || p === w.source || p.includes("/backups/"))).toEqual([])
    expect(w.seen.largestWrite).toBeLessThanOrEqual(CHUNK_BYTES)
  }, 60_000)

  test("an executable that changed after it was digested is refused while it is copied; nothing is replaced", async () => {
    const w = world()
    const r = await w.apply({ beforeAction: () => writeFileSync(w.source, filled(3 * MiB, 5)) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("integrity_mismatch")
    expect(readFileSync(w.target)).toEqual(Buffer.from(OLD_HUBCTL))
  }, 60_000)

  test("the staging area is gone after the step, and a crashed apply's leftovers are swept under the lock", async () => {
    const w = world()
    mkdirSync(`${w.staging}/tx_crashed/dir`, { recursive: true })
    writeFileSync(`${w.staging}/tx_crashed/dir/opencode-linux-x64.tar.gz`, "half a download")
    const r = await w.apply()
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    expect(existsSync(w.staging) ? readdirSync(w.staging) : []).toEqual([])
  }, 60_000)
})
