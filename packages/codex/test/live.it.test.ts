// OPT-IN live test of the Codex spoke against the real `codex` (0.160.0): runs only with HUB_IT_CODEX=1 and codex on
// PATH. The spoke starts its own `codex app-server` (stdio) with a throwaway HOME and CODEX_HOME, the testkit's stub
// OpenAI Responses model as the model provider (-c model_providers…, never a config file) and the testkit's deny-all
// proxy (Codex tries chatgpt.com and GitHub). ~/.codex is never read or written. Every process is stopped and the
// throwaway directory removed after the run (HUB_IT_KEEP=1 keeps it).
//
//   HUB_IT_CODEX=1 bun test ./packages/codex/test/live.it.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { denyProxy, fakeHub, stubModel, until, type DenyProxy, type FakeHub, type StubModel } from "../../testkit/src/index.ts"
import { codexVersion } from "../src/main.ts"
import { startCodexSpoke, type CodexSpoke } from "../src/spoke.ts"

const enabled = process.env.HUB_IT_CODEX === "1"
const codex = enabled ? spawnSync("which", ["codex"], { encoding: "utf8" }).stdout.trim() : ""
if (enabled && !codex) console.warn("[it] HUB_IT_CODEX=1 but `codex` is not on PATH; skipping")
const run = enabled && codex !== ""

/** PIDs of `codex app-server --listen stdio://` processes (to prove the run leaves none behind). */
const appServers = (): Set<string> => {
  try {
    return new Set(execFileSync("pgrep", ["-f", "app-server --listen stdio://"], { encoding: "utf8" }).trim().split("\n").filter(Boolean))
  } catch {
    return new Set()
  }
}

