// HBS-06: applying an OpenCode plan through the transactional engine on a sandboxed fake host. The adapter supplies
// the HarnessSource (download through an injected fetch, verified only by hub's pinned digest, then unpacked), the
// register-mcp-server executor (hubctl's mcp at the stable authority, decided from the file as it is at apply) and
// the verify-harness executor (real probes; not ready fails the apply). Rollback makes the previous OpenCode current
// again and restores the config, but never overwrites an edit the user made after hub wrote it.
import { afterEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import { createAdapterRegistry, planDigest, REQUIRED_PROBES, type Action, type AdapterContext, type DiscoverySnapshot, type HarnessVerification, type Profile, type SetupPlan } from "../src/bootstrap/contracts/index.ts"
import { createOpencodeHarnessSource, httpsDownload, opencodeExecutors } from "../src/bootstrap/adapters/opencode/apply.ts"
import { createOpencodeAdapter, planOpencode } from "../src/bootstrap/adapters/opencode/plan.ts"
import { builtinExecutors } from "../src/bootstrap/transaction/builtin.ts"
import { collect, memoryStaging } from "../src/bootstrap/transaction/stream.ts"
import { createApplier } from "../src/bootstrap/transaction/engine.ts"
import { DISCOVERY_DARWIN, HOST, MINUTE, PREVIEW, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"
import { ARCHIVES, CONFIG_WITH_EVERYTHING, FAKE_BINARY, PINNED, insertionsOf, opencodePin, sha256Of, signedManifest } from "./bootstrap/opencode-adapter-fixtures.ts"
import { sandbox, type Sandbox } from "./bootstrap/transaction-fixtures.ts"

const MANIFEST = signedManifest()
const profile = PROFILE_SESSION_ONLY as Profile
const NOW = T0 + MINUTE
const enc = (s: string) => new TextEncoder().encode(s)

let boxes: Sandbox[] = []
afterEach(() => {
  for (const b of boxes) b.cleanup()
  boxes = []
})

/** A fake host: a sandbox with the user's JSONC config and a hub-managed OpenCode 2.1.0 that is current. */
function world(options: { verify?: (ctx: AdapterContext) => Promise<HarnessVerification>; tampered?: boolean; config?: string } = {}) {
  const box = sandbox()
  boxes.push(box)
  const configPath = box.path("config", "opencode/opencode.jsonc")
  mkdirSync(box.path("config", "opencode"), { recursive: true })
  const config = options.config ?? CONFIG_WITH_EVERYTHING
  writeFileSync(configPath, config, { mode: 0o644 })
  mkdirSync(box.path("data", "hub/harnesses/opencode/2.1.0/bin"), { recursive: true })
  writeFileSync(box.path("data", "hub/harnesses/opencode/2.1.0/bin/opencode"), "old opencode", { mode: 0o755 })
  symlinkSync("2.1.0", box.path("data", "hub/harnesses/opencode/current"))
  const snapshot: DiscoverySnapshot = {
    ...DISCOVERY_DARWIN,
    topology: { container: "none", shims: [] },
    harnesses: DISCOVERY_DARWIN.harnesses.map((h) => (h.id === "opencode" ? { ...h, path: box.path("data", "hub/harnesses/opencode/current/bin/opencode"), version: "2.1.0", installMethod: "hub" as const } : h)),
    configs: [{ path: configPath, owner: "harness:opencode", format: "jsonc", sha256: sha256Of(config) }],
    roots: box.roots,
  }
  const planned = planOpencode({ snapshot, profile }, { manifest: MANIFEST, readConfig: (p) => new Uint8Array(readFileSync(p)) })
  if (!planned.ok) throw new Error(`${planned.code}: ${planned.message}`)
  const plan: SetupPlan = {
    schema: "hub.setup-plan",
    version: 1,
    hostFingerprint: HOST,
    snapshotDigest: PREVIEW.snapshotDigest,
    target: "darwin-arm64",
    profile: { id: profile.id, version: profile.version },
    requiresEscalation: false,
    activatesServices: false,
    actions: planned.value.actions as Action[],
  }
  const ready = async (ctx: AdapterContext): Promise<HarnessVerification> => ({ harness: "opencode", probes: REQUIRED_PROBES.opencode.map((kind) => ({ kind, ok: true, observedAt: ctx.now() })) })
  const adapter = createOpencodeAdapter({ manifest: MANIFEST, readConfig: () => undefined, verify: options.verify ?? ready })
  const fetched: string[] = []
  const source = createOpencodeHarnessSource({
    manifest: MANIFEST,
    download: async (url, limits) => {
      fetched.push(`${url} <=${limits.maxBytes}`)
      const bytes = ARCHIVES["darwin-arm64"].bytes
      if (!options.tampered) return bytes
      const evil = bytes.slice()
      evil[40] = evil[40]! ^ 0xff
      return evil
    },
  })
  const context = (): AdapterContext => ({ env: { HOME: box.path("home", "").slice(0, -1) }, home: box.path("home", "").slice(0, -1), platform: "darwin", arch: "arm64", now: () => NOW })
  const executors = { ...builtinExecutors({ harness: source }), ...opencodeExecutors({ adapter, context }) }
  const applier = createApplier({ roots: box.roots, host: { fingerprint: HOST, target: "darwin-arm64" }, executors, now: () => NOW, pid: 4242, isAlive: () => true, newID: () => "tx_opencode1" })
  const token = { ...PREVIEW, planDigest: planDigest(plan), issuedAt: NOW - 1000, expiresAt: NOW + 10 * MINUTE, nonce: "nonce-opencode-0123456789abcdef" }
  const apply = () => applier.apply({ token, replan: async () => ({ plan }) })
  const current = () => readlinkSync(box.path("data", "hub/harnesses/opencode/current"))
  const read = () => readFileSync(configPath, "utf8")
  return { box, plan, apply, current, read, configPath, fetched, config }
}

describe("applying an OpenCode plan", () => {
  test("installs the pinned version beside the old one, makes it current, registers plugin and MCP losslessly", async () => {
    const w = world()
    expect(w.plan.actions.map((a) => a.id)).toEqual(["install-opencode", "select-opencode", "opencode-plugin", "opencode-mcp", "verify-opencode"])
    const r = await w.apply()
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    expect(r.report.state).toBe("committed")
    expect(w.fetched).toEqual([`${opencodePin("darwin-arm64").url} <=${ARCHIVES["darwin-arm64"].bytes.byteLength}`])
    expect(w.current()).toBe(PINNED)
    const bin = w.box.path("data", `hub/harnesses/opencode/${PINNED}/bin/opencode`)
    expect(readFileSync(bin, "utf8")).toBe(FAKE_BINARY)
    expect(lstatSync(bin).mode & 0o777).toBe(0o755)
    expect(readFileSync(w.box.path("data", "hub/harnesses/opencode/2.1.0/bin/opencode"), "utf8")).toBe("old opencode")
    const after = w.read()
    const extra = insertionsOf(CONFIG_WITH_EVERYTHING, after)
    expect(extra?.replace(/\s+/g, "")).toBe(`"@huynle/hub","hub":{"type":"local","command":["${w.box.path("user-bin", "hubctl")}","mcp"]},`)
    expect(r.report.evidence).toEqual([{ actionID: "install-opencode", results: [{ kind: "sha256-pin", status: "verified" }] }])
  })

  test("not ready after install: the apply fails and rolls back to the previous version and the original config, byte for byte", async () => {
    const w = world({ verify: async (ctx) => ({ harness: "opencode", probes: [{ kind: "version-exec", ok: true, observedAt: ctx.now() }, { kind: "provider-auth", ok: false, observedAt: ctx.now(), detail: "opencode lists no models" }, { kind: "spoke-connected", ok: true, observedAt: ctx.now() }] }) })
    const r = await w.apply()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("harness_not_ready")
    expect(r.message).toContain("provider-auth")
    expect(r.report?.state).toBe("rolled-back")
    expect(w.current()).toBe("2.1.0")
    expect(existsSync(w.box.path("data", `hub/harnesses/opencode/${PINNED}`))).toBe(false)
    expect(w.read()).toBe(w.config)
  })

  test("rollback never overwrites an edit the user made after hub wrote the config", async () => {
    let path = ""
    const w = world({
      verify: async (ctx) => {
        // The user edits the config while verification runs (after hub's merge).
        writeFileSync(path, `${readFileSync(path, "utf8")}// my own edit\n`)
        return { harness: "opencode", probes: [{ kind: "version-exec", ok: false, observedAt: ctx.now(), detail: "exited 1" }] }
      },
    })
    path = w.configPath
    const r = await w.apply()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.report?.conflicts.map((c) => c.actionID)).toContain("opencode-mcp")
    expect(w.read()).toContain("// my own edit")
    expect(w.read()).toContain('"@huynle/hub"')
    expect(w.current()).toBe("2.1.0")
  })

  test("a download that does not match hub's pinned digest is refused before anything is unpacked", async () => {
    const w = world({ tampered: true })
    const r = await w.apply()
    expect(r.ok ? "ok" : r.code).toBe("integrity_mismatch")
    expect(w.current()).toBe("2.1.0")
    expect(w.read()).toBe(w.config)
  })

  test("a config changed between preview and apply is a conflict: nothing is written", async () => {
    const w = world()
    writeFileSync(w.configPath, `${w.config}\n// changed after the preview\n`)
    const r = await w.apply()
    expect(r.ok ? "ok" : r.code).toBe("conflict")
    expect(w.read()).toBe(`${w.config}\n// changed after the preview\n`)
    expect(w.current()).toBe("2.1.0")
  })

  test("the executors only handle OpenCode actions", async () => {
    const box = sandbox()
    boxes.push(box)
    const adapter = createOpencodeAdapter({ manifest: MANIFEST, readConfig: () => undefined })
    const ex = opencodeExecutors({ adapter, context: () => ({ env: {}, home: "/x", platform: "darwin", arch: "arm64", now: () => NOW }) })
    expect(Object.keys(ex).sort()).toEqual(["register-mcp-server", "verify-harness"])
    const registry = createAdapterRegistry()
    registry.register(adapter)
    expect(registry.get("opencode")).toBe(adapter)
  })
})

describe("createOpencodeHarnessSource", () => {
  const action = (patch: Partial<Extract<Action, { kind: "install-harness" }>> = {}) => {
    const pin = opencodePin("linux-x64")
    return {
      id: "install-opencode",
      kind: "install-harness",
      escalation: "user",
      summary: "x",
      harness: "opencode",
      version: pin.version,
      target: pin.target,
      source: { manifest: MANIFEST.release, url: pin.url, file: pin.file },
      size: pin.size,
      sha256: pin.sha256,
      evidence: [],
      path: { root: "data", rel: `hub/harnesses/opencode/${pin.version}` },
      owner: "hub",
      rollback: "restore-previous",
      ...patch,
    } as Extract<Action, { kind: "install-harness" }>
  }

  test("fetches exactly the pinned URL, bounded by the pinned size; OpenCode has no upstream evidence", async () => {
    const calls: string[] = []
    const source = createOpencodeHarnessSource({ manifest: MANIFEST, download: async (url, l) => (calls.push(`${url} ${l.maxBytes}`), ARCHIVES["linux-x64"].bytes) })
    const staging = memoryStaging()
    const r = await source.fetch(action(), staging)
    expect(r.evidence).toEqual([])
    expect(calls).toEqual([`${opencodePin("linux-x64").url} ${ARCHIVES["linux-x64"].bytes.byteLength}`])
    expect(staging.bytes(r.file)).toEqual(ARCHIVES["linux-x64"].bytes)
    const files = await source.unpack(action(), r.file, staging)
    expect(files.ok && files.value.map((f) => f.rel)).toEqual(["bin/opencode"])
  })

  test("refuses other harnesses and unpinned sources without downloading", async () => {
    let called = false
    const source = createOpencodeHarnessSource({ manifest: MANIFEST, download: async () => ((called = true), new Uint8Array()) })
    await expect(source.fetch(action({ harness: "codex" }), memoryStaging())).rejects.toThrow(/opencode/i)
    await expect(source.fetch(action({ source: { manifest: MANIFEST.release, url: "https://evil.example/opencode-linux-x64.tar.gz", file: "opencode-linux-x64.tar.gz" } }), memoryStaging())).rejects.toThrow(/pin/)
    expect(called).toBe(false)
  })

  test("installed and floor come from the integrator", () => {
    const source = createOpencodeHarnessSource({ manifest: MANIFEST, download: async () => new Uint8Array(), installed: () => ({ version: "2.1.0", sha256: sha256Of("x") }), floor: () => "2.0.0", allowDowngrade: true })
    expect(source.installed?.("opencode")).toEqual({ version: "2.1.0", sha256: sha256Of("x") })
    expect(source.installed?.("codex")).toBeUndefined()
    expect(source.floor?.("opencode")).toBe("2.0.0")
    expect(source.allowDowngrade).toBe(true)
  })
})

describe("httpsDownload", () => {
  const response = (body: Uint8Array, init: { url?: string; status?: number } = {}) =>
    Object.defineProperty(new Response(body as BodyInit, { status: init.status ?? 200 }), "url", { value: init.url ?? "https://objects.githubusercontent.com/x" }) as Response

  test("https only, final URL https, size bounded while it streams", async () => {
    const body = enc("12345")
    const get = async (url: string, maxBytes: number, init?: { url?: string; status?: number }) => collect(await httpsDownload(async () => response(body, init))(url, { maxBytes }), 1 << 20)
    expect(await get("https://github.com/x", 5)).toEqual(body)
    await expect(get("http://github.com/x", 5)).rejects.toThrow(/https/)
    await expect(get("https://github.com/x", 5, { url: "http://mirror.example/x" })).rejects.toThrow(/https/)
    await expect(get("https://github.com/x", 4)).rejects.toThrow(/larger/)
    // The body is a stream of chunks, never collected by the download itself.
    const chunks = httpsDownload(async () => response(body))("https://github.com/x", { maxBytes: 5 })
    expect((await chunks) instanceof Uint8Array).toBe(false)
    await expect(httpsDownload(async () => response(body, { status: 404 }))("https://github.com/x", { maxBytes: 5 })).rejects.toThrow(/404/)
  })
})
