// The readiness gate `hubctl setup apply` gives each verify-harness executor (contract v1.2): by default a harness
// that only waits on the user is committed as installed, not ready; --require-ready makes every harness strict; and
// the harness of a requested verification launch (--verify-launch) is always strict, since the launch needs it ready.
import { describe, expect, test } from "bun:test"
import type { HarnessReadiness } from "../src/bootstrap/contracts/index.ts"
import { readinessGate } from "../src/setup/runtime.ts"

describe("readinessGate", () => {
  test("default: no harness is strict", () => {
    for (const h of ["opencode", "claude-code", "codex"] as const) expect(readinessGate({}, h).requireReady).toBe(false)
  })

  test("--require-ready: every harness is strict", () => {
    for (const h of ["opencode", "claude-code", "codex"] as const) expect(readinessGate({ requireReady: true }, h).requireReady).toBe(true)
  })

  test("--verify-launch keeps exactly the launch harness strict", () => {
    expect(readinessGate({ strict: ["claude-code"] }, "claude-code").requireReady).toBe(true)
    expect(readinessGate({ strict: ["claude-code"] }, "opencode").requireReady).toBe(false)
  })

  test("passes the readiness observer through", () => {
    const seen: HarnessReadiness[] = []
    const gate = readinessGate({ onReadiness: (r) => seen.push(r) }, "codex")
    gate.onReadiness?.({ harness: "codex", state: "ready", probes: [], nextSteps: [] })
    expect(seen).toHaveLength(1)
  })
})
