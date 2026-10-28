// Codex adapter conformance (HBS-09): the HarnessAdapter plans the pinned install → select → verify, its
// HarnessSource feeds the built-in install-harness executor with sigstore evidence (verified, unavailable or
// failed), its verify-harness executor gives readiness only from real probes (the installed binary really runs),
// a failed probe rolls the install back to the previous version, the one TOML edit is a manual edit, and nothing it
// outputs carries a secret.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import {
  createAdapterRegistry,
  findSecrets,
  HARNESS_ORDER,
  planDigest,
  previewApplicable,
  validateJournal,
  type AdapterContext,
  type DiscoverySnapshot,
  type PreviewToken,
  type SetupPlan,
} from "../src/bootstrap/contracts/index.ts"
import { createCodexAdapter, createCodexHarnessSource, codexVerifyExecutor, nodeProbeRunner, trustFromTrustedRoot, type CodexAdapterOptions } from "../src/bootstrap/adapters/codex/index.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { builtinExecutors } from "../src/bootstrap/transaction/builtin.ts"
import { createApplier } from "../src/bootstrap/transaction/engine.ts"
import { CHATGPT_HANDLERS, CODEX_ARCHIVE_LINUX, CODEX_DISCOVERY_LINUX, CODEX_PINS, codexDiscoveredAt, codexManifest, fakeAppServerChannel, fakeDownloads, PROFILE_CODEX, sigstoreWorld, type BundleOptions } from "./bootstrap/codex-fixtures.ts"
import { MINUTE, PREVIEW, T0 } from "./bootstrap/fixtures.ts"
import { sandbox, type Sandbox } from "./bootstrap/transaction-fixtures.ts"

const LINUX = CODEX_PINS.find((p) => p.target === "linux-x64")!
const NOW = T0 + MINUTE
let boxes: Sandbox[] = []
afterEach(() => {
  for (const b of boxes) b.cleanup()
  boxes = []
})

interface Host {
  readonly box: Sandbox
  readonly snapshot: DiscoverySnapshot
}

/** A sandboxed Linux host, optionally with Codex 0.160.0 already installed and current through hub. */
function host(options: { previous?: boolean } = {}): Host {
  const box = sandbox()
  boxes.push(box)
  const base = options.previous ? codexDiscoveredAt("0.160.0") : CODEX_DISCOVERY_LINUX
  const snapshot: DiscoverySnapshot = {
    ...base,
    configs: [],
    roots: box.roots,
    harnesses: base.harnesses.map((h) => (h.id === "codex" && h.installed ? { ...h, path: box.path("data", "hub/harnesses/codex/current/bin/codex") } : h)),
  }
  if (options.previous) {
    mkdirSync(box.path("data", "hub/harnesses/codex/0.160.0/bin"), { recursive: true })
    writeFileSync(box.path("data", "hub/harnesses/codex/0.160.0/bin/codex"), '#!/bin/sh\necho "codex-cli 0.160.0"\n', { mode: 0o755 })
    symlinkSync("0.160.0", box.path("data", "hub/harnesses/codex/current"))
  }
  return { box, snapshot }
}

const context = (box: Sandbox): AdapterContext => ({ env: { PATH: "/usr/bin:/bin", HOME: box.path("home", ""), HUB_TOKEN: "mt_never_passed_on" }, home: box.path("home", ""), platform: "linux", arch: "x64", now: () => NOW })

function adapterFor(h: Host, o: { spoke?: boolean; extra?: Partial<CodexAdapterOptions> } = {}) {
  const started: string[] = []
  const adapter = createCodexAdapter({
    manifest: codexManifest(),
    snapshot: () => h.snapshot,
    probes: {
      runner: nodeProbeRunner,
      appServer: { start: (binary) => (started.push(binary), { channel: fakeAppServerChannel(CHATGPT_HANDLERS).channel, stop: () => {} }) },
      spoke: { codex: async () => ({ connected: o.spoke ?? true }) },
      clientVersion: "0.8.0",
      timeoutMs: 5000,
    },
    previous: { version: "0.160.0", sha256: `sha256:${"9".repeat(64)}` },
    ...o.extra,
  })
  return { adapter, started }
}

