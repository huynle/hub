// Claude Code readiness (contracts §3.10): REQUIRED_PROBES["claude-code"], each real, passing and fresh.
//
//   version-exec     the binary hub resolved (hub's current version, or the program a wrapper or link resolves to;
//                    never just the shim on PATH) runs `claude --version` (fixed argv, minimal environment, updates
//                    switched off) and prints the expected version.
//   provider-auth    `claude auth status` (fixed argv) exits 0 with a login method: the user's own login, made by
//                    the user on this machine (`claude auth login`). hubctl never reads, copies or keeps a Claude
//                    credential: the probe's output is parsed for the login method only and then dropped, and the
//                    child gets the user's environment minus hub's own variables.
//   spoke-connected  the injected spoke probe sees the claude-code hooks spoke connected, and the injected
//                    conformance probe passes. Both are required: without either, the harness is not ready.
//
// Not ready means no capability: claudeReadiness offers "claude-code" only when every probe passes, and the
// verify-harness step fails with harness_not_ready otherwise (so the transaction rolls back).
import { isHarnessReady, type AdapterContext, type HarnessVerification, type Probe } from "../../contracts/index.ts"
import type { ActionExecutor } from "../../transaction/executor.ts"
import { txFail, txOk } from "../../transaction/result.ts"
import type { ProbeRunner, RunResult } from "./ports.ts"

export const VERSION_ARGV: readonly string[] = Object.freeze(["--version"])
export const AUTH_STATUS_ARGV: readonly string[] = Object.freeze(["auth", "status"])
/** Upstream's documented login methods (`claude auth status` JSON `authMethod`), "none" excluded. */
export const AUTH_METHODS: readonly string[] = ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"]
/** What the spoke must be (packages/claude-code daemon: harness claude-code, evidence hooks). */
export const CLAUDE_SPOKE = { harness: "claude-code", evidence: "hooks" } as const

const VERSION_TIMEOUT_MS = 15_000
const AUTH_TIMEOUT_MS = 30_000
const OUTPUT_MAX = 64 << 10
const NO_UPDATES = { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" } as const

/** The binary to verify, or why there is none. */
export type ClaudeBinary = { readonly path: string; readonly version?: string } | { readonly problem: string }

export interface SpokeHello {
  readonly connected: boolean
  readonly harness?: string
  readonly evidence?: string
  readonly features?: readonly string[]
}

export interface ClaudeProbes {
  readonly runner: ProbeRunner
  readonly binary: () => ClaudeBinary
  /** Is the claude-code spoke connected to the hub (HBS-13: the daemon socket or the hub's machine view)? */
  readonly spoke?: () => Promise<SpokeHello>
  /** Does the connected spoke pass conformance? */
  readonly conformance?: () => Promise<{ readonly ok: boolean; readonly detail?: string }>
}

const line = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200)
const why = (r: RunResult) => (r.kind === "exited" ? `exit ${r.code}` : r.kind === "error" ? "could not start" : r.kind)

/** The user's environment for a probe, minus hub's own variables, with updates switched off. */
function userEnv(env: AdapterContext["env"]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith("HUB_") && k !== "BUN_BE_BUN") out[k] = v
  return { ...out, ...NO_UPDATES }
}

async function versionProbe(probes: ClaudeProbes, ctx: AdapterContext, bin: { path: string; version?: string }): Promise<Omit<Probe, "observedAt">> {
  const env = { PATH: ctx.env.PATH ?? "/usr/bin:/bin", HOME: ctx.home, ...NO_UPDATES }
  const r = await probes.runner.run(bin.path, VERSION_ARGV, { env, timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: OUTPUT_MAX })
  if (r.kind !== "exited" || r.code !== 0) return { kind: "version-exec", ok: false, detail: `${bin.path} --version did not run (${why(r)})` }
  const version = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(r.stdout)?.[1]
  if (!version) return { kind: "version-exec", ok: false, detail: `${bin.path} --version printed no version` }
  if (bin.version && version !== bin.version) return { kind: "version-exec", ok: false, detail: `${bin.path} is ${version}, not the expected ${bin.version}` }
  return { kind: "version-exec", ok: true, detail: `${version} at ${bin.path}` }
}

