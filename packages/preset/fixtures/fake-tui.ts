#!/usr/bin/env bun
// A fake terminal harness for the preset spoke's tests: prints its session ID (for a screen nativeID pattern), then
// answers each line it reads with "fake-tui got: <line>"; Ctrl-C (SIGINT) interrupts nothing and it keeps running,
// as an agent TUI that cancels its turn would. Exits on end of input.
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline"

process.on("SIGINT", () => process.stdout.write("fake-tui interrupted\n"))
process.stdout.write(`fake-tui session ${randomBytes(6).toString("hex")}\n`)
for await (const line of createInterface({ input: process.stdin })) process.stdout.write(`fake-tui got: ${line}\n`)
