// A fake `claude` for tests (never the real one): `claude -p --input-format stream-json --output-format
// stream-json` as far as the hub uses it. It records how it was started (argv, cwd, the hub's environment) as one
// JSON line in $FAKE_CLAUDE_LOG, then reads stream-json input lines:
// - a user message: when $HUB_CLAUDE_SOCKET is set it runs the plugin's hooks through the real hook bridge
//   (UserPromptSubmit, then Stop), and prints a result line: "echo: <text>". Prompts with markers:
//   SLOW waits for an interrupt control request (then an error_during_execution result), FAIL gives an error
//   result, EXIT exits with code 3 without a result.
// - a control request {subtype: interrupt}: a control_response (and ends a SLOW turn).
// SessionStart runs at startup and SessionEnd at the end of stdin (then exit 0).
// fakeClaude() writes an executable wrapper running this file with the test's bun.
import { chmodSync, appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runHook } from "../src/bridge.ts"

/** An executable that runs the fake (its path, and the log it records starts in). */
export function fakeClaude(): { bin: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"))
  const bin = path.join(dir, "claude")
  const log = path.join(dir, "starts.jsonl")
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_LOG='${log}' exec '${process.execPath}' '${path.join(import.meta.dir, "fake-claude.ts")}' "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin, log }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const env = process.env
  const sessionID = argv[argv.indexOf("--session-id") + 1] ?? "00000000-0000-4000-8000-000000000000"
  if (env.FAKE_CLAUDE_LOG) {
    const picked = Object.fromEntries(["HUB_CLAUDE_LAUNCH", "HUB_CLAUDE_SOCKET", "BUN_BE_BUN", "HUB_CLAUDE_TEST"].filter((k) => env[k] !== undefined).map((k) => [k, env[k]]))
    appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), env: picked, pid: process.pid })}\n`)
  }
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const hook = async (event: string, extra: Record<string, unknown> = {}) => {
    if (!env.HUB_CLAUDE_SOCKET) return
    await runHook({
      argv: [],
      stdin: JSON.stringify({ session_id: sessionID, transcript_path: "/fake/t.jsonl", cwd: process.cwd(), hook_event_name: event, ...extra }),
      env,
      socketPath: env.HUB_CLAUDE_SOCKET,
      stdout: () => {},
      stderr: () => {},
      timeoutMs: 5000,
    })
  }
  await hook("SessionStart", { source: "startup" })
  out({ type: "system", subtype: "init", session_id: sessionID, cwd: process.cwd() })

  let interrupt: (() => void) | undefined
  /** An interrupt that came while no turn was waiting for one yet (the message is queued): it ends that turn. */
  let early = false
  let turns = Promise.resolve()
  let buffer = ""
  let n = 0
  const handle = (line: string) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } })
      if (interrupt) interrupt()
      else early = true
      return
    }
    if (msg.type !== "user") return
    const content = msg.message?.content
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : ""
    const images = Array.isArray(content) ? content.filter((c: any) => c.type === "image").length : 0
    turns = turns.then(async () => {
      n += 1
      await hook("UserPromptSubmit", { prompt: text, prompt_id: `p${n}`, permission_mode: "default" })
      if (text.includes("EXIT")) process.exit(3)
      if (text.includes("SLOW")) {
        if (!early) await new Promise<void>((resolve) => (interrupt = resolve))
        interrupt = undefined
        early = false
        out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionID })
        return
      }
      if (text.includes("FAIL")) {
        await hook("StopFailure", { error: "model failed" })
        out({ type: "result", subtype: "error_during_execution", is_error: true, result: "model failed", session_id: sessionID })
        return
      }
      const reply = `echo: ${text}${images ? ` (+${images} image)` : ""}`
      await hook("Stop", { stop_hook_active: false, last_assistant_message: reply })
      out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionID })
    })
  }
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim()) handle(line)
    }
  })
  process.stdin.on("end", () => {
    void turns.then(async () => {
      await hook("SessionEnd", { reason: "other" })
      process.exit(0)
    })
  })
}

if (import.meta.main) await main()
