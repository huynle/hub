// What the OpenCode adapter gives the transactional applier (transaction/executor.ts): the HarnessSource for its
// pinned downloads and the executors for the two action kinds the built-ins leave to adapters.
//
//   HarnessSource        fetch: exactly the URL hub's verified manifest pins (checkHarnessPin), bounded by the
//                        pinned size, over https only, streamed into the step's staging area (never held whole);
//                        OpenCode publishes no upstream evidence, so only the pinned digest vouches for the bytes
//                        (installHarnessExecutor checks the staging area's digest before unpack is called).
//                        unpack: archive.ts (streams the binary into the staging area).
//   register-mcp-server  hubctl's `mcp` at the stable authority under mcp.servers.hub, decided from the file as it is
//                        at apply (config.ts) and spliced in by the lossless JSONC merge; only while the file is as
//                        previewed (precondition); a foreign "hub" server is a conflict. Journal class config: backed up,
//                        so a rollback restores it unless the user changed it since.
//   verify-harness       runs the adapter's real probes and classifies them (contract v1.2, harnessReadiness): an
//                        integrity failure (the binary is missing, does not run, is not the pinned version) fails
//                        the apply (harness_not_ready), which rolls the transaction back; with requireReady (the
//                        default) so does anything short of isHarnessReady; without it, a harness that only waits on
//                        the user (provider login, spoke) passes as "installed, not ready" (onReadiness).
import {
  checkHarnessPin,
  harnessReadiness,
  isHarnessReady,
  PROBE_MAX_AGE_MS,
  type AdapterContext,
  type HarnessAdapter,
  type HarnessID,
  type HarnessVerification,
  type InstallHarness,
  type PathRef,
  type VerifiedManifest,
} from "../../contracts/index.ts"
import type { HarnessSource } from "../../transaction/builtin.ts"
import type { ActionExecutor, ExecutorMap, StepContext } from "../../transaction/executor.ts"
import { mergeConfigText } from "../../transaction/json-merge.ts"
import { txFail, txOk } from "../../transaction/result.ts"
import { responseChunks, type ByteSource } from "../../transaction/stream.ts"
import { passesAsPending, type ReadinessGate } from "../readiness.ts"
import { unpackOpencodeFile } from "./archive.ts"
import { mcpServerSets } from "./config.ts"
import { checkAuthority, DEFAULT_AUTHORITY } from "./plan.ts"

// ---------- downloads ----------

