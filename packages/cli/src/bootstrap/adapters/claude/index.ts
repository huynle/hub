// The Claude Code bootstrap adapter (HBS-08): planning and discovery (adapter.ts), the pinned-artifact source with
// optional upstream evidence (source.ts, openpgp.ts), real readiness probes (verify.ts), and the injected ports
// (ports.ts) with their default Node implementations (node.ts). Integration into the CLI is HBS-13's.
import type { HarnessVerification } from "../../contracts/index.ts"
import { installHarnessExecutor, type HarnessSource } from "../../transaction/builtin.ts"
import type { ActionExecutor } from "../../transaction/executor.ts"
import { claudeVerifyExecutor } from "./verify.ts"

export * from "./adapter.ts"
export * from "./node.ts"
export * from "./openpgp.ts"
export * from "./ports.ts"
export * from "./source.ts"
export * from "./verify.ts"

export interface ClaudeExecutorOptions {
  /** createClaudeHarnessSource(...) */
  readonly source: HarnessSource
  /** adapter.verify(context) */
  readonly verify: () => Promise<HarnessVerification>
  readonly now: () => number
  readonly onVerified?: (verification: HarnessVerification) => void
}

/**
 * The executors the Claude Code plan needs beyond the built-in local ones: install-harness from the Claude Code
 * source, and verify-harness for claude-code. The engine has one executor per kind, so with several harnesses the
 * integrator dispatches these by `action.harness` (HBS-13).
 */
export function claudeExecutors(options: ClaudeExecutorOptions): { readonly "install-harness": ActionExecutor<"install-harness">; readonly "verify-harness": ActionExecutor<"verify-harness"> } {
  return {
    "install-harness": installHarnessExecutor(options.source),
    "verify-harness": claudeVerifyExecutor({ verify: options.verify, now: options.now, ...(options.onVerified ? { onVerified: options.onVerified } : {}) }),
  }
}
