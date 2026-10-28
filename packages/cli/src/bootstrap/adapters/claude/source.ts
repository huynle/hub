// The Claude Code HarnessSource (transaction/builtin.ts installHarnessExecutor): where the pinned binary comes from,
// which upstream evidence is attempted for it, and how it becomes the install tree. The executor checks the pin and
// the downloaded bytes' sha256 itself (mandatory, contracts §3.6.1); this source only adds the optional evidence:
//
//   gpg-manifest        upstream's per-release manifest.json and its detached signature, checked in-house
//                       (openpgp.ts) against the pinned release-signing key; the signed manifest must list exactly
//                       these bytes for this platform and version. No gpg binary is needed.
//   macos-notarization  on macOS, /usr/bin/codesign (fixed argv, through the injected runner) on a private scratch
//                       copy of the downloaded bytes: signed by Anthropic PBC's Developer ID, then notarized.
//
// Each is recorded as verified, unavailable (could not be checked here: no codesign, offline, unsigned release,
// unknown key) or failed (checked and wrong); a failure rejects the artifact (checkHarnessEvidence). Nothing here
// runs a shell, reads a credential or touches ~/.claude.
import { createHash } from "node:crypto"
import type { EvidenceResult, HarnessID, InstallHarness, VerifiedManifest } from "../../contracts/index.ts"
import type { HarnessSource } from "../../transaction/builtin.ts"
import type { TreeFile } from "../../transaction/executor.ts"
import { TxError, txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { CLAUDE_SIGNING_FINGERPRINT, verifyDetachedSignature } from "./openpgp.ts"
import { DownloadTooLarge, type Downloader, type ProbeRunner, type Scratch } from "./ports.ts"

export const UPSTREAM_RELEASES = "https://downloads.claude.ai/claude-code-releases"
export const UPSTREAM_KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc"
/** Anthropic PBC's Apple Developer ID team (codesign -dv: "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)"). */
export const ANTHROPIC_TEAM_ID = "Q6L2SF6YDW"
const IDENTITY = `anchor apple generic and certificate leaf[subject.OU] = "${ANTHROPIC_TEAM_ID}"`

/** The fixed codesign invocations; the scratch file's path is the last argument. */
export const CODESIGN = Object.freeze({
  program: "/usr/bin/codesign",
  identity: Object.freeze(["--verify", "--strict", `-R=${IDENTITY}`]),
  notarized: Object.freeze(["--verify", "--strict", `-R=notarized and ${IDENTITY}`]),
})

const MANIFEST_MAX = 1 << 20
const SIGNATURE_MAX = 64 << 10
const KEY_MAX = 64 << 10
const CODESIGN_TIMEOUT_MS = 60_000
const UPSTREAM_BINARY = /^https:\/\/downloads\.claude\.ai\/claude-code-releases\/([0-9A-Za-z.+-]+)\/([a-z0-9-]+)\/claude$/

/** Upstream's platform name for a hub target (the same names; upstream's musl builds are not hub targets). */
export function upstreamPlatform(target: string): string | undefined {
  return ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"].includes(target) ? target : undefined
}

export interface ClaudeSourceOptions {
  readonly manifest: VerifiedManifest
  readonly download: Downloader
  /** codesign for macos-notarization; without it (or the scratch) notarization is unavailable. */
  readonly runner?: ProbeRunner
  readonly scratch?: Scratch
  /** process.platform of this host. */
  readonly platform: string
  /** The release-signing key's pinned fingerprint (default CLAUDE_SIGNING_FINGERPRINT). */
  readonly signingKey?: { readonly fingerprint: string }
  /** What hub installed before (the history), for the downgrade policy. */
  readonly installed?: { readonly version: string; readonly sha256: string }
  readonly floor?: string
  readonly allowDowngrade?: boolean
}

const result = (kind: EvidenceResult["kind"], status: EvidenceResult["status"], detail: string): EvidenceResult => ({ kind, status, detail: detail.replace(/\s+/g, " ").slice(0, 200) })
const hexDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

async function gpgManifest(options: ClaudeSourceOptions, action: InstallHarness, bytes: Uint8Array): Promise<EvidenceResult> {
  const kind = "gpg-manifest"
  const m = UPSTREAM_BINARY.exec(action.source.url)
  const platform = upstreamPlatform(action.target)
  if (!m || m[1] !== action.version || !platform || m[2] !== platform) return result(kind, "unavailable", "the pinned URL is not upstream's release bucket for this version and platform")
  const base = `${UPSTREAM_RELEASES}/${action.version}`
  let manifest: Uint8Array
  let signature: Uint8Array
  let key: Uint8Array
  try {
    ;[manifest, signature, key] = await Promise.all([
      options.download.get(`${base}/manifest.json`, MANIFEST_MAX),
      options.download.get(`${base}/manifest.json.sig`, SIGNATURE_MAX),
      options.download.get(UPSTREAM_KEY_URL, KEY_MAX),
    ])
  } catch {
    return result(kind, "unavailable", `the signed manifest of ${action.version} could not be downloaded (upstream signs releases from 2.1.89 on)`)
  }
  const fingerprint = options.signingKey?.fingerprint ?? CLAUDE_SIGNING_FINGERPRINT
  const signed = verifyDetachedSignature({ data: manifest, signature, publicKey: key, fingerprint })
  if (signed.status !== "verified") return result(kind, signed.status, `manifest.json: ${signed.detail}`)
  let doc: unknown
  try {
    doc = JSON.parse(new TextDecoder().decode(manifest))
  } catch {
    return result(kind, "failed", "the signed manifest.json is not JSON")
  }
  const entry = isRecord(doc) && isRecord(doc.platforms) ? doc.platforms[platform] : undefined
  if (!isRecord(doc) || doc.version !== action.version) return result(kind, "failed", `the signed manifest is not for ${action.version}`)
  const expected = action.sha256.replace(/^sha256:/, "")
  if (!isRecord(entry) || entry.checksum !== expected || entry.size !== action.size || hexDigest(bytes) !== entry.checksum)
    return result(kind, "failed", `the signed manifest lists other bytes for ${platform} than hub's pin`)
  return result(kind, "verified", `upstream manifest.json signed by ${fingerprint} lists this binary`)
}

async function notarization(options: ClaudeSourceOptions, action: InstallHarness, bytes: Uint8Array): Promise<EvidenceResult> {
  const kind = "macos-notarization"
  if (options.platform !== "darwin" || !action.target.startsWith("darwin-")) return result(kind, "unavailable", "notarization is checked on macOS only")
  const { runner, scratch } = options
  if (!runner || !scratch) return result(kind, "unavailable", "no codesign runner in this hubctl")
  const run = (args: readonly string[], file: string) => runner.run(CODESIGN.program, [...args, file], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: CODESIGN_TIMEOUT_MS, maxOutputBytes: 64 << 10 })
  try {
    return await scratch.withFile(bytes, async (file) => {
      const identity = await run(CODESIGN.identity, file)
      if (identity.kind !== "exited") return result(kind, "unavailable", `codesign could not run (${identity.kind})`)
      if (identity.code !== 0) return result(kind, "failed", `the binary is not validly signed by Anthropic PBC (${ANTHROPIC_TEAM_ID}); codesign exit ${identity.code}`)
      const notarized = await run(CODESIGN.notarized, file)
      if (notarized.kind === "exited" && notarized.code === 0) return result(kind, "verified", `signed by Anthropic PBC (${ANTHROPIC_TEAM_ID}) and notarized by Apple`)
      return result(kind, "unavailable", `signed by Anthropic PBC (${ANTHROPIC_TEAM_ID}), but the notarization could not be confirmed (offline?)`)
    })
  } catch {
    return result(kind, "unavailable", "no scratch copy for codesign")
  }
}

