// The preset spoke through the spoke conformance suite: its driver (fixtures/driver.ts) runs a fake terminal harness
// (fixtures/fake-tui.ts: echoes lines, survives Ctrl-C) in a real tmux on a private socket (-L hub-cf-<random>), never
// the user's tmux server. Skipped when tmux is not installed.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { runConformance } from "../../conformance/src/index.ts"

const hasTmux = spawnSync("tmux", ["-V"]).status === 0
const driver = path.join(import.meta.dir, "..", "fixtures", "driver.ts")

describe.skipIf(!hasTmux)("preset spoke conformance", () => {
  test(
    "passes every applicable check; permission skipped (not announced), events skipped (it sends none)",
    async () => {
      const report = await runConformance({ driver: [process.execPath, driver], timeouts: { turnMs: 3000, helloMs: 15_000 } })
      const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
      expect({ ok: report.ok, failed: report.checks.filter((c) => c.status === "fail") }).toEqual({ ok: true, failed: [] })
      expect(status).toEqual({
        hello: "pass",
        features: "pass",
        events: "skip",
        "deliver.idempotent": "pass",
        "deliver.modes": "pass",
        permission: "skip",
        tokens: "pass",
        reconnect: "pass",
        frames: "pass",
      })
      expect(report.evidence).toBe("screen")
      expect(report.harness).toBe("preset-fake-tui")
    },
    90_000,
  )
})
