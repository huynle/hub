// What the OpenCode adapter gives the transactional applier (transaction/executor.ts): the HarnessSource for its
// pinned downloads and the executors for the two action kinds the built-ins leave to adapters.
//
//   HarnessSource        fetch: exactly the URL hub's verified manifest pins (checkHarnessPin), bounded by the
//                        pinned size, over https only; OpenCode publishes no upstream evidence, so only the pinned
//                        digest vouches for the bytes (installHarnessExecutor checks it before unpack is called).
//                        unpack: archive.ts (pure).
//   register-mcp-server  hubctl's `mcp` at the stable authority under mcp.servers.hub, decided from the file as it is
//                        at apply (config.ts) and spliced in by the lossless JSONC merge; only while the file is as
//                        previewed (precondition); a foreign "hub" server is a conflict. Journal class config: backed up,
//                        so a rollback restores it unless the user changed it since.
//   verify-harness       runs the adapter's real probes; anything short of isHarnessReady fails the apply
//                        (harness_not_ready), which rolls the transaction back.
import {
  checkHarnessPin,
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
import { unpackOpencodeArchive } from "./archive.ts"
import { mcpServerSets } from "./config.ts"
import { checkAuthority, DEFAULT_AUTHORITY } from "./plan.ts"

// ---------- downloads ----------

export interface DownloadLimits {
  /** The pinned size: a longer body is refused while it streams. */
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

/** Fetches bytes (no verification: the executor checks them against the pin). */
export type Download = (url: string, limits: DownloadLimits) => Promise<Uint8Array>

/** A Download over fetch: https only (every hop: the final URL too), refused once it exceeds the limit. */
export function httpsDownload(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Download {
  return async (url, limits) => {
    if (!url.startsWith("https://")) throw new Error(`refusing to download ${url}: https only`)
    const response = await fetchImpl(url, { redirect: "follow", ...(limits.signal ? { signal: limits.signal } : {}) })
    if (response.url && !response.url.startsWith("https://")) throw new Error(`refusing ${url}: it redirected to a non-https location`)
    if (!response.ok) throw new Error(`download of ${url} failed: HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > limits.maxBytes) throw new Error(`${url} is larger than the pinned ${limits.maxBytes} bytes`)
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = response.body?.getReader()
    if (reader)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limits.maxBytes) {
          await reader.cancel()
          throw new Error(`${url} is larger than the pinned ${limits.maxBytes} bytes`)
        }
        chunks.push(value)
      }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
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
    async fetch(action: InstallHarness) {
      onlyOpencode(action.harness)
      const pin = checkHarnessPin(options.manifest, action)
      if (!pin.ok) throw new Error(`refusing to download ${action.source.url}: it is not the artifact hub ${options.manifest.release} pins (${pin.issues[0]!.message})`)
      const bytes = await options.download(pin.value.url, { maxBytes: pin.value.size })
      // OpenCode publishes no signatures (contract §5): there is no upstream evidence to attempt.
      return { bytes, evidence: [] }
    },
    unpack: async (action, bytes) => (action.harness === "opencode" ? unpackOpencodeArchive(action.source.file, bytes) : txFail("invalid", `the OpenCode harness source cannot unpack ${action.harness}`)),
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

/** verify-harness for OpenCode: the adapter's real probes must make it ready (isHarnessReady), else the apply fails. */
export function opencodeVerifyExecutor(options: {
  readonly adapter: HarnessAdapter
  readonly context: () => AdapterContext
  /** Sees every verification (for the apply report); cannot change it. */
  readonly onVerification?: (verification: HarnessVerification) => void
}): ActionExecutor<"verify-harness"> {
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
          // Every required probe (isHarnessReady) and every probe the action asks for: present, passing, fresh.
          const missing = action.probes.filter((kind) => !passing(verification, kind, now))
          if (verification.harness === "opencode" && isHarnessReady(verification, now) && missing.length === 0) return txOk(undefined)
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
}): Pick<ExecutorMap, "register-mcp-server" | "verify-harness"> {
  return {
    "register-mcp-server": opencodeMcpExecutor(options.authority ? { authority: options.authority } : {}),
    "verify-harness": opencodeVerifyExecutor(options),
  }
}
