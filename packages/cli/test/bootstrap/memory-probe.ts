// A child-process probe for the install memory regression test (bootstrap-install-memory.test.ts), runnable by hand:
//
//   bun memory-probe.ts gen <out> <MiB> <tar.gz|zip>   a synthetic OpenCode release (one `opencode` file of <MiB> MiB,
//                                                     partly compressible like a real binary), written by streaming
//   bun memory-probe.ts install <archive>              installs it through the real engine, the built-in
//                                                     install-harness executor and the OpenCode source (its https
//                                                     download over an injected fetch that streams the file) into a
//                                                     fresh sandboxed home; prints one JSON line:
//                                                     { ok, baseline, peak, growth, unpacked } (bytes of RSS)
//
// Measuring in a child keeps the test runner's own heap out of the numbers.
import { createHash, randomBytes } from "node:crypto"
import { closeSync, createReadStream, createWriteStream, openSync, readSync, statSync, unlinkSync, writeSync } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createDeflateRaw, createGzip } from "node:zlib"
import { createOpencodeHarnessSource, httpsDownload } from "../../src/bootstrap/adapters/opencode/apply.ts"
import { planDigest, type Action, type SetupPlan } from "../../src/bootstrap/contracts/index.ts"
import { builtinExecutors } from "../../src/bootstrap/transaction/builtin.ts"
import { createApplier } from "../../src/bootstrap/transaction/engine.ts"
import type { ActionExecutor } from "../../src/bootstrap/transaction/executor.ts"
import { txOk } from "../../src/bootstrap/transaction/result.ts"
import { ACTIONS, HOST, MINUTE, PREVIEW, T0 } from "./fixtures.ts"
import { signedManifest } from "./opencode-adapter-fixtures.ts"
import { sandbox } from "./transaction-fixtures.ts"


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
const VERSION = "9.9.9"

/** `mib` MiB of binary-like content, one MiB at a time (never all of it in memory). */
async function* content(mib: number): AsyncGenerator<Uint8Array> {
  const pattern = Buffer.alloc(MiB)
  for (let i = 0; i < MiB; i++) pattern[i] = (i * 31) & 0xff
  for (let n = 0; n < mib; n++) {
    const block = Buffer.from(pattern)
    randomBytes(MiB / 3).copy(block, (n * 4096) % (MiB / 2))
    yield block
  }
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512)
  const put = (s: string, at: number) => h.write(s, at, "latin1")
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0")
  put(name, 0)
  put(octal(mode, 8), 100)
  put(octal(0, 8), 108)
  put(octal(0, 8), 116)
  put(octal(size, 12), 124)
  put(octal(0, 12), 136)
  h.fill(0x20, 148, 156)
  put("0", 156)
  put("ustar", 257)
  put("00", 263)
  let sum = 0
  for (const b of h) sum += b
  put(`${octal(sum, 7)}\0`, 148)
  return h
}

async function genTarGz(out: string, mib: number): Promise<void> {
  async function* tar() {
    yield tarHeader("opencode", mib * MiB, 0o755)
    yield* content(mib)
    yield Buffer.alloc(1024)
  }
  await pipeline(Readable.from(tar()), createGzip({ level: 1 }), createWriteStream(out))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return ~c >>> 0
}

async function genZip(out: string, mib: number): Promise<void> {
  // Deflate into a temporary file first (the headers need the compressed size), then assemble.
  const body = `${out}.deflate`
  let crc = 0
  async function* hashed() {
    for await (const chunk of content(mib)) {
      crc = crc32(crc, chunk)
      yield chunk
    }
  }
  await pipeline(Readable.from(hashed()), createDeflateRaw({ level: 1 }), createWriteStream(body))
  const compressed = statSync(body).size
  const size = mib * MiB
  const name = Buffer.from("opencode")
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE((3 << 8) | 20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
  central.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12)
  eocd.writeUInt32LE(30 + name.length + compressed, 16)
  const fd = openSync(out, "w")
  try {
    writeSync(fd, local)
    writeSync(fd, name)
    const input = openSync(body, "r")
    const buf = Buffer.alloc(MiB)
    for (let n; (n = readSync(input, buf, 0, buf.length, null)) > 0; ) writeSync(fd, buf, 0, n)
    closeSync(input)
    writeSync(fd, central)
    writeSync(fd, name)
    writeSync(fd, eocd)
  } finally {
    closeSync(fd)
    unlinkSync(body)
  }
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path, { highWaterMark: MiB })) hash.update(chunk as Buffer)
  return `sha256:${hash.digest("hex")}`
}

