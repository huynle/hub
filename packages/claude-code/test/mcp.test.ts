// The daemon-backed MCP server (`hub claude-code mcp`, loaded by the plugin): Claude Code runs it as a stdio MCP
// server; it is only a pipe to the daemon, which answers with the hub CLI's MCP tools as the session the `hub claude`
// run is in. Act verbs (approve, deny, answer, prompt, stop) use the session's act token, every other verb its
// session token; both stay in the daemon's memory, never in the MCP process or any environment.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harness, waitFor, type Harness } from "../../../test/central-harness.ts"
import { runHook } from "../src/bridge.ts"
import { startDaemon, type ClaudeDaemon } from "../src/daemon.ts"
import { claudeSessionID } from "../src/ids.ts"
import { createMcpRouter, runMcpPipe } from "../src/mcp.ts"

const SID = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"
const HUB = claudeSessionID(SID)

/** A fake hub: records which bearer each agent call carried. */
const calls: { path: string; token: string | null }[] = []
const fake = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    calls.push({ path: url.pathname, token: request.headers.get("authorization") })
    if (url.pathname === "/api/agent/whoami") return Response.json({ actor: { kind: "session", userID: "u1", machineID: "m1", sessionID: HUB }, user: { id: "u1", name: "Huy" } })
    if (url.pathname.endsWith("/stop")) return Response.json({ stopped: ["ses_other"], sessionID: "ses_other" })
    return Response.json({ error: { code: "not_found", message: "nope" } }, { status: 404 })
  },
})
afterAll(() => fake.stop(true))
afterEach(() => {
  calls.length = 0
})

const URL_ = `http://127.0.0.1:${fake.port}`
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })

function router(session: string | undefined) {
  return createMcpRouter({
    version: "0.6.1",
    sessionID: () => session,
    sessionToken: (id) => (id === HUB ? { token: "hst1.SHELL", url: URL_ } : undefined),
    actToken: (id) => (id === HUB ? { token: "hat1.ACT", url: URL_ } : undefined),
  })
}

describe("the MCP router (in the daemon)", () => {
  test("answers initialize and lists the hub CLI's tools", async () => {
    const r = router(HUB)
    expect(await r.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).toMatchObject({ result: { serverInfo: { name: "hub" } } })
    const list = (await r.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain("msg")
    expect(names).toContain("approve")
  })

  test("read and messaging verbs use the session token; act verbs the act token", async () => {
    const r = router(HUB)
    expect(((await r.handle(call(3, "whoami"))) as any).result.isError).toBe(false)
    await r.handle(call(4, "stop", { addr: "ses_other" }))
    expect(calls).toEqual([
      { path: "/api/agent/whoami", token: "Bearer hst1.SHELL" },
      { path: "/api/agent/sessions/ses_other/stop", token: "Bearer hat1.ACT" },
    ])
  })

  test("outside a hub session (no session, or no token yet) a call is an error result, never a hub call", async () => {
    for (const r of [router(undefined), router("ses_ccunknown")]) {
      const answer = (await r.handle(call(5, "whoami"))) as any
      expect(answer.result.isError).toBe(true)
      expect(answer.result.content[0].text).toMatch(/hub session/)
    }
    expect(calls).toEqual([])
  })

  test("never shows a token, even when the hub echoes one", async () => {
    const r = router(HUB)
    const answer = (await r.handle(call(6, "whoami"))) as any
    expect(JSON.stringify(answer)).not.toContain("hst1.SHELL")
  })
})

describe("the MCP pipe (`hub claude-code mcp`)", () => {
  let h: Harness | undefined
  let daemon: ClaudeDaemon | undefined
  afterEach(async () => {
    await daemon?.stop()
    await h?.stop()
    daemon = h = undefined
  })

  async function* lines(...messages: unknown[]) {
    for (const m of messages) yield `${JSON.stringify(m)}\n`
  }

  test("without a daemon it still answers MCP, with an error for every tool call", async () => {
    const out: string[] = []
    await runMcpPipe({ input: lines({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, call(2, "whoami")), write: (s) => out.push(s), socketPath: path.join(mkdtempSync(path.join(tmpdir(), "hcm-")), "none.sock"), env: {}, version: "0.6.1" })
    const answers = out.join("").trim().split("\n").map((l) => JSON.parse(l))
    expect(answers[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "hub" } } })
    expect(answers[1]).toMatchObject({ id: 2, result: { isError: true } })
    expect(answers[1].result.content[0].text).toMatch(/daemon/)
  })

  test("through the daemon, a tool call runs as the launch's session at the real hub", async () => {
    // Session tokens carry the hub's public URL: make it the real server's (a free port picked first).
    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port
    probe.stop(true)
    h = await harness({ env: { HUB_PORT: String(port), HUB_PUBLIC_URL: `http://127.0.0.1:${port}` } })
    const { token } = await h.store.addMachine("mbp")
    const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "hcm-")), "cc", "d.sock")
    daemon = await startDaemon({ socketPath, server: h.url, token, harnessVersion: "2.1.296", pluginVersion: "0.6.1", directory: "/", tokenWaitMs: 3000 })
    await waitFor(() => daemon!.state === "connected", 3000)
    const stdin = readFileSync(path.join(import.meta.dir, "fixtures", "session-start.json"), "utf8")
    await runHook({ argv: [], stdin, env: { HUB_CLAUDE_LAUNCH: "L9" }, socketPath, stdout: () => {}, stderr: () => {} })
    await waitFor(() => daemon!.spoke.sessionToken(HUB) !== undefined, 3000)
    const out: string[] = []
    await runMcpPipe({ input: lines(call(1, "whoami")), write: (s) => out.push(s), socketPath, env: { HUB_CLAUDE_LAUNCH: "L9" }, version: "0.6.1" })
    const answer = JSON.parse(out.join("").trim())
    expect(answer.result.isError).toBe(false)
    expect(answer.result.content[0].text).toContain(HUB)
  })
})
