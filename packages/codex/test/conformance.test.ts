// The Codex spoke against the spoke conformance suite (packages/conformance), through its driver
// (fixtures/conformance-driver.ts): the spoke attaches to a fake shared daemon (fixtures/fake-app-server.ts), where
// the driver plays the local TUI (it starts the thread and types the prompts), and the fake asks the suite's stub
// model (OpenAI Responses). Every check must pass; none may be skipped. The driver stops every process it started.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { CHECK_IDS, runConformance } from "../../conformance/src/index.ts"

const DRIVER = path.join(import.meta.dir, "fixtures", "conformance-driver.ts")
const TIMING = {
  timeouts: { helloMs: 10_000, requestMs: 5000, eventMs: 5000, turnMs: 10_000, settleMs: 500 },
  retryAfterMs: 300,
  reconnectGraceMs: 3000,
} as const

const leftovers = () => {
  try {
    return execFileSync("pgrep", ["-f", "fake-app-server.ts"], { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

describe("codex spoke conformance", () => {
  test(
    "passes every check against the fake daemon, none skipped, and leaves no process behind",
    async () => {
      const lines: string[] = []
      const report = await runConformance({ driver: [process.execPath, DRIVER], ...TIMING, log: (l) => void lines.push(l) })
      const summary = report.checks.map((c) => ({ id: c.id, status: c.status, problems: c.problems, reason: c.reason }))
      expect(summary).toEqual(CHECK_IDS.map((id) => ({ id, status: "pass", problems: [], reason: undefined })))
      expect(report).toMatchObject({ ok: true, harness: "codex", evidence: "rpc" })
      expect(report.features).toEqual(expect.arrayContaining(["turn", "steer", "interrupt", "permission", "deliver", "turnEvents"]))
      await new Promise((r) => setTimeout(r, 300))
      expect(leftovers()).toBe("")
    },
    120_000,
  )
})