function plan(h: Host, adapter: ReturnType<typeof adapterFor>["adapter"]) {
  const adapters = createAdapterRegistry()
  adapters.register(adapter)
  const r = planSetup({ snapshot: h.snapshot, profile: PROFILE_CODEX, links: () => undefined, adapters })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

let nonces = 0
const token = (p: SetupPlan): PreviewToken => ({ ...PREVIEW, planDigest: planDigest(p), hostFingerprint: p.hostFingerprint, snapshotDigest: p.snapshotDigest, issuedAt: NOW - 1000, expiresAt: NOW + 10 * MINUTE, nonce: `codex-nonce-${++nonces}-0123456789` })

async function apply(h: Host, o: { bundle?: BundleOptions | "none"; trust?: boolean; spoke?: boolean } = {}) {
  const { adapter } = adapterFor(h, { spoke: o.spoke })
  const planned = plan(h, adapter)
  const trust = trustFromTrustedRoot(sigstoreWorld().trustedRoot)
  if (!trust.ok) throw new Error(trust.message)
  const files: Record<string, Uint8Array> = { [LINUX.url]: CODEX_ARCHIVE_LINUX }
  if (o.bundle !== "none") files[`${LINUX.url}.sigstore`] = sigstoreWorld().bundle(CODEX_ARCHIVE_LINUX, o.bundle)
  const source = createCodexHarnessSource({ manifest: codexManifest(), download: fakeDownloads(files), ...(o.trust === false ? {} : { trust: trust.value }) })
  const verifications: unknown[] = []
  const applier = createApplier({
    roots: h.box.roots,
    host: { fingerprint: h.snapshot.host.fingerprint, target: "linux-x64" },
    executors: { ...builtinExecutors({ harness: source }), "verify-harness": codexVerifyExecutor({ verify: (ctx) => adapter.verify(ctx), context: () => context(h.box), onVerified: (v) => verifications.push(v) }) },
    now: () => NOW,
    pid: 4242,
    isAlive: () => true,
    newID: () => `tx_codex${nonces}`,
  })
  const outcome = await applier.apply({ token: token(planned.plan), replan: async () => ({ plan: planned.plan, blockers: planned.blockers, evidence: planned.evidence }) })
  return { outcome, planned, verifications }
}

const version = (h: Host, v: string) => h.box.path("data", `hub/harnesses/codex/${v}`)
const current = (h: Host) => readlinkSync(h.box.path("data", "hub/harnesses/codex/current"))

describe("Codex HarnessAdapter", () => {
  test("registers as codex, in HARNESS_ORDER", () => {
    const registry = createAdapterRegistry()
    registry.register(adapterFor(host()).adapter)
    expect(registry.list().map((a) => a.id)).toEqual(["codex"])
    expect(HARNESS_ORDER.indexOf("codex")).toBe(2)
  })

  test("discover reports presence only, never health", async () => {
    const h = host({ previous: true })
    const presence = await adapterFor(h).adapter.discover(context(h.box))
    expect(presence).toMatchObject({ id: "codex", installed: true, version: "0.160.0", installMethod: "hub", health: { state: "unverified", probes: [] } })
    const none = await createCodexAdapter({ ...adapterFor(h).adapter.options, snapshot: () => undefined }).discover(context(h.box))
    expect(none).toEqual({ id: "codex", installed: false, health: { state: "unverified", probes: [] } })
  })

  test("plan shape and pins: install → select → verify, exactly the pinned artifact", () => {
    const h = host()
    const planned = plan(h, adapterFor(h).adapter)
    expect(planned.plan.actions.map((a) => a.id)).toEqual(["state-dir", "install-codex", "select-codex", "verify-codex"])
    const install = planned.plan.actions[1]!
    expect(install).toMatchObject({ kind: "install-harness", version: LINUX.version, sha256: LINUX.sha256, size: LINUX.size, source: { url: LINUX.url, file: LINUX.file, manifest: codexManifest().release }, evidence: ["sigstore"] })
  })
})

describe("Codex apply: evidence, readiness, rollback", () => {
  test("sigstore verified: installs, makes current, really runs the installed binary, commits", async () => {
    const h = host()
    const { outcome, verifications } = await apply(h)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.state).toBe("committed")
    expect(outcome.report.evidence).toEqual([{ actionID: "install-codex", results: [{ kind: "sha256-pin", status: "verified" }, expect.objectContaining({ kind: "sigstore", status: "verified" })] }])
    expect(existsSync(`${version(h, "0.165.0")}/bin/codex`)).toBe(true)
    expect(current(h)).toBe("0.165.0")
    const v = verifications[0] as { probes: { kind: string; ok: boolean; detail?: string }[] }
    expect(v.probes.find((p) => p.kind === "version-exec")).toMatchObject({ ok: true, detail: "codex-cli 0.165.0" })
  })

  test("sigstore unavailable (no bundle, or no trusted root): the pinned digest suffices, apply commits", async () => {
    for (const o of [{ bundle: "none" as const }, { trust: false }]) {
      const h = host()
      const { outcome } = await apply(h, o)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.report.evidence[0]!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(["sha256-pin:verified", "sigstore:unavailable"])
    }
  })

  test("sigstore failed: evidence_failed, nothing installed, rolled back", async () => {
    const h = host()
    const { outcome } = await apply(h, { bundle: { san: "https://github.com/evil/codex/.github/workflows/x.yml@refs/tags/rust-v0.165.0" } })
    expect(!outcome.ok && outcome.code).toBe("evidence_failed")
    expect(existsSync(version(h, "0.165.0"))).toBe(false)
    expect(existsSync(h.box.path("data", "hub/harnesses/codex/current"))).toBe(false)
  })

  test("a failed probe gives harness_not_ready and rolls back: the previous version is current again", async () => {
    const h = host({ previous: true })
    const { outcome, planned } = await apply(h, { spoke: false })
    expect(planned.plan.actions.find((a) => a.id === "install-codex")).toMatchObject({ previous: { version: "0.160.0" } })
    expect(!outcome.ok && outcome.code).toBe("harness_not_ready")
    expect(!outcome.ok && outcome.message).toContain("spoke-connected")
    expect(outcome.report?.state).toBe("rolled-back")
    expect(existsSync(version(h, "0.165.0"))).toBe(false)
    expect(current(h)).toBe("0.160.0")
    expect(existsSync(`${version(h, "0.160.0")}/bin/codex`)).toBe(true)
  })

  test("the TOML edit blocks apply as a manual edit (manual_edit_required)", () => {
    const h = host()
    const planned = plan(h, adapterFor(h, { extra: { ensureDaemonFeature: true } }).adapter)
    expect(planned.blockers.map((b) => [b.reason, b.format, b.resolvedPath])).toEqual([["unmergeable-format", "toml", h.box.path("home", ".codex/config.toml")]])
    const gate = previewApplicable({ schema: "hub.setup-preview", version: 1, plan: planned.plan, planDigest: planDigest(planned.plan), token: token(planned.plan), blockers: planned.blockers, evidence: planned.evidence })
    expect(!gate.ok && gate.issues[0]!.code).toBe("manual_edit_required")
  })

  test("secret scan: plans, blockers, reports, verifications and journals carry no credential", async () => {
    const h = host({ previous: true })
    const ok = await apply(host())
    const failed = await apply(h, { spoke: false })
    const planned = plan(h, adapterFor(h, { extra: { ensureDaemonFeature: true } }).adapter)
    const outputs = [planned, ok.outcome, ok.verifications, failed.outcome, failed.verifications]
    for (const o of outputs) expect(findSecrets(JSON.parse(JSON.stringify(o)))).toEqual([])
    const text = JSON.stringify(outputs)
    for (const leak of ["mt_never_passed_on", "dev@example.com"]) expect(text).not.toContain(leak)
    const { readdirSync, readFileSync } = await import("node:fs")
    const dir = h.box.path("state", "hub/bootstrap/journal")
    const names = readdirSync(dir).filter((x) => x.endsWith(".json"))
    expect(names.some((x) => !x.endsWith(".plan.json"))).toBe(true)
    for (const f of names) {
      const doc = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))
      if (!f.endsWith(".plan.json")) expect(validateJournal(doc).ok).toBe(true)
      expect(findSecrets(doc)).toEqual([])
    }
  })
})
