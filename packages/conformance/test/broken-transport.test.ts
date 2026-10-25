// Broken fixtures (reference spoke with one fault each, fixtures/reference-spoke.ts FAULTS): each fails exactly its
// check, proving the check can fail. Split across files to keep each file's run short.
import { describe, test } from "bun:test"
import { runConformance } from "../src/index.ts"
import { expectOnlyFailing, FAKE_TIMING, referenceDriver } from "./helpers.ts"

describe("conformance runner: broken fixtures", () => {
  test(
    "fault tokens: fails the tokens check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("tokens"), ...FAKE_TIMING })
      expectOnlyFailing(report, "tokens", /session token appears in the driver's stderr/)
    },
    60_000,
  )

  test(
    "fault reconnect: fails the reconnect check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("reconnect"), ...FAKE_TIMING })
      expectOnlyFailing(report, "reconnect", /did not reconnect within/)
    },
    60_000,
  )

  test(
    "fault frames: fails the frames check only",
    async () => {
      const report = await runConformance({ driver: referenceDriver("frames"), ...FAKE_TIMING })
      expectOnlyFailing(report, "frames", /oversize event frame/)
    },
    60_000,
  )
})
