// The preset spoke against a fake terminal backend: what it announces (only what a pasted terminal can do), how it
// pastes turns and hub messages (never claiming more than "queued"), Ctrl-C for interrupt and stop, and screen
// sampling (native ID from the screen, the session ends with its pane; never an idle claim).
import { describe, expect, test } from "bun:test"
import type { HarnessPreset, ServerRequest } from "../../protocol/src/index.ts"
import { hubSessionID, renderPromptEnvelope } from "../../spoke-sdk/src/index.ts"
import { PresetSpoke, PRESET_SESSION_NAMESPACE } from "../src/spoke.ts"
import type { LaunchRequest, TerminalBackend, TerminalPane } from "../src/tmux.ts"

const UUID = "0b3a1c52-7f00-4d2e-9a43-111111111111"
const GOOSE: HarnessPreset = { name: "goose", command: ["goose", "session"], nativeID: { source: "argv", flag: "--name" }, delivery: "paste", evidence: "screen" }
const SCREEN: HarnessPreset = { name: "scr", command: ["scr", "-i"], nativeID: { source: "screen", pattern: "session: (\\w+)" }, delivery: "paste", evidence: "screen" }

function fakeBackend(options: { canSendKeys?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const state = { alive: true, screen: "" }
  const backend: TerminalBackend = {
    kind: "tmux",
    canSendKeys: options.canSendKeys ?? true,
    async launch(req: LaunchRequest) {
      calls.push(["launch", req])
      return { session: req.name, window: "@1", target: "%1" }
    },
    async paste(pane: TerminalPane, text: string, o: { submit: boolean }) {
      calls.push(["paste", pane.target, text, o.submit])
    },
    async interrupt(pane: TerminalPane) {
      calls.push(["interrupt", pane.target])
    },
    async capture(pane: TerminalPane, lines: number) {
      calls.push(["capture", pane.target, lines])
      return state.screen
    },
    async alive() {
      return state.alive
    },
    async kill(pane: TerminalPane) {
      calls.push(["kill", pane.target])
    },
    attachHint: (pane) => `tmux -L t attach -t ${pane.session}`,
  }
  return { backend, calls, state }
}

function makeSpoke(preset: HarnessPreset = GOOSE, backendOptions: { canSendKeys?: boolean } = {}) {
  const fake = fakeBackend(backendOptions)
  const spoke = new PresetSpoke({ preset, backend: fake.backend, server: "http://127.0.0.1:1", token: "hubm_unused", pluginVersion: "0.0.1", directory: "/work", newID: () => UUID, now: () => 1000 })
  return { spoke, ...fake }
}

const deliver = (sessionID: string, over: Partial<Extract<ServerRequest, { op: "deliver" }>> = {}): ServerRequest => ({
  op: "deliver",
  sessionID,
  messageID: "msg_1",
  text: "[hub] message from @a\nhello",
  wake: true,
  meta: { kind: "msg", from: "@a", to: "@b" },
  ...over,
})

describe("hello", () => {
  test("screen evidence, the preset's name as harness; turn, interrupt, stop and deliver; never permission, form or steer", () => {
    const { spoke } = makeSpoke()
    expect(spoke.spoke.harness).toBe("goose")
    expect([...spoke.spoke.features].sort()).toEqual(["actTokens", "deliver", "hubPrompt", "interrupt", "sessionTokens", "stop", "turn"])
    expect(spoke.evidence).toBe("screen")
  })

  test("a backend that cannot send keys: no interrupt, no stop", () => {
    const { spoke } = makeSpoke(GOOSE, { canSendKeys: false })
    expect(spoke.spoke.features).not.toContain("interrupt")
    expect(spoke.spoke.features).not.toContain("stop")
    expect(spoke.spoke.features).toContain("turn")
  })
})

describe("launch", () => {
  test("starts the argv in a new pane and reports the session under a hub ID; an argv native ID is reported, not observed", async () => {
    const { spoke, calls } = makeSpoke()
    const launched = await spoke.launch({ cwd: "/work/repo", args: ["--debug"] })
    expect(calls[0]).toEqual(["launch", { argv: ["goose", "session", "--name", UUID, "--debug"], cwd: "/work/repo", name: "hub-goose-0b3a1c52" }])
    expect(launched).toEqual({
      sessionID: hubSessionID(PRESET_SESSION_NAMESPACE, UUID),
      pane: { session: "hub-goose-0b3a1c52", window: "@1", target: "%1" },
      nativeID: { id: UUID, how: "reported, not observed (passed with --name)" },
      attach: "tmux -L t attach -t hub-goose-0b3a1c52",
    })
    expect(spoke.spoke.sessions()).toEqual([{ id: launched.sessionID, title: "goose · repo", directory: "/work/repo", updated: 1000, owned: true, open: true }])
  })

  test("a screen native ID is not known at launch", async () => {
    const { spoke } = makeSpoke(SCREEN)
    expect((await spoke.launch({ cwd: "/w" })).nativeID).toBeUndefined()
  })
})

describe("ops", () => {
  test("turn: pasted and submitted; the hub is told it is unconfirmed (timeout, no reply), never succeeded", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    expect(await spoke.spoke.dispatch({ op: "turn", sessionID, text: "fix the bug", voiceStyle: false })).toEqual({ outcome: "timeout", reply: "" })
    expect(calls.at(-1)).toEqual(["paste", "%1", "fix the bug", true])
  })

  test("turn with images is refused (a terminal paste carries text only)", async () => {
    const { spoke } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    await expect(spoke.spoke.dispatch({ op: "turn", sessionID, text: "x", voiceStyle: false, images: [{ mime: "image/png", data: "AA==" }] })).rejects.toThrow(/images/)
  })

  test("deliver with wake: pasted and submitted once per messageID, answered queued", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    const first = await spoke.spoke.dispatch(deliver(sessionID))
    const again = await spoke.spoke.dispatch(deliver(sessionID))
    expect(first).toEqual({ delivered: "queued" })
    expect(again).toEqual(first)
    expect(calls.filter((c) => c[0] === "paste")).toEqual([["paste", "%1", "[hub] message from @a\nhello", true]])
  })

  test("deliver without wake: retained (nothing typed into the user's input line), pasted ahead of the next turn", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    expect(await spoke.spoke.dispatch(deliver(sessionID, { wake: false }))).toEqual({ delivered: "retained" })
    expect(calls.some((c) => c[0] === "paste")).toBe(false)
    await spoke.spoke.dispatch({ op: "turn", sessionID, text: "go", voiceStyle: false })
    expect(calls.filter((c) => c[0] === "paste")).toEqual([["paste", "%1", "[hub] message from @a\nhello\n\ngo", true]])
  })

  test("a retained message asked again with wake is pasted once, then not again", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    await spoke.spoke.dispatch(deliver(sessionID, { wake: false }))
    expect(await spoke.spoke.dispatch(deliver(sessionID))).toEqual({ delivered: "queued" })
    await spoke.spoke.dispatch({ op: "turn", sessionID, text: "go", voiceStyle: false })
    expect(calls.filter((c) => c[0] === "paste")).toEqual([
      ["paste", "%1", "[hub] message from @a\nhello", true],
      ["paste", "%1", "go", true],
    ])
  })

  test("a prompt (hubPrompt) is pasted in its provenance envelope", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    await spoke.spoke.dispatch(deliver(sessionID, { text: "do it", meta: { kind: "prompt", from: "@a", to: "@b", grant: "grt_1" } }))
    expect(calls.at(-1)).toEqual(["paste", "%1", renderPromptEnvelope({ messageID: "msg_1", from: "@a", grant: "grt_1", text: "do it" }), true])
  })

  test("interrupt and stop send Ctrl-C", async () => {
    const { spoke, calls } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    expect(await spoke.spoke.dispatch({ op: "interrupt", sessionID })).toEqual({})
    expect(await spoke.spoke.dispatch({ op: "stop", sessionID })).toEqual({ stopped: [sessionID] })
    expect(calls.filter((c) => c[0] === "interrupt")).toEqual([
      ["interrupt", "%1"],
      ["interrupt", "%1"],
    ])
  })

  test("permission, form and steer are refused (not announced)", async () => {
    const { spoke } = makeSpoke()
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    await expect(spoke.spoke.dispatch({ op: "permission", sessionID, requestID: "per_1", decision: "once" })).rejects.toThrow(/not announced/)
    await expect(spoke.spoke.dispatch({ op: "steer", sessionID, text: "x" })).rejects.toThrow(/not announced/)
  })
})

describe("screen sampling", () => {
  test("reads the native ID off the screen once, and never sends an event (no idle claim on screen evidence)", async () => {
    const { spoke, state } = makeSpoke(SCREEN)
    const sent: unknown[] = []
    spoke.spoke.emit = ((e: unknown) => (sent.push(e), true)) as typeof spoke.spoke.emit
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    state.screen = "booting"
    await spoke.sample()
    expect(spoke.nativeID(sessionID)).toBeUndefined()
    state.screen = "session: abc123\nsession: later"
    await spoke.sample()
    expect(spoke.nativeID(sessionID)).toEqual({ id: "abc123", how: "read off the screen" })
    state.screen = "session: other"
    await spoke.sample()
    expect(spoke.nativeID(sessionID)?.id).toBe("abc123")
    expect(sent).toEqual([])
  })

  test("a pane that is gone ends the session", async () => {
    const { spoke, state } = makeSpoke()
    const ended: string[] = []
    spoke.onEnd((id) => ended.push(id))
    const { sessionID } = await spoke.launch({ cwd: "/w" })
    state.alive = false
    await spoke.sample()
    expect(spoke.spoke.sessions()).toEqual([])
    expect(ended).toEqual([sessionID])
  })
})
