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
})
