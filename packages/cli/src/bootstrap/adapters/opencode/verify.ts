// OpenCode readiness (contract §3.10, T14): real probes, never presence.
//
//   version-exec     the binary itself (hub's `current` version, else what the PATH entry resolves to; never a
//                    container shim, which would test another environment) runs `opencode --version` and reports
//                    OpenCode 2 (and the pinned version, when hub installed it).
//   provider-auth    `opencode models` answers with at least one provider/model: the user's providers load and
//                    list models with the user's own, user-local configuration and credentials. It sends no prompt
//                    (it costs nothing). A stronger probe (a real completion) can be injected.
//   spoke-connected  the hub sees this machine's OpenCode spoke (an injected client: the integrator asks the hub with
//                    the machine credential; without one this probe fails, so the harness is never ready by default).
//
// Every process is a fixed argv of the harness binary (OPENCODE_PROBE_ARGV) run through an injected ProcessRunner:
// no shell, no command from a plan, an absolute file, bounded time and output. Probe details are built here (a
// version, counts, an exit status), never the harness's raw output, and anything credential-shaped is withheld.
import { execFile } from "node:child_process"
import { compareVersions, executionContextOf, isSecretValue, REQUIRED_PROBES, rootPathIn, SEMVER, type AdapterContext, type HarnessVerification, type Probe } from "../../contracts/index.ts"
import { discover } from "../../discovery/discover.ts"
import type { DiscoveryProbe } from "../../discovery/probe.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"
import { OPENCODE_BINARY_REL } from "./archive.ts"
import { MIN_OPENCODE_VERSION } from "./plan.ts"

/** The only argv the adapter ever runs (after the absolute binary path). */
export const OPENCODE_PROBE_ARGV = Object.freeze({ version: Object.freeze(["--version"]), models: Object.freeze(["models"]) }) as {
  readonly version: readonly string[]
  readonly models: readonly string[]
}

export interface ProcessRequest {
  /** Absolute path of the harness binary. */
  readonly file: string
  readonly argv: readonly string[]
  /** The user's own environment (provider configuration stays user-local; nothing here is recorded). */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
}

export interface ProcessOutcome {
  /** null when it was killed (timeout, signal). */
  readonly exitCode: number | null
  readonly stdout: string
  /** Read only to recognise the cold-start activation failure (ACTIVATION_FAILURE); never reported raw. */
  readonly stderr?: string
  readonly timedOut: boolean
}

/** Runs one fixed argv without a shell. Tests inject fakes; the CLI injects nodeProcessRunner. */
export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessOutcome>
}

