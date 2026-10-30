#!/usr/bin/env bun
// Entry of the hub CLI (`hub` / `hubctl`, one command surface): the npm bundle the spoke's launchers run as
// `BUN_BE_BUN=1 <opencode binary> hub-cli.js …` (or node), and the standalone hubctl (`bun build --compile` of this
// file; scripts/build-hubctl.sh). See cli.ts for the program.
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import { run } from "./cli"

// The launcher sets BUN_BE_BUN so the OpenCode binary acts as bun; nothing this process starts may inherit it.
delete process.env.BUN_BE_BUN

const argv = process.argv.slice(2)

/** All of stdin when piped; a prompted line on a terminal (`hub login` without --token). */
async function stdin(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8")
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  try {
    return await new Promise<string>((resolve) => rl.question("App token: ", resolve))
  } finally {
    rl.close()
  }
}

// Only `watch`, `mcp` and `node run` run until interrupted: SIGINT/SIGTERM end them cleanly (exit 0; the service
// units stop the node with SIGTERM); other commands keep the default.
const nodeRun = argv[0] === "node" && argv[1] === "run"
// `hub claude-code daemon` and `hub claude-code mcp` (the Claude Code spoke) run until interrupted too.
const claudeDaemon = argv[0] === "claude-code" && argv[1] === "daemon"
const claudeMcp = argv[0] === "claude-code" && argv[1] === "mcp"
// `hub codex-spoke serve` (the Codex spoke service) and `hub preset run` (until its pane ends) too.
const codexServe = argv[0] === "codex-spoke" && argv[1] === "serve"
const presetRun = argv[0] === "preset" && argv[1] === "run"
// `hubctl machine enroll` and `hub login` (device code) poll until the code is approved: Ctrl-C cancels them (exit 4,
// nothing stored). `hubctl setup apply` / `recover` pass the signal to their probes and the verification launch, so
// Ctrl-C fails the running step and the transaction rolls back, instead of the process dying between a write and its
// journal entry.
const enroll = (argv[0] === "machine" && argv[1] === "enroll") || argv[0] === "login"
const applying = argv[0] === "setup" && (argv[1] === "apply" || argv[1] === "recover")
const controller = new AbortController()
if (argv[0] === "watch" || argv[0] === "mcp" || nodeRun || claudeDaemon || claudeMcp || codexServe || presetRun || enroll || applying)
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort())

process.exitCode = await run(argv, {
  env: process.env,
  home: homedir(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  stdin,
  stdinIsTerminal: process.stdin.isTTY === true,
  signal: controller.signal,
  input: process.stdin,
  cwd: process.cwd(),
})
// A signal ends `hub mcp` with its stdin still open; let go of it so the process can exit.
if (argv[0] === "mcp" || claudeMcp) process.stdin.destroy()
// Nothing else (sockets, timers) may keep a stopped node, Claude Code daemon or Codex spoke alive, nor `hub claude` /
// `hub codex` once the harness exited, nor a stopped `hub preset run`.
if (nodeRun || claudeDaemon || codexServe || argv[0] === "claude" || argv[0] === "codex" || presetRun) process.exit()
