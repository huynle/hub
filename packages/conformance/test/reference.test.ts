// The reference fake spoke (fixtures/reference-spoke.ts, on HarnessSpoke) passes every check.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CHECK_IDS, runConformance } from "../src/index.ts"
import { FAKE_TIMING, referenceDriver } from "./helpers.ts"

describe("conformance runner: reference spoke", () => {
  test(
    "passes every check, none skipped",
    async () => {
      const report = await runConformance({ driver: referenceDriver(), ...FAKE_TIMING })
      const summary = report.checks.map((c) => ({ id: c.id, status: c.status, problems: c.problems, reason: c.reason }))
      expect(summary).toEqual(CHECK_IDS.map((id) => ({ id, status: "pass", problems: [], reason: undefined })))
      expect(report.ok).toBe(true)
      expect(report).toMatchObject({ suite: "spoke", harness: "conformance-fake", harnessVersion: "1.0.0", evidence: "hooks" })
      expect(report.features).toContain("permission")
      expect(report.driver).toEqual(referenceDriver())
      expect(path.isAbsolute(referenceDriver()[1]!)).toBe(true)
    },
    60_000,
  )

  test(
    "checks a spoke's features do not reach are skipped with a reason, and do not fail the run",
    async () => {
      const report = await runConformance({ driver: [...referenceDriver(), "--minimal"], ...FAKE_TIMING })
      const statuses = Object.fromEntries(report.checks.map((c) => [c.id, c.reason ? `${c.status}: ${c.reason}` : c.status]))
      expect(statuses).toEqual({
        hello: "pass",
        features: "pass",
        events: "pass",
        "deliver.idempotent": "skip: deliver not announced",
        "deliver.modes": "skip: deliver not announced",
        permission: "skip: permission not announced",
        tokens: "pass",
        reconnect: "pass",
        frames: "pass",
      })
      expect(report.ok).toBe(true)
      expect(report.features).not.toContain("deliver")
    },
    60_000,
  )

  test(
    "a spoke that never starts fails hello; the checks it never reached are skipped",
    async () => {
      const report = await runConformance({ driver: [...referenceDriver(), "--fail-start"], ...FAKE_TIMING })
      const hello = report.checks.find((c) => c.id === "hello")!
      expect(hello.status).toBe("fail")
      expect(hello.problems.join()).toMatch(/could not start the spoke: refusing to start/)
      for (const c of report.checks.filter((c) => c.id !== "hello" && c.id !== "tokens")) expect({ id: c.id, status: c.status, reason: c.reason }).toEqual({ id: c.id, status: "skip", reason: "the spoke never sent a hello" })
      expect(report.ok).toBe(false)
    },
    60_000,
  )
})