async function authProbe(probes: ClaudeProbes, ctx: AdapterContext, bin: { path: string }): Promise<Omit<Probe, "observedAt">> {
  const login = "not logged in: log in on this machine yourself (`claude auth login`, or run `claude`)"
  const r = await probes.runner.run(bin.path, AUTH_STATUS_ARGV, { env: userEnv(ctx.env), timeoutMs: AUTH_TIMEOUT_MS, maxOutputBytes: OUTPUT_MAX })
  if (r.kind !== "exited") return { kind: "provider-auth", ok: false, detail: `claude auth status did not run (${why(r)})` }
  if (r.code !== 0) return { kind: "provider-auth", ok: false, detail: login }
  // Only the login method is read; everything else the command printed is dropped here.
  let method: unknown
  try {
    method = (JSON.parse(r.stdout) as { authMethod?: unknown }).authMethod
  } catch {}
  if (method === "none") return { kind: "provider-auth", ok: false, detail: login }
  return { kind: "provider-auth", ok: true, detail: typeof method === "string" && AUTH_METHODS.includes(method) ? `logged in (${method})` : "logged in" }
}

async function spokeProbe(probes: ClaudeProbes): Promise<Omit<Probe, "observedAt">> {
  const fail = (detail: string) => ({ kind: "spoke-connected" as const, ok: false, detail })
  if (!probes.spoke) return fail("no spoke probe in this hubctl")
  if (!probes.conformance) return fail("no conformance probe in this hubctl")
  let hello: SpokeHello
  try {
    hello = await probes.spoke()
  } catch {
    return fail("the claude-code spoke could not be reached")
  }
  if (!hello.connected) return fail("the claude-code spoke is not connected to the hub (is the daemon running and the machine enrolled?)")
  if (hello.harness !== CLAUDE_SPOKE.harness || hello.evidence !== CLAUDE_SPOKE.evidence) return fail(`the connected spoke is ${hello.harness ?? "?"}/${hello.evidence ?? "?"}, not ${CLAUDE_SPOKE.harness}/${CLAUDE_SPOKE.evidence}`)
  try {
    const c = await probes.conformance()
    if (!c.ok) return fail(`spoke conformance failed${c.detail ? `: ${c.detail}` : ""}`)
  } catch {
    return fail("spoke conformance could not run")
  }
  return { kind: "spoke-connected", ok: true, detail: "claude-code hooks spoke connected and conformant" }
}

/** Runs every required probe (passing or not) and reports each. */
export async function verifyClaude(probes: ClaudeProbes, ctx: AdapterContext): Promise<HarnessVerification> {
  const bin = probes.binary()
  const found: Omit<Probe, "observedAt">[] = []
  if ("problem" in bin) {
    found.push({ kind: "version-exec", ok: false, detail: bin.problem }, { kind: "provider-auth", ok: false, detail: `not checked: ${bin.problem}` })
  } else {
    found.push(await versionProbe(probes, ctx, bin), await authProbe(probes, ctx, bin))
  }
  found.push(await spokeProbe(probes))
  const observedAt = ctx.now()
  return { harness: "claude-code", probes: found.map((p) => ({ ...p, detail: line(p.detail ?? ""), observedAt })) }
}

export interface ClaudeReadiness {
  readonly ready: boolean
  /** Offered only when ready. */
  readonly capability?: "claude-code"
  readonly problems: readonly string[]
}

export function claudeReadiness(verification: HarnessVerification, now: number): ClaudeReadiness {
  const ready = verification.harness === "claude-code" && isHarnessReady(verification, now)
  const problems = verification.probes.filter((p) => !p.ok).map((p) => `${p.kind}: ${p.detail ?? "failed"}`)
  if (ready) return { ready, capability: "claude-code", problems: [] }
  return { ready, problems: problems.length > 0 ? problems : ["the probes are missing or stale"] }
}

export interface ClaudeVerifyOptions {
  readonly verify: () => Promise<HarnessVerification>
  readonly now: () => number
  /** Sees every verification (ready or not), e.g. to record it or offer the capability. */
  readonly onVerified?: (verification: HarnessVerification) => void
}

/** The verify-harness step for claude-code: an external effect that fails unless the harness is ready. */
export function claudeVerifyExecutor(options: ClaudeVerifyOptions): ActionExecutor<"verify-harness"> {
  return {
    kind: "verify-harness",
    plan: () => ({ class: "external" }),
    check: async (action) => (action.harness === "claude-code" ? txOk(undefined) : txFail("internal", `the Claude Code verifier cannot verify ${action.harness}`)),
    change: async () =>
      txOk({
        type: "effect",
        perform: async () => {
          const verification = await options.verify()
          options.onVerified?.(verification)
          const readiness = claudeReadiness(verification, options.now())
          return readiness.ready ? txOk(undefined) : txFail("harness_not_ready", `Claude Code is not ready: ${readiness.problems.join("; ")}`)
        },
      }),
  }
}
