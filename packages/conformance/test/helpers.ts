// Shared by the conformance tests: the reference driver command and timings short enough for a fake harness.
import { expect } from "bun:test"
import path from "node:path"
import { CHECK_IDS, type CheckID, type ConformanceReport } from "../src/index.ts"
import type { Fault } from "../fixtures/reference-spoke.ts"

const DRIVER = path.join(import.meta.dir, "..", "fixtures", "driver.ts")

/** The reference driver's command, with a fault when given. */
export const referenceDriver = (fault?: Fault): string[] => [process.execPath, DRIVER, ...(fault ? [`--fault=${fault}`] : [])]

/** Timings for the fake harness (answers in milliseconds); real harness drivers use the defaults. */
export const FAKE_TIMING = {
  timeouts: { helloMs: 5000, requestMs: 3000, eventMs: 3000, turnMs: 5000, settleMs: 300 },
  retryAfterMs: 300,
  reconnectGraceMs: 1500,
} as const

/** Asserts the report failed `id` (with a problem matching `problem`) and passed every other check. */
export function expectOnlyFailing(report: ConformanceReport, id: CheckID, problem: RegExp): void {
  const statuses = Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
  expect(statuses).toEqual(Object.fromEntries(CHECK_IDS.map((c) => [c, c === id ? "fail" : "pass"])))
  expect(report.checks.find((c) => c.id === id)!.problems.join("\n")).toMatch(problem)
  expect(report.ok).toBe(false)
}