describe.skipIf(!run)("codex spoke against the real codex app-server", () => {
  let base: string
  let work: string
  let hub: FakeHub
  let stub: StubModel
  let proxy: DenyProxy
  let spoke: CodexSpoke
  let before: Set<string>
  let sessionID: string

  const events = () => hub.frames.flatMap((f) => (f.t === "event" && (f.event.data as any)?.sessionID === sessionID ? [f.event as { type: string; data: any }] : []))
  const turnEnds = () => events().filter((e) => e.type.startsWith("session.execution.") && e.type !== "session.execution.started").length

  beforeAll(async () => {
    before = appServers()
    base = mkdtempSync(path.join(tmpdir(), "hub-it-codex-"))
    work = path.join(base, "work")
    const codexHome = path.join(base, "codex-home")
    const home = path.join(base, "home")
    for (const dir of [work, codexHome, home]) mkdirSync(dir)
    hub = fakeHub({ hubFeatures: ["harness", "messaging", "launches"] })
    stub = stubModel()
    proxy = await denyProxy()
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome, STUB_API_KEY: "dummy", ...proxy.env() }
    spoke = startCodexSpoke({
      server: hub.url,
      token: "hmt1.LIVE-MACHINE-SECRET",
      harnessVersion: codexVersion(codex, env),
      pluginVersion: "it",
      directory: work,
      codexBin: codex,
      codexArgs: [
        "-c",
        `model_provider="stub"`,
        "-c",
        `model_providers.stub={ name = "stub", base_url = "${stub.openaiBaseURL}", env_key = "STUB_API_KEY", wire_api = "responses" }`,
        "-c",
        `model="stub-model"`,
      ],
      env,
      threadDefaults: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
    })
  }, 30_000)

  afterAll(async () => {
    await spoke?.stop()
    await Promise.allSettled([hub?.stop(), stub?.stop(), proxy?.stop()])
    if (base) {
      if (process.env.HUB_IT_KEEP === "1") console.warn(`[it] kept ${base}`)
      else rmSync(base, { recursive: true, force: true })
    }
  }, 30_000)

  test("hello reports codex 0.160.x over rpc", async () => {
    const hello = await hub.next((f) => f.t === "hello", 15_000)
    expect(hello).toMatchObject({ harness: "codex", evidence: "rpc", kind: "service" })
    expect((hello as any).harnessVersion).toMatch(/^0\.160\./)
  }, 20_000)

  test("create starts a thread; a hub turn runs against the stub model and returns its reply", async () => {
    const created: any = await hub.request({ op: "create", directory: work, title: "Live" })
    expect(created).toMatchObject({ ok: true })
    sessionID = created.result.sessionID
    expect(sessionID).toMatch(/^ses_cx[0-9a-f]{32}$/)
    stub.queue({ text: "LIVE REPLY" })
    const turn: any = await hub.request({ op: "turn", sessionID, text: "hello from the hub", voiceStyle: false })
    expect(turn).toMatchObject({ ok: true, result: { outcome: "succeeded", reply: "LIVE REPLY" } })
    expect(JSON.stringify(stub.requests.at(-1)!.body)).toContain("hello from the hub")
  }, 90_000)

  test("permission: the model's exec_command asks; once runs it, reject does not", async () => {
    for (const [decision, file] of [["once", "approved.txt"], ["reject", "rejected.txt"]] as const) {
      const from = hub.frames.length
      // Codex 0.160 ends the turn (interrupted) when a command is declined, so only the once round asks the model again.
      stub.queue({ toolCalls: [{ name: "exec_command", input: { cmd: `touch ${file}` }, id: `call_${decision}` }] }, ...(decision === "once" ? [{ text: "done" }] : []))
      const turn = hub.request({ op: "turn", sessionID, text: `make ${file}`, voiceStyle: false })
      await until(() => hub.frames.slice(from).some((f) => f.t === "event" && f.event.type === "permission.asked"), 60_000)
      const asked = hub.frames.slice(from).find((f) => f.t === "event" && f.event.type === "permission.asked") as any
      const answer = await hub.request({ op: "permission", sessionID, requestID: asked.event.data.id, decision })
      expect(answer).toMatchObject({ ok: true })
      expect((answer as any).result?.gone).not.toBe(true)
      const ended: any = await turn
      expect(ended).toMatchObject({ ok: true })
      expect(ended.result.outcome).toBe(decision === "once" ? "succeeded" : "interrupted")
      expect(hub.frames.slice(from).some((f) => f.t === "event" && f.event.type === "permission.replied")).toBe(true)
      expect(existsSync(path.join(work, file))).toBe(decision === "once")
    }
  }, 180_000)

  test("interrupt ends a running turn as interrupted", async () => {
    const ends = turnEnds()
    stub.queue({ text: "too late", delayMs: 20_000 })
    const turn = hub.request({ op: "turn", sessionID, text: "take your time", voiceStyle: false })
    await until(() => stub.requests.some((r) => JSON.stringify(r.body).includes("take your time")), 30_000)
    expect(await hub.request({ op: "interrupt", sessionID })).toMatchObject({ ok: true })
    expect(await turn).toMatchObject({ ok: true, result: { outcome: "interrupted" } })
    await until(() => turnEnds() > ends, 15_000)
    expect(events().filter((e) => e.type.startsWith("session.execution.")).at(-1)!.type).toBe("session.execution.interrupted")
  }, 90_000)

  test("deliver without wake reaches the model with the next turn, once", async () => {
    const meta = { kind: "msg", from: "@peer", to: "@live" } as const
    const first: any = await hub.request({ op: "deliver", sessionID, messageID: "msg_live_1", text: "DELIVERED_MARKER", wake: false, meta })
    expect(first).toMatchObject({ ok: true, result: { delivered: "queued" } })
    const again: any = await hub.request({ op: "deliver", sessionID, messageID: "msg_live_1", text: "DELIVERED_MARKER", wake: false, meta })
    expect(again.result).toEqual(first.result)
    stub.queue({ text: "seen" })
    expect(await hub.request({ op: "turn", sessionID, text: "anything new?", voiceStyle: false })).toMatchObject({ ok: true, result: { outcome: "succeeded" } })
    const body = JSON.stringify(stub.requests.at(-1)!.body)
    expect(body.split("DELIVERED_MARKER").length - 1).toBe(1)
  }, 90_000)

  test("stop: the spoke's app-server is gone, no token leaked, the model was only the stub", async () => {
    await spoke.stop()
    await until(() => [...appServers()].every((pid) => before.has(pid)), 10_000)
    expect(JSON.stringify(hub.frames) + JSON.stringify(stub.requests)).not.toContain("LIVE-MACHINE-SECRET")
    expect(stub.requests.length).toBeGreaterThan(0)
  }, 30_000)
})

if (!run) {
  describe("codex spoke against the real codex app-server", () => {
    test.skip("set HUB_IT_CODEX=1 with `codex` on PATH to run packages/codex/test/live.it.test.ts", () => {})
  })
}
