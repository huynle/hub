// The Codex HarnessSource for the install-harness executor (transaction/builtin.ts). It never runs anything: it
// downloads the pinned archive over https through an injected Downloader, attempts the upstream evidence the pin
// lists, and unpacks verified bytes in memory.
//
//   fetch   the pinned file (at most the pinned size). Where the pin lists sigstore (openai/codex publishes
//           `<asset>.sigstore` for its Linux assets), the bundle is fetched from beside the asset and verified
//           offline (sigstore.ts), but only for bytes that already match the pinned digest: substituted bytes are
//           returned untouched for the executor to reject (integrity_mismatch) and are never inspected further.
//           A missing bundle, a bundle that cannot be fetched, or no trusted root is "unavailable", never a
//           blocker: hub's pinned digest is the mandatory evidence (contract §5, Q4).
//   unpack  the archive into the version directory's tree (archive.ts: bin/codex and its helpers).
import { createHash } from "node:crypto"
import type { EvidenceResult, HarnessID, InstallHarness, VerifiedManifest } from "../../contracts/index.ts"
import type { HarnessSource } from "../../transaction/builtin.ts"
import { collect } from "../../transaction/stream.ts"
import { unpackCodexArchive } from "./archive.ts"
import { codexSigstoreIdentity, verifySigstoreBundle, type SigstoreTrust } from "./sigstore.ts"

export type DownloadResult = { readonly status: "ok"; readonly bytes: Uint8Array } | { readonly status: "missing" } | { readonly status: "error"; readonly detail: string }

/** An https GET of one fixed URL, bounded in size. The only way the Codex source reaches the network. */
export interface Downloader {
  get(url: string, options: { readonly maxBytes: number }): Promise<DownloadResult>
}

export interface CodexSourceOptions {
  /** The verified hub release manifest whose pins the plan names. */
  readonly manifest: VerifiedManifest
  readonly download: Downloader
  /** sigstore's trusted root (trustFromTrustedRoot); without it sigstore evidence is "unavailable". */
  readonly trust?: SigstoreTrust
  /** The Codex version hub installed before (from the profile history), for the downgrade policy. */
  readonly installed?: (harness: HarnessID) => { readonly version: string; readonly sha256: string } | undefined
  readonly floor?: (harness: HarnessID) => string | undefined
  /** Explicit --allow-downgrade. */
  readonly allowDowngrade?: boolean
}

/** Sigstore bundles are a few KB; anything larger is not one. */
const MAX_BUNDLE_BYTES = 256 * 1024

const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

async function sigstoreEvidence(action: InstallHarness, bytes: Uint8Array, options: CodexSourceOptions): Promise<EvidenceResult> {
  if (!options.trust) return { kind: "sigstore", status: "unavailable", detail: "sigstore: this hubctl carries no sigstore trusted root" }
  const bundle = await options.download.get(`${action.source.url}.sigstore`, { maxBytes: MAX_BUNDLE_BYTES })
  if (bundle.status === "missing") return { kind: "sigstore", status: "unavailable", detail: "sigstore: upstream publishes no bundle for this asset" }
  if (bundle.status === "error") return { kind: "sigstore", status: "unavailable", detail: `sigstore: the bundle could not be fetched (${bundle.detail})` }
  return verifySigstoreBundle(bundle.bytes, bytes, { trust: options.trust, identity: codexSigstoreIdentity(action.version) })
}

export function createCodexHarnessSource(options: CodexSourceOptions): HarnessSource {
  const only = (harness: HarnessID) => {
    if (harness !== "codex") throw new Error(`the Codex source only installs codex, not ${harness}`)
  }
  return {
    manifest: options.manifest,
    async fetch(action, staging) {
      only(action.harness)
      const archive = await options.download.get(action.source.url, { maxBytes: action.size })
      if (archive.status !== "ok") throw new Error(`cannot download ${action.source.file}: ${archive.status === "missing" ? "not found" : archive.detail}`)
      const bytes = archive.bytes
      const file = await staging.write(action.source.file, bytes, { maxBytes: action.size })
      // Only bytes that are exactly the pinned artifact are looked at any further.
      if (bytes.byteLength !== action.size || digestOf(bytes) !== action.sha256) return { file, evidence: [] }
      const evidence: EvidenceResult[] = []
      if (action.evidence.includes("sigstore")) evidence.push(await sigstoreEvidence(action, bytes, options))
      return { file, evidence }
    },
    async unpack(action, file, staging) {
      only(action.harness)
      return unpackCodexArchive(await collect(staging.open(file).stream(), file.size))
    },
    installed: (harness) => (harness === "codex" ? options.installed?.(harness) : undefined),
    floor: (harness) => (harness === "codex" ? options.floor?.(harness) : undefined),
    ...(options.allowDowngrade !== undefined ? { allowDowngrade: options.allowDowngrade } : {}),
  }
}

/** A Downloader over fetch(): https only, no redirects to plain http, at most `maxBytes` read. */
export const httpsDownloader = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Downloader => ({
  async get(url, { maxBytes }) {
    if (!url.startsWith("https://")) return { status: "error", detail: "only https downloads are allowed" }
    let response: Response
    try {
      response = await fetchImpl(url, { redirect: "follow" })
    } catch (cause) {
      return { status: "error", detail: cause instanceof Error ? cause.message : String(cause) }
    }
    if (response.url && !response.url.startsWith("https://")) return { status: "error", detail: "redirected away from https" }
    if (response.status === 404) return { status: "missing" }
    if (!response.ok) return { status: "error", detail: `HTTP ${response.status}` }
    const declared = Number(response.headers.get("content-length") ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) return { status: "error", detail: `larger than ${maxBytes} bytes` }
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body?.getReader()
    if (reader)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return { status: "error", detail: `larger than ${maxBytes} bytes` }
        }
        chunks.push(value)
      }
    const bytes = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      bytes.set(c, at)
      at += c.byteLength
    }
    return { status: "ok", bytes }
  },
})