/** Mach-O (64-bit, either byte order, or universal) for macOS; ELF for Linux. */
function nativeFor(target: string, bytes: Uint8Array): boolean {
  const head = [...bytes.subarray(0, 4)]
  const is = (magic: readonly number[]) => magic.every((b, i) => head[i] === b)
  if (target.startsWith("darwin-")) return [[0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe]].some(is)
  if (target.startsWith("linux-")) return is([0x7f, 0x45, 0x4c, 0x46])
  return false
}

export function createClaudeHarnessSource(options: ClaudeSourceOptions): HarnessSource {
  return {
    manifest: options.manifest,
    async fetch(action) {
      if (action.harness !== "claude-code") throw new Error(`the Claude Code source cannot install ${action.harness}`)
      // One byte more than pinned is still fetched, so a longer file is an integrity mismatch, not a download error.
      let bytes: Uint8Array
      try {
        bytes = await options.download.get(action.source.url, action.size + 1)
      } catch (error) {
        if (error instanceof DownloadTooLarge) throw new TxError("integrity_mismatch", `${action.source.url} is larger than the pinned ${action.size} bytes`)
        throw new TxError("offline", `${action.source.url} could not be downloaded`)
      }
      const evidence: EvidenceResult[] = []
      for (const kind of action.evidence) {
        if (kind === "gpg-manifest") evidence.push(await gpgManifest(options, action, bytes))
        else if (kind === "macos-notarization") evidence.push(await notarization(options, action, bytes))
      }
      return { bytes, evidence }
    },
    async unpack(action, bytes): Promise<TxResult<readonly TreeFile[]>> {
      if (action.source.file !== "claude") return txFail("invalid", `the Claude Code pin must be upstream's raw binary "claude", not ${JSON.stringify(action.source.file)}`)
      if (!nativeFor(action.target, bytes)) return txFail("invalid", `the downloaded file is not a native ${action.target} executable`)
      return txOk([{ rel: "claude", bytes, mode: 0o755 }])
    },
    installed: (harness: HarnessID) => (harness === "claude-code" ? options.installed : undefined),
    floor: (harness: HarnessID) => (harness === "claude-code" ? options.floor : undefined),
    allowDowngrade: options.allowDowngrade,
  }
}
