// The Codex HarnessSource: downloads the pinned archive over https (injected downloader), checks the upstream
// sigstore bundle where the pin lists it, and unpacks the verified bytes. Verification of the pinned digest itself
// stays in the install-harness executor (checkHarnessEvidence), so the source cannot skip it.
import { describe, expect, test } from "bun:test"
import { checkHarnessEvidence, harnessVersionRef, type InstallHarness } from "../src/bootstrap/contracts/index.ts"
import { createCodexHarnessSource, httpsDownloader } from "../src/bootstrap/adapters/codex/source.ts"
import { trustFromTrustedRoot } from "../src/bootstrap/adapters/codex/sigstore.ts"
import { sha256Of } from "../src/bootstrap/transaction/state.ts"
import { CODEX_ARCHIVE_DARWIN, CODEX_ARCHIVE_LINUX, CODEX_PINS, codexManifest, fakeDownloads, sigstoreWorld } from "./bootstrap/codex-fixtures.ts"

const [LINUX, DARWIN] = CODEX_PINS as [(typeof CODEX_PINS)[0], (typeof CODEX_PINS)[0]]
const actionFor = (pin: typeof LINUX): InstallHarness => ({
  id: "install-codex",
  kind: "install-harness",
  escalation: "user",
  summary: "Install Codex",
  harness: "codex",
  version: pin.version,
  target: pin.target,
  source: { manifest: codexManifest().release, url: pin.url, file: pin.file },
  size: pin.size,
  sha256: pin.sha256,
  evidence: pin.evidence,
  path: harnessVersionRef("codex", pin.version),
  owner: "hub",
  rollback: "restore-previous",
})
const trust = (() => {
  const t = trustFromTrustedRoot(sigstoreWorld().trustedRoot)
  if (!t.ok) throw new Error(t.message)
  return t.value
})()
const bundle = (options?: Parameters<ReturnType<typeof sigstoreWorld>["bundle"]>[1]) => sigstoreWorld().bundle(CODEX_ARCHIVE_LINUX, options)

