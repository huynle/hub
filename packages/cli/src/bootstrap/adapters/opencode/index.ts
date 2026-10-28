// The OpenCode harness adapter (HBS-06): one entry point for the integrator (HBS-13), built on the frozen bootstrap
// contracts. createOpencodeHarness wires the pure planner (plan.ts), discovery-backed presence, the real readiness
// probes (verify.ts), the pinned-artifact source (apply.ts, archive.ts) and the executors for register-mcp-server
// and verify-harness. Every capability is injected: a read-only DiscoveryProbe, a fixed-argv ProcessRunner, the hub
// spoke probe, the download. See README.md for the upstream source findings and the integration requirements.
import type { AdapterContext, HarnessAdapter, HarnessPresence, HarnessVerification, PathRef, VerifiedManifest } from "../../contracts/index.ts"
import { discover } from "../../discovery/discover.ts"
import type { DiscoveryProbe } from "../../discovery/probe.ts"
import type { HarnessSource } from "../../transaction/builtin.ts"
import type { ExecutorMap } from "../../transaction/executor.ts"
import { createOpencodeHarnessSource, httpsDownload, opencodeExecutors, type Download } from "./apply.ts"
import { createOpencodeAdapter, type OpencodePlanOptions } from "./plan.ts"
import { locateOpencodeBinary, nodeProcessRunner, verifyOpencode, type ProcessRunner, type ProviderProbe, type SpokeProbe } from "./verify.ts"

export * from "./archive.ts"
export * from "./config.ts"
export * from "./plan.ts"
export * from "./verify.ts"
export * from "./apply.ts"

export interface OpencodeHarnessOptions extends Omit<OpencodePlanOptions, "readConfig"> {
  /** Read-only host access (createNodeProbe() in the CLI, memoryProbe() in tests). */
  readonly probe: DiscoveryProbe
  /** Default: nodeProcessRunner (execFile, no shell). */
  readonly runner?: ProcessRunner
  /** Whether the hub sees this machine's OpenCode spoke; without it OpenCode is never ready. */
  readonly spoke?: SpokeProbe
  readonly provider?: ProviderProbe
  /** Default: httpsDownload(fetch). */
  readonly download?: Download
  /** Downgrade-policy inputs for the harness source (from the install history). */
  readonly installed?: () => { readonly version: string; readonly sha256: string } | undefined
  readonly floor?: () => string | undefined
  readonly allowDowngrade?: boolean
  readonly onVerification?: (verification: HarnessVerification) => void
}

export interface OpencodeHarness {
  readonly adapter: HarnessAdapter
  /** Absent without a manifest (nothing can be installed then). */
  readonly source?: HarnessSource
  /** Executors for apply's context: merge them over builtinExecutors. */
  executors(context: () => AdapterContext): Pick<ExecutorMap, "register-mcp-server" | "verify-harness">
}

/** The version directory a hub-managed binary lives in (data:hub/harnesses/opencode/<version>/bin/opencode). */
const HUB_VERSION = /\/hub\/harnesses\/opencode\/([^/]+)\/bin\/opencode$/

export function createOpencodeHarness(options: OpencodeHarnessOptions): OpencodeHarness {
  const { probe } = options
  const runner = options.runner ?? nodeProcessRunner
  const presence = async (context: AdapterContext): Promise<HarnessPresence> => {
    const snap = discover(probe, { now: context.now() })
    const found = snap.ok ? snap.value.harnesses.find((h) => h.id === "opencode") : undefined
    return found ?? { id: "opencode", installed: false, health: { state: "unverified", probes: [] } }
  }
  const verify = async (context: AdapterContext): Promise<HarnessVerification> => {
    // Located fresh at every verification: after an install, `current` points at the new version.
    const located = locateOpencodeBinary(probe)
    const binary = located.ok ? located.value : undefined
    const expectVersion = binary ? HUB_VERSION.exec(binary)?.[1] : undefined
    return verifyOpencode(context, { runner, binary, ...(options.spoke ? { spoke: options.spoke } : {}), ...(options.provider ? { provider: options.provider } : {}), ...(expectVersion ? { expectVersion } : {}) })
  }
  const adapter = createOpencodeAdapter({ ...options, readConfig: (path) => probe.readFile(path), discover: presence, verify })
  const source = options.manifest
    ? createOpencodeHarnessSource({
        manifest: options.manifest as VerifiedManifest,
        download: options.download ?? httpsDownload(),
        ...(options.installed ? { installed: options.installed } : {}),
        ...(options.floor ? { floor: options.floor } : {}),
        ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
      })
    : undefined
  return {
    adapter,
    ...(source ? { source } : {}),
    executors: (context) => opencodeExecutors({ adapter, context, ...(options.authority ? { authority: options.authority as PathRef } : {}), ...(options.onVerification ? { onVerification: options.onVerification } : {}) }),
  }
}
