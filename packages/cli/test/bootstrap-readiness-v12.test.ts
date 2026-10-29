// v1.2 readiness gates in the three verify-harness executors (docs/bootstrap-contracts.md §10). Each executor
// classifies its probes with the contract (harnessReadiness) and reports the result:
//
//   ready                      the step passes (as before)
//   failed (integrity)         harness_not_ready, so the apply rolls back (as before), with or without requireReady
//   pending (user probes only) requireReady (the default): harness_not_ready, as before;
//                              requireReady: false (the CLI's default apply): the step passes, the harness is
//                              reported "installed, not ready" and is never advertised as ready
import { describe, expect, test } from "bun:test"
import type { AdapterContext, HarnessAdapter, HarnessID, HarnessReadiness, HarnessVerification, Probe, VerifyHarness } from "../src/bootstrap/contracts/index.ts"
import { claudeVerifyExecutor } from "../src/bootstrap/adapters/claude/verify.ts"
import { codexVerifyExecutor } from "../src/bootstrap/adapters/codex/verify.ts"
import { opencodeVerifyExecutor } from "../src/bootstrap/adapters/opencode/apply.ts"
import type { ActionExecutor } from "../src/bootstrap/transaction/executor.ts"

const NOW = 1_800_000_000_000
const ctx: AdapterContext = { env: {}, home: "/home/u", platform: "linux", arch: "x64", now: () => NOW }
const p = (kind: Probe["kind"], ok: boolean, detail?: string): Probe => ({ kind, ok, observedAt: NOW, ...(detail ? { detail } : {}) })

const PROBES: Record<HarnessID, VerifyHarness["probes"][number][]> = {
  opencode: ["version-exec", "provider-auth", "spoke-connected"],
  "claude-code": ["version-exec", "provider-auth", "spoke-connected"],
  codex: ["version-exec", "api-health", "provider-auth", "spoke-connected"],
}
const action = (harness: HarnessID): VerifyHarness => ({ id: `verify-${harness}`, kind: "verify-harness", escalation: "user", summary: "verify", harness, probes: PROBES[harness] })

/** A verification of `harness` where every probe passes except the ones named. */
const verification = (harness: HarnessID, failing: Partial<Record<Probe["kind"], string>> = {}): HarnessVerification => ({
  harness,
  probes: PROBES[harness].map((kind) => p(kind, !(kind in failing), failing[kind])),
})

type Gate = { readonly requireReady?: boolean; readonly onReadiness?: (r: HarnessReadiness) => void }

function executor(harness: HarnessID, v: HarnessVerification, gate: Gate): ActionExecutor<"verify-harness"> {
  if (harness === "opencode") {
    const adapter = { id: "opencode", verify: async () => v } as unknown as HarnessAdapter
    return opencodeVerifyExecutor({ adapter, context: () => ctx, ...gate })
  }
  if (harness === "claude-code") return claudeVerifyExecutor({ verify: async () => v, now: () => NOW, ...gate })
  return codexVerifyExecutor({ verify: async () => v, context: () => ctx, ...gate })
}

async function perform(harness: HarnessID, v: HarnessVerification, gate: Gate = {}) {
  const exec = executor(harness, v, gate)
  const change = await exec.change(action(harness) as never, {} as never)
  if (!change.ok || change.value.type !== "effect") throw new Error("expected an effect")
  return change.value.perform()
}

const PENDING: Record<HarnessID, Partial<Record<Probe["kind"], string>>> = {
  opencode: { "provider-auth": "opencode models exited 1", "spoke-connected": "not connected" },
  "claude-code": { "provider-auth": "not logged in", "spoke-connected": "the claude-code spoke is not connected" },
  codex: { "provider-auth": "Codex is not logged in", "spoke-connected": "not connected" },
}
const BROKEN: Record<HarnessID, Partial<Record<Probe["kind"], string>>> = {
  opencode: { "version-exec": "opencode 2.1.0 runs, but hub made 2.2.0 current", "provider-auth": "x" },
  "claude-code": { "version-exec": "did not run (could not start)" },
  codex: { "api-health": "the app-server did not start" },
}

for (const harness of ["opencode", "claude-code", "codex"] as const) {
  describe(`${harness} verify-harness readiness gate`, () => {
    test("ready passes and reports state ready", async () => {
      const seen: HarnessReadiness[] = []
      expect((await perform(harness, verification(harness), { requireReady: false, onReadiness: (r) => seen.push(r) })).ok).toBe(true)
      expect(seen.map((r) => r.state)).toEqual(["ready"])
    })

    test("only user probes pending: passes without requireReady, reported pending with next steps", async () => {
      const seen: HarnessReadiness[] = []
      const r = await perform(harness, verification(harness, PENDING[harness]), { requireReady: false, onReadiness: (x) => seen.push(x) })
      expect(r.ok).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ harness, state: "pending" })
      expect(seen[0]!.nextSteps.length).toBeGreaterThan(1)
    })

    test("only user probes pending: harness_not_ready with requireReady (and by default)", async () => {
      for (const gate of [{ requireReady: true }, {}]) {
        const r = await perform(harness, verification(harness, PENDING[harness]), gate)
        expect(r.ok ? "ok" : r.code).toBe("harness_not_ready")
      }
    })

    test("an integrity failure is harness_not_ready even without requireReady", async () => {
      const seen: HarnessReadiness[] = []
      const r = await perform(harness, verification(harness, BROKEN[harness]), { requireReady: false, onReadiness: (x) => seen.push(x) })
      expect(r.ok ? "ok" : r.code).toBe("harness_not_ready")
      expect(seen[0]?.state).toBe("failed")
    })
  })
}
