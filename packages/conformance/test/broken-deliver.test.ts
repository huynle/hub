// Broken fixtures (reference spoke with one fault each, fixtures/reference-spoke.ts FAULTS): each fails exactly its
// check, proving the check can fail. Split across files to keep each file's run short.
import { describe, test } from "bun:test"
import { runConformance } from "../src/index.ts"
import { expectOnlyFailing, FAKE_TIMING, referenceDriver } from "./helpers.ts"

describe("conformance runner: broken fixtures", () => {
  test(
    "fault deliver.idempotent: fails the deliver.idempotent check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("deliver.idempotent"), ...FAKE_TIMING })
      expectOnlyFailing(report, "deliver.idempotent", /admitted 3 times|differs from the first/)
    },
    60_000,
  )

  test(
    "fault deliver.modes: fails the deliver.modes check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("deliver.modes"), ...FAKE_TIMING })
      expectOnlyFailing(report, "deliver.modes", /"steer" without a confirmation/)
    },
    60_000,
  )

  test(
    "fault permission: fails the permission check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("permission"), ...FAKE_TIMING })
      expectOnlyFailing(report, "permission", /no permission\.replied/)
    },
    60_000,
  )
})
