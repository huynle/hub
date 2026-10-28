// Codex verification (HarnessAdapter.verify) and its explicit capability advertisement. Readiness comes only from
// real probes run through injected, typed capabilities (no shell, no generic exec):
//
//   version-exec     ProbeRunner runs the fixed word list [<binary>, "--version"] against the resolved binary (hub's
//                    current version, or what a shim resolves to, never just the shim) and must print the expected
//                    version.
//   api-health       AppServerLauncher starts `<binary> app-server --listen stdio://` (the same app-server the Codex
//                    spoke uses) and the spoke's own openAppServer handshake (initialize, initialized) must succeed.
//   provider-auth    over that connection, account/read (refreshToken: true) must report an account, and a live
//                    request must succeed: for a ChatGPT account account/rateLimits/read, which reaches OpenAI's
//                    backend; other account types need an injected providerProbe (a bounded turn, say) and are not
//                    ready without one. Authentication stays with the user: hub asks the app-server and never reads
//                    ~/.codex; a missing login says to run `codex login` on the machine.
//   spoke-connected  SpokeStatus (the hub's view of this machine's Codex spoke) must report it connected.
//
// Probes run with a minimal environment (PATH, HOME, CODEX_HOME, locale): never the hub token or a provider key. A
// probe's detail is one short line with emails and credential-shaped words removed. codexCapabilities advertises
// Codex as ready only when isHarnessReady holds and its app-server answered, each probe fresh.
import { execFile } from "node:child_process"
import { openAppServer } from "../../../../../codex/src/app-server.ts"
import type { Channel } from "../../../../../codex/src/jsonrpc.ts"
import { spawnStdioChannel } from "../../../../../codex/src/stdio.ts"
import {
  compareVersions,
  executionContextOf,
  isHarnessReady,
  isSecretValue,
  PROBE_MAX_AGE_MS,
  rootPathIn,
  SEMVER,
  type AdapterContext,
  type DiscoverySnapshot,
  type HarnessVerification,
  type Probe,
  type ProbeKind,
} from "../../contracts/index.ts"
import type { ActionExecutor } from "../../transaction/executor.ts"
import { txFail, txOk } from "../../transaction/result.ts"

export interface ProbeResult {
  /** null: it could not be started (or was killed). */
  readonly exitCode: number | null
  readonly stdout: string
  readonly error?: string
}

