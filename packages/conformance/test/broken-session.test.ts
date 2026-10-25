// Broken fixtures (reference spoke with one fault each, fixtures/reference-spoke.ts FAULTS): each fails exactly its
// check, proving the check can fail. Split across files to keep each file's run short.
import { describe, test } from "bun:test"
import { runConformance } from "../src/index.ts"
import { expectOnlyFailing, FAKE_TIMING, referenceDriver } from "./helpers.ts"

describe("conformance runner: broken fixtures", () => {
  test(
    "fault hello: fails the hello check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("hello"), ...FAKE_TIMING })
      expectOnlyFailing(report, "hello", /evidence "guess"/)
    },
    60_000,
  )

  test(
    "fault features: fails the features check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("features"), ...FAKE_TIMING })
      expectOnlyFailing(report, "features", /unannounced "diff" was answered ok/)
    },
    60_000,
  )

  test(
    "fault events: fails the events check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("events"), ...FAKE_TIMING })
      expectOnlyFailing(report, "events", /raw tool data in data\.output/)
    },
    60_000,
  )
})