async function install(archive: string): Promise<void> {
  const zip = archive.endsWith(".zip")
  const target = zip ? "darwin-arm64" : "linux-x64"
  const file = zip ? "opencode-darwin-arm64.zip" : "opencode-linux-x64.tar.gz"
  const url = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/${file}`
  const size = statSync(archive).size
  const sha256 = await digestOf(archive)
  const manifest = signedManifest([{ harness: "opencode", version: VERSION, target, url, file, size, sha256, evidence: [] }])
  const box = sandbox()
  try {
    const action = {
      id: "install-opencode",
      kind: "install-harness",
      escalation: "user",
      summary: `Install OpenCode ${VERSION}`,
      harness: "opencode",
      version: VERSION,
      target,
      source: { manifest: manifest.release, url, file },
      size,
      sha256,
      evidence: [],
      path: { root: "data", rel: `hub/harnesses/opencode/${VERSION}` },
      owner: "hub",
      rollback: "restore-previous",
    } as Action
    const plan: SetupPlan = {
      schema: "hub.setup-plan",
      version: 1,
      hostFingerprint: HOST,
      snapshotDigest: PREVIEW.snapshotDigest,
      target,
      profile: { id: "session-only", version: 1 },
      requiresEscalation: false,
      activatesServices: false,
      actions: [action, { ...ACTIONS["select-harness-version"], version: VERSION, target: { root: "data", rel: `hub/harnesses/opencode/${VERSION}` } } as Action, { ...ACTIONS["verify-harness"], probes: ["version-exec"] } as Action],
    }
    // The real https download, over a fetch that streams the archive from disk.
    const fetchImpl = async () => new Response(fileBody(archive), { headers: { "content-length": String(size) } })
    const source = createOpencodeHarnessSource({ manifest, download: httpsDownload(fetchImpl) })
    const now = T0 + MINUTE
    // Readiness is not what this measures: the verification step passes.
    const passes: ActionExecutor<"verify-harness"> = { kind: "verify-harness", plan: () => ({ class: "external" }), change: async () => txOk({ type: "effect", perform: async () => txOk(undefined) }) }
    const applier = createApplier({ roots: box.roots, host: { fingerprint: HOST, target }, executors: { ...builtinExecutors({ harness: source }), "verify-harness": passes }, now: () => now, pid: process.pid, isAlive: () => true })
    const token = { ...PREVIEW, planDigest: planDigest(plan), issuedAt: now - 1000, expiresAt: now + 10 * MINUTE, nonce: "nonce-memory-0123456789abcdef" }
    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sample = () => {
      // The OS's high-water mark too (it also sees the peaks of synchronous stretches no timer interrupts); Bun
      // reports it in bytes on macOS and in KiB on Linux.
      const rss = process.memoryUsage().rss
      const max = process.resourceUsage().maxRSS
      peak = Math.max(peak, rss, max < rss / 64 ? max * 1024 : max)
    }
    const timer = setInterval(sample, 5)
    const r = await applier.apply({ token, replan: async () => ({ plan }) })
    sample()
    clearInterval(timer)
    const unpacked = r.ok ? statSync(box.path("data", `hub/harnesses/opencode/${VERSION}/bin/opencode`)).size : 0
    console.log(JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { error: `${r.code}: ${r.message}` }), baseline, peak, growth: peak - baseline, unpacked }))
  } finally {
    box.cleanup()
  }
}

const [mode, path, arg, format] = process.argv.slice(2)
if (mode === "gen") await (format === "zip" ? genZip(path!, Number(arg)) : genTarGz(path!, Number(arg)))
else if (mode === "install") await install(path!)
else {
  console.error("usage: memory-probe.ts gen <out> <MiB> <tar.gz|zip> | install <archive>")
  process.exit(2)
}