/** Runs one fixed word list (never a shell string), bounded in time and output. */
export interface ProbeRunner {
  run(argv: readonly string[], options: { readonly env: Record<string, string>; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<ProbeResult>
}

/** Starts `<binary> app-server --listen stdio://` and gives its stdio as a channel. */
export interface AppServerLauncher {
  start(binary: string, env: Record<string, string>): { readonly channel: Channel; stop(): void }
}

/** The hub's view of this machine's Codex spoke (HBS-13: the hub API, authenticated as this machine). */
export interface SpokeStatus {
  codex(): Promise<{ readonly connected: boolean; readonly detail?: string }>
}

export interface CodexProbes {
  readonly runner: ProbeRunner
  readonly appServer: AppServerLauncher
  readonly spoke: SpokeStatus
  /** The binary to probe (codexBinaryPath), or undefined when there is none. */
  readonly binary: () => string | undefined
  /** hubctl's version, as the app-server client's. */
  readonly clientVersion: string
  /** The version the plan made current; another version fails version-exec. */
  readonly expectedVersion?: string
  /** Per probe; default 20 s. */
  readonly timeoutMs?: number
  /** A live provider check for account types without one through the app-server (apiKey, amazonBedrock, gcp). */
  readonly providerProbe?: (account: { readonly type: string }) => Promise<{ readonly ok: boolean; readonly detail?: string }>
}

const DEFAULT_TIMEOUT_MS = 20_000
const PASSED_ENV = ["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "TMPDIR"] as const
const VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/

/** The environment a probe gets: only what Codex needs to find itself and its home. */
export function probeEnv(env: AdapterContext["env"]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PASSED_ENV) if (env[key] !== undefined) out[key] = env[key]!
  return out
}

/** One short line, without emails or anything credential-shaped. */
function line(text: string): string {
  const words = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .split(/\s+/)
    .map((w) => (isSecretValue(w) || /^(?:sk|mt|hat|hlt1|hst1)[-_.]/i.test(w) ? "[redacted]" : w))
    .join(" ")
    .trim()
  return words.length > 160 ? `${words.slice(0, 157)}...` : words || "(no detail)"
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function verifyCodex(ctx: AdapterContext, p: CodexProbes): Promise<HarnessVerification> {
  const probes: Probe[] = []
  const record = (kind: ProbeKind, ok: boolean, detail: string) => probes.push({ kind, ok, observedAt: ctx.now(), detail: line(detail) })
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env = probeEnv(ctx.env)
  const binary = p.binary()

  if (!binary) {
    for (const kind of ["version-exec", "api-health", "provider-auth", "spoke-connected"] as const) record(kind, false, "no Codex binary to run (not installed)")
    return { harness: "codex", probes }
  }
  // 1. The binary runs and is the expected version.
  let runs = false
  try {
    const r = await p.runner.run([binary, "--version"], { env, timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const version = VERSION.exec(r.stdout)?.[1]
    runs = r.exitCode === 0 && version !== undefined
    if (!runs) record("version-exec", false, `${binary} --version ${r.exitCode === null ? `did not run (${r.error ?? "no exit code"})` : `exited ${r.exitCode}`}`)
    else if (p.expectedVersion && SEMVER.test(version!) && compareVersions(version!, p.expectedVersion) !== 0) record("version-exec", false, `codex runs ${version}, but ${p.expectedVersion} is current`)
    else record("version-exec", true, `codex-cli ${version}`)
  } catch (cause) {
    record("version-exec", false, `${binary} --version did not run (${message(cause)})`)
  }

  // 2 and 3. Its app-server answers; its provider account is ready.
  if (!runs) {
    record("api-health", false, "skipped: the Codex binary does not run")
    record("provider-auth", false, "skipped: the Codex binary does not run")
  } else await appServerProbes(binary, env, timeoutMs, p, record)

  // 4. The hub sees this machine's Codex spoke.
  try {
    const s = await withTimeout(p.spoke.codex(), timeoutMs, "the hub")
    record("spoke-connected", s.connected, s.detail ?? (s.connected ? "the hub sees the Codex spoke" : "the hub does not see this machine's Codex spoke (is hub codex-spoke running?)"))
  } catch (cause) {
    record("spoke-connected", false, `the hub could not be asked (${message(cause)})`)
  }
  return { harness: "codex", probes }
}

async function appServerProbes(binary: string, env: Record<string, string>, timeoutMs: number, p: CodexProbes, record: (kind: ProbeKind, ok: boolean, detail: string) => void) {
  let handle: ReturnType<AppServerLauncher["start"]>
  try {
    handle = p.appServer.start(binary, env)
  } catch (cause) {
    record("api-health", false, `the app-server did not start (${message(cause)})`)
    record("provider-auth", false, "skipped: no app-server")
    return
  }
  try {
    let conn: Awaited<ReturnType<typeof openAppServer>>
    try {
      conn = await withTimeout(openAppServer(handle.channel, { name: "hub-verify", clientVersion: p.clientVersion, timeoutMs }), timeoutMs + 1000, "the app-server")
      record("api-health", true, "the app-server answered initialize")
    } catch (cause) {
      record("api-health", false, `the app-server did not initialize (${message(cause)})`)
      record("provider-auth", false, "skipped: no app-server")
      return
    }
    try {
      const read = (await conn.peer.request("account/read", { refreshToken: true }, { timeoutMs })) as { account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown } | null
      const type = typeof read?.account?.type === "string" ? read.account.type : undefined
      if (!type) {
        record("provider-auth", false, read?.requiresOpenaiAuth === false ? "no OpenAI account is needed, but no live provider check is available; readiness needs one" : "Codex is not logged in: run `codex login` on this machine")
        return
      }
      if (type === "chatgpt") {
        await conn.peer.request("account/rateLimits/read", undefined, { timeoutMs })
        record("provider-auth", true, "chatgpt account ready (live rate-limit request answered)")
      } else if (p.providerProbe) {
        const r = await withTimeout(p.providerProbe({ type }), timeoutMs, "the provider check")
        record("provider-auth", r.ok, `${type} account ${r.ok ? "ready" : "not ready"}${r.detail ? ` (${r.detail})` : ""}`)
      } else record("provider-auth", false, `${type} account found, but no live provider check is configured for it`)
    } catch (cause) {
      record("provider-auth", false, `the provider check failed (${message(cause)})`)
    }
  } finally {
    handle.stop()
  }
}

/** What hub advertises for Codex: each capability only from a fresh passing probe. */
export interface CodexCapabilities {
  readonly harness: "codex"
  readonly ready: boolean
  readonly version?: string
  readonly appServer: boolean
  readonly provider?: string
  readonly spoke: boolean
  /** The oldest probe it rests on. */
  readonly observedAt?: number
}

export function codexCapabilities(v: HarnessVerification, now: number): CodexCapabilities {
  const fresh = (kind: ProbeKind) => {
    const ps = v.probes.filter((x) => x.kind === kind)
    return ps.length > 0 && ps.every((x) => x.ok && x.observedAt <= now + 60_000 && now - x.observedAt <= PROBE_MAX_AGE_MS) ? ps[ps.length - 1] : undefined
  }
  const version = fresh("version-exec")?.detail && VERSION.exec(fresh("version-exec")!.detail!)?.[1]
  const provider = fresh("provider-auth")?.detail?.split(" ")[0]
  const appServer = fresh("api-health") !== undefined
  const observed = v.probes.map((x) => x.observedAt)
  return {
    harness: "codex",
    ready: v.harness === "codex" && isHarnessReady(v, now) && appServer,
    ...(version ? { version } : {}),
    appServer,
    ...(provider ? { provider } : {}),
    spoke: fresh("spoke-connected") !== undefined,
    ...(observed.length > 0 ? { observedAt: Math.min(...observed) } : {}),
  }
}

/**
 * The binary verification runs: hub's current version (data:hub/harnesses/codex/current/bin/codex) when hub
 * installs or installed Codex, else what the discovered shim resolves to (contract §3.10), else its path.
 */
export function codexBinaryPath(snapshot: DiscoverySnapshot, options: { readonly preferHub: boolean }): string | undefined {
  const found = snapshot.harnesses.find((h) => h.id === "codex")
  const data = snapshot.roots.find((r) => r.id === "data")
  if (data && (options.preferHub || found?.installMethod === "hub")) return `${rootPathIn(data, executionContextOf(snapshot))}/hub/harnesses/codex/current/bin/codex`
  if (!found?.installed || !found.path) return undefined
  const shim = snapshot.topology.shims.find((s) => s.path === found.path)
  return shim?.resolvesTo ?? found.path
}

/** The verify-harness executor for Codex: runs verify and refuses (harness_not_ready) unless Codex is advertised ready. */
export function codexVerifyExecutor(options: {
  readonly verify: (ctx: AdapterContext) => Promise<HarnessVerification>
  readonly context: () => AdapterContext
  /** Receives each verification (the capability advertisement, the apply report). */
  readonly onVerified?: (verification: HarnessVerification) => void
}): ActionExecutor<"verify-harness"> {
  const notCodex = (harness: string) => txFail("internal", `the Codex verifier cannot verify ${harness}`)
  return {
    kind: "verify-harness",
    plan: () => ({ class: "external" }),
    check: async (action) => (action.harness === "codex" ? txOk(undefined) : notCodex(action.harness)),
    change: async (action) =>
      action.harness !== "codex"
        ? notCodex(action.harness)
        : txOk({
            type: "effect",
            perform: async () => {
              const ctx = options.context()
              const v = await options.verify(ctx)
              options.onVerified?.(v)
              if (codexCapabilities(v, ctx.now()).ready) return txOk(undefined)
              const failing = v.probes.filter((x) => !x.ok).map((x) => `${x.kind}: ${x.detail ?? "failed"}`)
              return txFail("harness_not_ready", `Codex is not ready (${failing.join("; ") || "a probe is missing or stale"})`)
            },
          }),
  }
}

/** A ProbeRunner over execFile: the word list as is (no shell), bounded output and time. */
export const nodeProbeRunner: ProbeRunner = {
  run: (argv, options) =>
    new Promise((resolve) => {
      const [file, ...args] = argv
      if (!file) return resolve({ exitCode: null, stdout: "", error: "empty argv" })
      execFile(file, args, { env: options.env, timeout: options.timeoutMs, maxBuffer: 64 * 1024, shell: false, windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout) => {
        if (!error) return resolve({ exitCode: 0, stdout: String(stdout) })
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
        resolve(typeof code === "number" ? { exitCode: code, stdout: String(stdout ?? "") } : { exitCode: null, stdout: String(stdout ?? ""), error: message(error) })
      })
    }),
}

/** Starts the app-server with the packages/codex stdio channel (`argsBefore`: tests run a fake server script). */
export const stdioAppServerLauncher = (options: { readonly argsBefore?: readonly string[] } = {}): AppServerLauncher => ({
  start(binary, env) {
    const child = spawnStdioChannel({ command: binary, args: [...(options.argsBefore ?? []), "app-server", "--listen", "stdio://"], env })
    return { channel: child.channel, stop: () => child.channel.close() }
  },
})
