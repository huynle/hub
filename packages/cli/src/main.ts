#!/usr/bin/env bun
// Entry of the hub CLI bundle (`hub` / `hubctl`): the spoke's launchers run it as
// `BUN_BE_BUN=1 <opencode binary> hub-cli.js …` (or node). See cli.ts for the program.
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
const controller = new AbortController()
if (argv[0] === "watch" || argv[0] === "mcp" || nodeRun || claudeDaemon || claudeMcp) for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort())

process.exitCode = await run(argv, {
  env: process.env,
  home: homedir(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  stdin,
  signal: controller.signal,
  input: process.stdin,
  cwd: process.cwd(),
})
// A signal ends `hub mcp` with its stdin still open; let go of it so the process can exit.
if (argv[0] === "mcp" || claudeMcp) process.stdin.destroy()
// Nothing else (sockets, timers) may keep a stopped node or Claude Code daemon alive, nor `hub claude` once Claude Code exited.
if (nodeRun || claudeDaemon || argv[0] === "claude") process.exit()
