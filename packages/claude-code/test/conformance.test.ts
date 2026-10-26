// The Claude Code spoke with launches on passes the spoke conformance suite (packages/conformance) through its driver
// over the fake claude. permission is skipped (the fake calls no model, so nothing asks permission).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runConformance } from "../../conformance/src/index.ts"

const DRIVER = [process.execPath, path.join(import.meta.dir, "conformance-driver.ts")]
const TIMING = { timeouts: { helloMs: 5000, requestMs: 5000, eventMs: 5000, turnMs: 8000, settleMs: 300 }, retryAfterMs: 300, reconnectGraceMs: 2000 } as const

describe("conformance: claude-code spoke with launches", () => {
  test(
    "passes every check it can reach; permission is skipped for the fake",
    async () => {
      const report = await runConformance({ driver: DRIVER, ...TIMING })
      const statuses = Object.fromEntries(report.checks.map((c) => [c.id, c.status === "fail" ? `fail: ${c.problems.join("; ")}` : c.status]))
      expect(statuses).toEqual({
        hello: "pass",
        features: "pass",
        events: "pass",
        "deliver.idempotent": "pass",
        "deliver.modes": "pass",
        permission: "skip",
        tokens: "pass",
        reconnect: "pass",
        frames: "pass",
      })
      expect(report.ok).toBe(true)
      expect(report.features).toEqual(expect.arrayContaining(["create", "launch", "turn", "interrupt"]))
    },
    90_000,
  )
})
