// Per-harness dispatch (HBS-13 integration item 1, adapter amendment A2). The engine holds one executor per action
// kind (ExecutorMap) and builtinExecutors one HarnessSource, but OpenCode, Claude Code and Codex each supply their own
// install-harness source and verify-harness (and OpenCode its register-mcp-server) executor. These route each step
// by `action.harness`. A harness nothing was registered for is refused with a typed failure at preflight, never
// thrown and never handed to another harness's executor.
import type { HarnessID, InstallHarness } from "../bootstrap/contracts/index.ts"
import type { HarnessSource } from "../bootstrap/transaction/builtin.ts"
import type { ActionExecutor, ActionOf, StepPlan } from "../bootstrap/transaction/executor.ts"
import { TxError, txFail, txOk } from "../bootstrap/transaction/result.ts"

/** The action kinds that name a harness. */
export type HarnessScopedKind = "install-harness" | "verify-harness" | "register-mcp-server"

const LABEL: Readonly<Record<HarnessScopedKind, string>> = {
  "install-harness": "installs",
  "verify-harness": "verifies",
  "register-mcp-server": "registers MCP servers with",
}

/** One executor of `kind` that hands each action to the executor registered for its harness. */
export function dispatchByHarness<K extends HarnessScopedKind>(kind: K, executors: Partial<Record<HarnessID, ActionExecutor<K>>>): ActionExecutor<K> {
  const harnessOf = (action: ActionOf<K>) => (action as { readonly harness: HarnessID }).harness
  const pick = (action: ActionOf<K>) => executors[harnessOf(action)]
  const missing = (action: ActionOf<K>) => txFail("internal", `this hubctl ${LABEL[kind]} no ${harnessOf(action)} (no executor for ${kind} on ${harnessOf(action)})`)
  // The journal class must not depend on what is registered: an unregistered harness keeps the kind's class.
  const fallback = (action: ActionOf<K>): StepPlan =>
    kind === "verify-harness" ? { class: "external" } : { class: kind === "install-harness" ? "harness" : "config", path: (action as { path: StepPlan["path"] }).path }
  return {
    kind,
    plan: (action) => pick(action)?.plan(action) ?? fallback(action),
    check: async (action, ctx) => {
      const exec = pick(action)
      if (!exec) return missing(action)
      return exec.check ? exec.check(action, ctx) : txOk(undefined)
    },
    change: async (action, ctx) => {
      const exec = pick(action)
      return exec ? exec.change(action, ctx) : missing(action)
    },
    undo: async (action, ctx) => {
      const exec = pick(action)
      if (!exec) return missing(action)
      return exec.undo ? exec.undo(action, ctx) : txOk(undefined)
    },
  }
}

export interface HarnessSources {
  /** The verified hub manifest every source pins against (one per release). */
  readonly manifest: HarnessSource["manifest"]
  readonly sources: Partial<Record<HarnessID, HarnessSource>>
  /** Explicit --allow-downgrade (for every harness). */
  readonly allowDowngrade?: boolean
}

/** One HarnessSource (builtinExecutors({harness})) over the adapters' sources, by `action.harness`. */
export function dispatchHarnessSource(options: HarnessSources): HarnessSource {
  const pick = (action: InstallHarness) => options.sources[action.harness]
  return {
    manifest: options.manifest,
    ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
    fetch: async (action, staging) => {
      const source = pick(action)
      if (!source) throw new TxError("internal", `this hubctl has no source to install ${action.harness} from`)
      return source.fetch(action, staging)
    },
    unpack: async (action, file, staging) => {
      const source = pick(action)
      return source ? source.unpack(action, file, staging) : txFail("internal", `this hubctl has no source to install ${action.harness} from`)
    },
    installed: (harness) => options.sources[harness]?.installed?.(harness),
    floor: (harness) => options.sources[harness]?.floor?.(harness),
  }
}
