// Phase 7 (P7-T11): every spoke this repository ships through the spoke conformance suite (packages/conformance),
// side by side, each through its own driver against the suite's recording hub, stub model and deny-all proxy:
// - reference: the suite's own fake harness (packages/conformance/fixtures/driver.ts);
// - opencode: the REAL OpenCode spoke (src/spoke/spoke.ts, the plugin's Spoke) over a fake OpenCode host that asks
//   the stub model (test/fixtures/opencode-conformance-driver.ts); its events check is skipped by design (an
//   OpenCode spoke forwards the full event set, not the harness subset);
// - claude-code: the real per-user daemon over the fake claude (no model: permission skipped);
// - codex: the real app-server spoke attached to the fake shared daemon (every check);
// - preset: the real preset spoke on a private tmux socket (permission not announced, no events; skipped without
//   tmux).
// The runs go concurrently (each owns its hub, model, proxy and processes); every driver stops what it started.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { CHECK_IDS, runConformance, type ConformanceReport } from "../packages/conformance/src/index.ts"

// End to end: real hubs, spokes, nodes and git; give each test room on a loaded machine.
setDefaultTimeout(30_000)

const root = path.join(import.meta.dir, "..")
const hasTmux = spawnSync("tmux", ["-V"]).status === 0
const TIMING = { timeouts: { helloMs: 15_000, requestMs: 8000, eventMs: 8000, turnMs: 15_000, settleMs: 500 }, retryAfterMs: 300, reconnectGraceMs: 3000 } as const

const DRIVERS = {
  reference: path.join(root, "packages/conformance/fixtures/driver.ts"),
  opencode: path.join(root, "test/fixtures/opencode-conformance-driver.ts"),
  "claude-code": path.join(root, "packages/claude-code/test/conformance-driver.ts"),
  codex: path.join(root, "packages/codex/test/fixtures/conformance-driver.ts"),
  preset: path.join(root, "packages/preset/fixtures/driver.ts"),
} as const
type Name = keyof typeof DRIVERS

/** What each spoke's report must say: every check passes except the ones listed (skipped, never failed). */
const EXPECTED: Record<Name, { harness: string; evidence: string; skipped: string[] }> = {
  reference: { harness: "conformance-fake", evidence: "hooks", skipped: [] },
  opencode: { harness: "opencode", evidence: "native", skipped: ["events"] },
  "claude-code": { harness: "claude-code", evidence: "hooks", skipped: ["permission"] },
  codex: { harness: "codex", evidence: "rpc", skipped: [] },
  preset: { harness: "preset-fake-tui", evidence: "screen", skipped: ["events", "permission"] },
}

const names = (Object.keys(DRIVERS) as Name[]).filter((n) => n !== "preset" || hasTmux)
let reports: Promise<Record<string, ConformanceReport>> | undefined
const all = () =>
  (reports ??= Promise.all(names.map(async (name) => [name, await runConformance({ driver: [process.execPath, DRIVERS[name]], ...TIMING })] as const)).then((pairs) =>
    Object.fromEntries(pairs),
  ))

describe("phase 7: conformance of every shipped spoke", () => {
  for (const name of names) {
    test(
      `${name}: passes every check it can reach`,
      async () => {
        const report = (await all())[name]!
        const want = EXPECTED[name]
        const statuses = Object.fromEntries(report.checks.map((c) => [c.id, c.status === "fail" ? `fail: ${c.problems.join("; ")}` : c.status]))
        expect(statuses).toEqual(Object.fromEntries(CHECK_IDS.map((id) => [id, want.skipped.includes(id) ? "skip" : "pass"])))
        expect(report).toMatchObject({ ok: true, harness: want.harness, evidence: want.evidence })
      },
      150_000,
    )
  }
})