/** child_process.execFile with shell: false, bounded output and time; stdin closed. */
export const nodeProcessRunner: ProcessRunner = {
  run: (request) =>
    new Promise((resolve, reject) => {
      if (!request.file.startsWith("/")) return reject(new Error("the harness binary must be an absolute path"))
      const env = Object.fromEntries(Object.entries(request.env).filter((e): e is [string, string] => typeof e[1] === "string"))
      const child = execFile(
        request.file,
        [...request.argv],
        { shell: false, env, timeout: request.timeoutMs, maxBuffer: request.maxOutputBytes, encoding: "utf8", windowsHide: true, ...(request.signal ? { signal: request.signal } : {}) },
        (error, stdout, stderr) => {
          const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
          if (e && typeof e.code === "string" && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(e)
          resolve({ exitCode: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(e?.killed) })
        },
      )
      child.stdin?.end()
    }),
}

/** A provider probe beyond the default model listing (e.g. a real, tiny completion), injected by the integrator. */
export type ProviderProbe = (input: { readonly binary: string; readonly context: AdapterContext; readonly runner: ProcessRunner }) => Promise<{ readonly ok: boolean; readonly detail?: string }>

/** Whether the hub sees this machine's OpenCode spoke; the integrator asks the hub with the machine credential. */
export interface SpokeProbe {
  connected(input: { readonly harness: "opencode"; readonly context: AdapterContext }): Promise<{ readonly ok: boolean; readonly detail?: string }>
}

export interface OpencodeVerifyOptions {
  readonly runner: ProcessRunner
  /** The binary to probe (locateOpencodeBinary); undefined: not found, so every probe fails. */
  readonly binary: string | undefined
  readonly spoke?: SpokeProbe
  readonly provider?: ProviderProbe
  /** The version hub installed and made current; the binary must report exactly it. */
  readonly expectVersion?: string
  readonly versionTimeoutMs?: number
  readonly providerTimeoutMs?: number
  /** The pause before the one retry after a cold-start activation failure (default 1 s). */
  readonly activationRetryDelayMs?: number
}

/**
 * OpenCode 2's CLI gives a location's plugins ~5 s to activate in its background service, then fails with HTTP 503
 * "Location plugins did not finish activating". On the first use of a directory (plugins loaded cold, MCP servers
 * connecting) that can happen once; the service keeps activating, so the probe tries again once.
 */
export const ACTIVATION_FAILURE = /did not finish activating/i
const ACTIVATION_RETRY_DELAY_MS = 1000

const VERSION_TIMEOUT_MS = 15_000
const PROVIDER_TIMEOUT_MS = 90_000
const MAX_OUTPUT = 1024 * 1024
const VERSION_IN = /(?:^|[^0-9.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/
const MODEL_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/

/** One line for people; anything credential-shaped is withheld. */
const safe = (detail: string): string => (isSecretValue(detail) ? "(details withheld: they looked like they carried a credential)" : detail.replace(/\s+/g, " ").trim().slice(0, 200))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function runOnce(options: OpencodeVerifyOptions, context: AdapterContext, argv: readonly string[], timeoutMs: number): Promise<ProcessOutcome | string> {
  try {
    return await options.runner.run({ file: options.binary!, argv, env: context.env, timeoutMs, maxOutputBytes: MAX_OUTPUT, ...(context.signal ? { signal: context.signal } : {}) })
  } catch (error) {
    return `could not run ${options.binary}: ${errorText(error)}`
  }
}

const coldStart = (r: ProcessOutcome | string): boolean => typeof r !== "string" && r.exitCode !== 0 && ACTIVATION_FAILURE.test(`${r.stderr ?? ""}\n${r.stdout}`)

/** Runs one probe argv; a cold-start activation failure is retried once (ACTIVATION_FAILURE). */
async function run(options: OpencodeVerifyOptions, context: AdapterContext, argv: readonly string[], timeoutMs: number): Promise<ProcessOutcome | string> {
  const first = await runOnce(options, context, argv, timeoutMs)
  if (!coldStart(first) || context.signal?.aborted) return first
  const delay = options.activationRetryDelayMs ?? ACTIVATION_RETRY_DELAY_MS
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  return runOnce(options, context, argv, timeoutMs)
}

const failedRun = (r: ProcessOutcome) =>
  r.timedOut ? "timed out" : r.exitCode === null ? "was killed" : `exited ${r.exitCode}${coldStart(r) ? " (OpenCode's plugins did not finish activating in time, twice: start OpenCode once, then verify again)" : ""}`

async function versionProbe(options: OpencodeVerifyOptions, context: AdapterContext): Promise<Omit<Probe, "observedAt">> {
  const r = await run(options, context, OPENCODE_PROBE_ARGV.version, options.versionTimeoutMs ?? VERSION_TIMEOUT_MS)
  if (typeof r === "string") return { kind: "version-exec", ok: false, detail: r }
  if (r.exitCode !== 0) return { kind: "version-exec", ok: false, detail: `opencode --version ${failedRun(r)}` }
  const version = VERSION_IN.exec(r.stdout)?.[1]
  if (!version || !SEMVER.test(version)) return { kind: "version-exec", ok: false, detail: "opencode --version printed no version" }
  if (compareVersions(version, MIN_OPENCODE_VERSION) < 0) return { kind: "version-exec", ok: false, detail: `opencode ${version} is older than ${MIN_OPENCODE_VERSION} (the Hub plugin needs OpenCode 2)` }
  if (options.expectVersion && version !== options.expectVersion) return { kind: "version-exec", ok: false, detail: `opencode ${version} runs, but hub made ${options.expectVersion} current` }
  return { kind: "version-exec", ok: true, detail: `opencode ${version}` }
}

async function providerProbe(options: OpencodeVerifyOptions, context: AdapterContext): Promise<Omit<Probe, "observedAt">> {
  if (options.provider) {
    try {
      const r = await options.provider({ binary: options.binary!, context, runner: options.runner })
      return { kind: "provider-auth", ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) }
    } catch (error) {
      return { kind: "provider-auth", ok: false, detail: `the provider probe failed: ${errorText(error)}` }
    }
  }
  const r = await run(options, context, OPENCODE_PROBE_ARGV.models, options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS)
  if (typeof r === "string") return { kind: "provider-auth", ok: false, detail: r }
  if (r.exitCode !== 0) return { kind: "provider-auth", ok: false, detail: `opencode models ${failedRun(r)}` }
  const models = r.stdout.split("\n").map((l) => l.trim()).filter((l) => MODEL_LINE.test(l))
  if (models.length === 0) return { kind: "provider-auth", ok: false, detail: "opencode lists no models: sign in to a provider (opencode auth login) or configure one" }
  const providers = new Set(models.map((m) => m.slice(0, m.indexOf("/"))))
  return { kind: "provider-auth", ok: true, detail: `${models.length} models from ${providers.size} providers` }
}

async function spokeProbe(options: OpencodeVerifyOptions, context: AdapterContext): Promise<Omit<Probe, "observedAt">> {
  if (!options.spoke) return { kind: "spoke-connected", ok: false, detail: "no hub spoke probe is configured" }
  try {
    const r = await options.spoke.connected({ harness: "opencode", context })
    return { kind: "spoke-connected", ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) }
  } catch (error) {
    return { kind: "spoke-connected", ok: false, detail: `the hub could not be asked: ${errorText(error)}` }
  }
}

/** Runs the required probes and reports each, passing or not (HarnessAdapter.verify). */
export async function verifyOpencode(context: AdapterContext, options: OpencodeVerifyOptions): Promise<HarnessVerification> {
  let results: Omit<Probe, "observedAt">[]
  if (!options.binary) {
    results = REQUIRED_PROBES.opencode.map((kind) => ({ kind, ok: false, detail: "OpenCode was not found on this host" }))
  } else {
    // Each probe on its own, so the report names every problem at once.
    results = [await versionProbe(options, context), await providerProbe(options, context), await spokeProbe(options, context)]
  }
  const observedAt = context.now()
  return { harness: "opencode", probes: results.map((p) => ({ ...p, observedAt, ...(p.detail !== undefined ? { detail: safe(p.detail) } : {}) })) }
}

/**
 * The binary to probe on this host: hub's `current` OpenCode (through the link, to its version directory), else the
 * one on PATH, followed to what it resolves to. A container shim is refused: running it would test the container,
 * not this host (contract §3.10: version-exec runs what the shim resolves to, and that is not here).
 */
export function locateOpencodeBinary(probe: DiscoveryProbe): TxResult<string> {
  const snap = discover(probe, { now: 0 })
  if (!snap.ok) return txFail("invalid", "this host could not be discovered")
  const data = snap.value.roots.find((r) => r.id === "data")
  const base = data ? rootPathIn(data, executionContextOf(snap.value)) : undefined
  if (base) {
    const current = probe.realpath(`${base}/hub/harnesses/opencode/current/${OPENCODE_BINARY_REL}`)
    if (current && probe.executable(current)) return txOk(current)
  }
  const presence = snap.value.harnesses.find((h) => h.id === "opencode")
  if (!presence?.installed || !presence.path) return txFail("not_found", "OpenCode is not installed on this host")
  const shim = snap.value.topology.shims.find((s) => s.name === "opencode" && s.path === presence.path)
  if (shim?.kind === "container-shim") return txFail("not_found", `${presence.path} runs OpenCode in a container${shim.resolvesTo ? ` (${shim.resolvesTo})` : ""}; verify it there`)
  const target = shim?.resolvesTo ?? presence.path
  return probe.executable(target) ? txOk(target) : txFail("not_found", `${target} is not an executable on this host`)
}
