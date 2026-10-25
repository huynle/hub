// The report as a table (the command line's default output; --json prints the ConformanceReport instead). One row per
// check: its id, status (FAIL in capitals so it stands out), then its problems (one per line), skip reason or notes.
import type { ConformanceReport } from "./runner.ts"

export function formatTable(report: ConformanceReport): string {
  const who = report.harness ? `${report.harness} ${report.harnessVersion ?? ""}`.trim() + (report.evidence ? ` (evidence ${report.evidence})` : "") : "unknown spoke"
  const lines = [`hub-conformance ${report.suite}: ${who}, ${(report.durationMs / 1000).toFixed(1)} s`]
  const width = Math.max(5, ...report.checks.map((c) => c.id.length)) + 2
  const pad = " ".repeat(width + 6)
  for (const check of report.checks) {
    const status = check.status === "fail" ? "FAIL" : check.status
    const detail = check.status === "fail" ? check.problems : check.status === "skip" ? [check.reason ?? ""] : check.notes
    const [first = "", ...rest] = detail
    lines.push(`${check.id.padEnd(width)}${status.padEnd(6)}${first}`.trimEnd())
    for (const line of rest) lines.push(`${pad}${line}`)
  }
  const count = (status: string) => report.checks.filter((c) => c.status === status).length
  lines.push(`${report.ok ? "PASS" : "FAIL"}: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`)
  return lines.join("\n")
}
