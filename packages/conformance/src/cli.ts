#!/usr/bin/env bun
// hub-conformance: runs a conformance suite and prints its report (a table, or JSON with --json). Exits 0 when every
// applicable check passed, 1 when one failed, 2 on a usage error. Progress goes to stderr.
import { writeFileSync } from "node:fs"
import { parseArgs, USAGE } from "./args.ts"
import { formatTable } from "./report.ts"
import { runConformance } from "./runner.ts"

const args = parseArgs(process.argv.slice(2))
if ("error" in args) {
  process.stderr.write(`hub-conformance: ${args.error}\n${USAGE}\n`)
  process.exit(2)
}
const report = await runConformance({
  driver: args.driver,
  ...(args.retryAfterMs !== undefined ? { retryAfterMs: args.retryAfterMs } : {}),
  log: (line) => process.stderr.write(`[conformance] ${line}\n`),
})
const json = JSON.stringify(report, null, 2)
if (args.out) writeFileSync(args.out, `${json}\n`)
process.stdout.write(`${args.json ? json : formatTable(report)}\n`)
process.exit(report.ok ? 0 : 1)