export interface DownloadLimits {
  /** The pinned size: a longer body is refused while it streams. */
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

/**
 * Fetches a body (no verification: the executor checks it against the pin): bytes, or chunks as they arrive (the
 * source streams them into the staging area).
 */
export type Download = (url: string, limits: DownloadLimits) => Promise<ByteSource>

/**
 * A Download over fetch: https only (every hop: the final URL too), refused once it exceeds the limit. The status
 * and declared length are checked before it resolves; the body then streams, chunk by chunk, and fails as soon as
 * it runs past the limit.
 */
export function httpsDownload(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Download {
  return async (url, limits) => {
    if (!url.startsWith("https://")) throw new Error(`refusing to download ${url}: https only`)
    const response = await fetchImpl(url, { redirect: "follow", ...(limits.signal ? { signal: limits.signal } : {}) })
    if (response.url && !response.url.startsWith("https://")) throw new Error(`refusing ${url}: it redirected to a non-https location`)
    if (!response.ok) throw new Error(`download of ${url} failed: HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > limits.maxBytes) throw new Error(`${url} is larger than the pinned ${limits.maxBytes} bytes`)
    return responseChunks(response, limits.maxBytes, () => new Error(`${url} is larger than the pinned ${limits.maxBytes} bytes`))
  }
}

// ---------- the harness source ----------

export interface OpencodeSourceOptions {
  readonly manifest: VerifiedManifest
  readonly download: Download
  /** The OpenCode hub has installed and made current (downgrade policy), from the integrator's install history. */
  readonly installed?: () => { readonly version: string; readonly sha256: string } | undefined
  /** The highest OpenCode floor this machine has seen. */
  readonly floor?: () => string | undefined
  /** Explicit --allow-downgrade. */
  readonly allowDowngrade?: boolean
}

const onlyOpencode = (harness: HarnessID) => {
  if (harness !== "opencode") throw new Error(`the OpenCode harness source cannot install ${harness}`)
}

/** The HarnessSource for OpenCode artifacts (installHarnessExecutor verifies every byte against the pin). */
export function createOpencodeHarnessSource(options: OpencodeSourceOptions): HarnessSource {
  return {
    manifest: options.manifest,
    async fetch(action: InstallHarness, staging) {
      onlyOpencode(action.harness)
      const pin = checkHarnessPin(options.manifest, action)
      if (!pin.ok) throw new Error(`refusing to download ${action.source.url}: it is not the artifact hub ${options.manifest.release} pins (${pin.issues[0]!.message})`)
      const body = await options.download(pin.value.url, { maxBytes: pin.value.size })
      const file = await staging.write(action.source.file, body, { maxBytes: pin.value.size })
      // OpenCode publishes no signatures (contract §5): there is no upstream evidence to attempt.
      return { file, evidence: [] }
    },
    unpack: async (action, file, staging) =>
      action.harness === "opencode" ? unpackOpencodeFile(action.source.file, staging.open(file), staging) : txFail("invalid", `the OpenCode harness source cannot unpack ${action.harness}`),
    installed: (harness) => (harness === "opencode" ? options.installed?.() : undefined),
    floor: (harness) => (harness === "opencode" ? options.floor?.() : undefined),
    ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
  }
}

// ---------- executors ----------

function preconditionHolds(ctx: StepContext, precondition: { readonly exists: boolean; readonly sha256?: string }): boolean {
  const o = ctx.original
  if (o.symlink) return false
  return precondition.exists ? o.exists && o.sha256 === precondition.sha256 : !o.exists
}

/** register-mcp-server for OpenCode: hubctl's mcp at `authority` (default user-bin:hubctl). */
export function opencodeMcpExecutor(options: { readonly authority?: PathRef } = {}): ActionExecutor<"register-mcp-server"> {
  const authorityRef = options.authority ?? DEFAULT_AUTHORITY
  checkAuthority(authorityRef)
  return {
    kind: "register-mcp-server",
    plan: (action) => ({ class: "config", path: action.path }),
    check: async (action, ctx) => {
      if (action.harness !== "opencode") return txFail("invalid", `this executor registers MCP servers with OpenCode, not ${action.harness}`)
      if (action.name !== "hub") return txFail("invalid", `hubctl's MCP server is registered as "hub", not ${JSON.stringify(action.name)}`)
      if (!preconditionHolds(ctx, action.precondition)) return txFail("conflict", `${ctx.target} changed since the preview; nothing was overwritten (preview again)`)
      const authority = ctx.resolve(authorityRef, { finalMayBeSymlink: true })
      return authority.ok ? txOk(undefined) : authority
    },
    change: async (_action, ctx) => {
      const authority = ctx.resolve(authorityRef, { finalMayBeSymlink: true })
      if (!authority.ok) return authority
      const text = ctx.current.exists ? new TextDecoder().decode(ctx.fs.readFile(ctx.target!)) : undefined
      const sets = mcpServerSets(text, authority.value)
      if (!sets.ok) return sets
      if (sets.value.length === 0) return txOk({ type: "none", reason: "hubctl's MCP server is already registered" })
      const merged = mergeConfigText(text, ctx.target!.endsWith(".jsonc") ? "jsonc" : "json", sets.value)
      if (!merged.ok) return merged
      return txOk({ type: "file", bytes: new TextEncoder().encode(merged.value), mode: ctx.current.mode ?? 0o600, replace: "backup" })
    },
  }
}


/** verify-harness for OpenCode: ready (isHarnessReady), or only waiting on the user without requireReady; else it fails. */
export function opencodeVerifyExecutor(
  options: {
    readonly adapter: HarnessAdapter
    readonly context: () => AdapterContext
    /** Sees every verification (for the apply report); cannot change it. */
    readonly onVerification?: (verification: HarnessVerification) => void
  } & ReadinessGate,
): ActionExecutor<"verify-harness"> {
  return {
    kind: "verify-harness",
    plan: () => ({ class: "external" }),
    check: async (action) => (action.harness === options.adapter.id ? txOk(undefined) : txFail("invalid", `this executor verifies ${options.adapter.id}, not ${action.harness}`)),
    change: async (action) =>
      txOk({
        type: "effect",
        perform: async () => {
          const context = options.context()
          const verification = await options.adapter.verify(context)
          options.onVerification?.(structuredClone(verification))
          const now = context.now()
          const readiness = harnessReadiness(verification, now, action.probes)
          options.onReadiness?.(structuredClone(readiness))
          // Every required probe (isHarnessReady) and every probe the action asks for: present, passing, fresh.
          const missing = action.probes.filter((kind) => !passing(verification, kind, now))
          if (verification.harness === "opencode" && isHarnessReady(verification, now) && missing.length === 0) return txOk(undefined)
          if (verification.harness === "opencode" && passesAsPending(readiness, options)) return txOk(undefined)
          const failed = verification.probes.filter((p) => !p.ok)
          const why = [
            ...failed.map((p) => `${p.kind}${p.detail ? ` (${p.detail})` : ""}`),
            ...missing.filter((kind) => !failed.some((p) => p.kind === kind)).map((kind) => `${kind} (not run, or stale)`),
          ]
          return txFail("harness_not_ready", `OpenCode is installed but not ready: ${why.join("; ") || "required probes missing"}`)
        },
      }),
  }
}

/** The clock skew isHarnessReady tolerates (contracts/harness.ts). */
const CLOCK_SKEW_MS = 60_000

/** One probe kind present, passing and fresh (the same rule as isHarnessReady, for one kind). */
const passing = (v: HarnessVerification, kind: string, now: number) => {
  const probes = v.probes.filter((p) => p.kind === kind)
  return probes.length > 0 && probes.every((p) => p.ok && p.observedAt <= now + CLOCK_SKEW_MS && now - p.observedAt <= PROBE_MAX_AGE_MS)
}

/** The OpenCode executors to merge over builtinExecutors (see the integration notes in README.md). */
export function opencodeExecutors(options: {
  readonly adapter: HarnessAdapter
  readonly context: () => AdapterContext
  readonly authority?: PathRef
  readonly onVerification?: (verification: HarnessVerification) => void
} & ReadinessGate): Pick<ExecutorMap, "register-mcp-server" | "verify-harness"> {
  return {
    "register-mcp-server": opencodeMcpExecutor(options.authority ? { authority: options.authority } : {}),
    "verify-harness": opencodeVerifyExecutor(options),
  }
}
