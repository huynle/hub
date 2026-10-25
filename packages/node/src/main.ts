#!/usr/bin/env bun
// Entry of `hub node`: `bun packages/node/src/main.ts` (what the launchd and systemd units run), or the same file
// bundled for node. SIGINT and SIGTERM stop the daemon cleanly (exit 0). See run.ts for the program.
import { runNode } from "./run.ts"

const controller = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort())

process.exitCode = await runNode({ signal: controller.signal })
// Nothing else (sockets, timers) may keep a stopped node alive.
process.exit()