describe("createCodexHarnessSource", () => {
  test("downloads the pinned archive, then its sigstore bundle, and verifies it (Linux)", async () => {
    const downloads = fakeDownloads({ [LINUX.url]: CODEX_ARCHIVE_LINUX, [`${LINUX.url}.sigstore`]: bundle() })
    const source = createCodexHarnessSource({ manifest: codexManifest(), download: downloads, trust })
    const r = await source.fetch(actionFor(LINUX))
    expect(downloads.requests).toEqual([LINUX.url, `${LINUX.url}.sigstore`])
    expect(r.evidence.map((e) => [e.kind, e.status])).toEqual([["sigstore", "verified"]])
    const checked = checkHarnessEvidence(actionFor(LINUX), { sha256: sha256Of(r.bytes), size: r.bytes.byteLength }, r.evidence)
    expect(checked.ok && checked.value.map((e) => `${e.kind}:${e.status}`)).toEqual(["sha256-pin:verified", "sigstore:verified"])
  })

  test("sigstore is unavailable (never verified, never a blocker) without a bundle, without trust, or when the bundle cannot be fetched", async () => {
    const cases = [
      { files: { [LINUX.url]: CODEX_ARCHIVE_LINUX }, trust },
      { files: { [LINUX.url]: CODEX_ARCHIVE_LINUX, [`${LINUX.url}.sigstore`]: "error" as const }, trust },
      { files: { [LINUX.url]: CODEX_ARCHIVE_LINUX, [`${LINUX.url}.sigstore`]: bundle() }, trust: undefined },
    ]
    for (const c of cases) {
      const r = await createCodexHarnessSource({ manifest: codexManifest(), download: fakeDownloads(c.files), ...(c.trust ? { trust: c.trust } : {}) }).fetch(actionFor(LINUX))
      expect(r.evidence.map((e) => [e.kind, e.status])).toEqual([["sigstore", "unavailable"]])
    }
  })

  test("a bundle for another identity is failed evidence, which rejects the artifact (evidence_failed)", async () => {
    const downloads = fakeDownloads({ [LINUX.url]: CODEX_ARCHIVE_LINUX, [`${LINUX.url}.sigstore`]: bundle({ san: "https://github.com/evil/codex/.github/workflows/x.yml@refs/tags/rust-v0.165.0" }) })
    const r = await createCodexHarnessSource({ manifest: codexManifest(), download: downloads, trust }).fetch(actionFor(LINUX))
    expect(r.evidence.map((e) => e.status)).toEqual(["failed"])
    const checked = checkHarnessEvidence(actionFor(LINUX), { sha256: sha256Of(r.bytes), size: r.bytes.byteLength }, r.evidence)
    expect(!checked.ok && checked.issues[0]!.code).toBe("evidence_failed")
  })

  test("macOS pins list no evidence: no bundle is requested, the pinned digest alone vouches", async () => {
    const downloads = fakeDownloads({ [DARWIN.url]: CODEX_ARCHIVE_DARWIN })
    const r = await createCodexHarnessSource({ manifest: codexManifest(), download: downloads, trust }).fetch(actionFor(DARWIN))
    expect(downloads.requests).toEqual([DARWIN.url])
    expect(r.evidence).toEqual([])
  })

  test("bytes that do not match the pin are not inspected further (no bundle request); the executor rejects them", async () => {
    const other = new TextEncoder().encode("a substituted archive")
    const downloads = fakeDownloads({ [LINUX.url]: other, [`${LINUX.url}.sigstore`]: sigstoreWorld().bundle(other) })
    const r = await createCodexHarnessSource({ manifest: codexManifest(), download: downloads, trust }).fetch(actionFor(LINUX))
    expect(downloads.requests).toEqual([LINUX.url])
    expect(r.evidence).toEqual([])
    const checked = checkHarnessEvidence(actionFor(LINUX), { sha256: sha256Of(r.bytes), size: r.bytes.byteLength }, r.evidence)
    expect(!checked.ok && checked.issues[0]!.code).toBe("integrity_mismatch")
  })

  test("a failed archive download, or another harness's action, rejects", async () => {
    const source = createCodexHarnessSource({ manifest: codexManifest(), download: fakeDownloads({ [LINUX.url]: "error" }), trust })
    await expect(source.fetch(actionFor(LINUX))).rejects.toThrow(/download/)
    await expect(source.fetch({ ...actionFor(LINUX), harness: "opencode" })).rejects.toThrow(/codex/)
  })

  test("the archive is downloaded with the pinned size as its limit", async () => {
    let limit = -1
    const source = createCodexHarnessSource({ manifest: codexManifest(), download: { get: async (_url, o) => ((limit = limit < 0 ? o.maxBytes : limit), { status: "missing" }) }, trust })
    await expect(source.fetch(actionFor(LINUX))).rejects.toThrow()
    expect(limit).toBe(LINUX.size)
  })

  test("unpack gives the install tree with bin/codex; installed/floor/allowDowngrade pass through", async () => {
    const source = createCodexHarnessSource({ manifest: codexManifest(), download: fakeDownloads({}), installed: () => ({ version: "0.160.0", sha256: LINUX.sha256 }), floor: () => "0.150.0", allowDowngrade: true })
    const files = await source.unpack(actionFor(LINUX), CODEX_ARCHIVE_LINUX)
    expect(files.ok && files.value.some((f) => f.rel === "bin/codex" && f.mode === 0o755)).toBe(true)
    expect(source.installed?.("codex")).toEqual({ version: "0.160.0", sha256: LINUX.sha256 })
    expect(source.installed?.("opencode")).toBeUndefined()
    expect(source.floor?.("codex")).toBe("0.150.0")
    expect(source.allowDowngrade).toBe(true)
  })
})

describe("httpsDownloader", () => {
  const response = (status: number, body = "") => new Response(body, { status })
  test("fetches https only, maps 404 to missing, enforces the byte limit", async () => {
    const seen: string[] = []
    const d = httpsDownloader(async (url) => (seen.push(String(url)), String(url).endsWith("/missing") ? response(404) : String(url).endsWith("/big") ? response(200, "x".repeat(100)) : response(200, "ok")))
    expect(await d.get("http://example.com/x", { maxBytes: 10 })).toMatchObject({ status: "error" })
    expect(seen).toEqual([])
    expect(await d.get("https://example.com/missing", { maxBytes: 10 })).toEqual({ status: "missing" })
    expect(await d.get("https://example.com/big", { maxBytes: 10 })).toMatchObject({ status: "error" })
    const ok = await d.get("https://example.com/x", { maxBytes: 10 })
    expect(ok.status === "ok" && new TextDecoder().decode(ok.bytes)).toBe("ok")
    expect(await httpsDownloader(async () => response(500)).get("https://example.com/x", { maxBytes: 10 })).toMatchObject({ status: "error" })
    expect(await httpsDownloader(async () => Promise.reject(new Error("offline"))).get("https://example.com/x", { maxBytes: 10 })).toMatchObject({ status: "error" })
  })
})
