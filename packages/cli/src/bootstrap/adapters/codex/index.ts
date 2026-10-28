// The Codex bootstrap adapter (HBS-09). Codex is the third harness in HARNESS_ORDER.
//
//   createCodexAdapter       the HarnessAdapter: discover (presence only), plan (planCodex: pinned install-harness,
//                            select-harness-version, verify-harness with real probes; no ~/.codex edit unless the
//                            opt-in TOML edit, which becomes a manual edit), verify (verifyCodex)
//   createCodexHarnessSource the HarnessSource for the built-in install-harness executor (pinned download,
//                            sigstore evidence, unpack)
//   codexVerifyExecutor      the verify-harness executor (harness_not_ready unless advertised ready)
//   codexCapabilities        the explicit, probe-backed capability advertisement
//
// Hub wiring reuses packages/codex: the app-server handshake (openAppServer) and stdio channel the Codex spoke uses
// probe the app-server, and the spoke itself (hub codex-spoke serve) is what spoke-connected checks for.
import type { DiscoverySnapshot, HarnessAdapter, HarnessPresence, VerifiedManifest } from "../../contracts/index.ts"
import { codexPinFor, planCodex } from "./plan.ts"
import { codexBinaryPath, verifyCodex, type CodexProbes } from "./verify.ts"

export * from "./archive.ts"
export * from "./sigstore.ts"
export * from "./source.ts"
export * from "./plan.ts"
export * from "./verify.ts"

export interface CodexAdapterOptions {
  /** The verified hub release manifest (its codex pins). */
  readonly manifest: VerifiedManifest
  /** The injected probe capabilities; the binary and expected version come from the snapshot and the pin. */
  readonly probes: Omit<CodexProbes, "binary" | "expectedVersion"> & Partial<Pick<CodexProbes, "binary">>
  /** The discovery snapshot of this host (discover reads presence from it). */
  readonly snapshot: () => DiscoverySnapshot | undefined
  /** The hub-installed Codex recorded before (profile history), for rollback records. */
  readonly previous?: { readonly version: string; readonly sha256: string }
  /** Opt-in: ask for features.daemon_auto_start in ~/.codex/config.toml (a TOML manual edit). */
  readonly ensureDaemonFeature?: boolean
}

export interface CodexAdapter extends HarnessAdapter {
  readonly options: CodexAdapterOptions
}

const NOT_FOUND: HarnessPresence = { id: "codex", installed: false, health: { state: "unverified", probes: [] } }

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  const pinFor = (snapshot: DiscoverySnapshot | undefined) => (snapshot ? codexPinFor(options.manifest, snapshot.host.target) : undefined)
  return {
    id: "codex",
    options,
    async discover() {
      const found = options.snapshot()?.harnesses.find((h) => h.id === "codex")
      // Presence only: health stays unverified until verify runs the real probes.
      return found ? { ...found, health: { state: "unverified", probes: [] } } : NOT_FOUND
    },
    plan: (input) => planCodex(input, { manifest: options.manifest, ...(options.previous ? { previous: options.previous } : {}), ...(options.ensureDaemonFeature ? { ensureDaemonFeature: true } : {}) }),
    async verify(context) {
      const snapshot = options.snapshot()
      const pin = pinFor(snapshot)
      const binary = options.probes.binary ?? (() => (snapshot ? codexBinaryPath(snapshot, { preferHub: pin !== undefined }) : undefined))
      return verifyCodex(context, { ...options.probes, binary, ...(pin ? { expectedVersion: pin.version } : {}) })
    },
  }
}
