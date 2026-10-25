// Console controls by harness features and evidence (P7-T10, decision fx04e42c): an OpenCode session keeps every
// control; another harness's session shows only what its spoke announced, an evidence badge, and honest delivery labels.
import { describe, expect, test } from "bun:test"
import { deliveryNote, evidenceBadge, messageDeliveryLabel, promptGate, sessionControls, unsupportedNotice } from "../web/src/core/harness-core"

const claude = (features: string[], evidence = "hooks") => ({ harness: "claude-code", evidence, features })

describe("sessionControls", () => {
  test("an OpenCode process (no harness, or harness opencode) keeps every control whatever it lists", () => {
    for (const p of [undefined, {}, { harness: "opencode", evidence: "native", features: [] as string[] }]) {
      const c = sessionControls(p)
      expect(c.native).toBe(true)
      expect(c.harness).toBe("opencode")
      for (const key of ["turn", "steer", "interrupt", "stop", "permission", "form", "models", "timeline", "summary", "voice"] as const) expect(c[key]).toBe(true)
      expect(c.queued).toBe(false)
    }
  })

  test("another harness gets only the controls its features announce", () => {
    const c = sessionControls(claude(["permission", "stop"]))
    expect(c.native).toBe(false)
    expect(c.harness).toBe("claude-code")
    expect(c.harnessName).toBe("Claude Code")
    expect(c.evidence).toBe("hooks")
    expect({ turn: c.turn, steer: c.steer, interrupt: c.interrupt, form: c.form, models: c.models, timeline: c.timeline, summary: c.summary, voice: c.voice }).toEqual({
      turn: false, steer: false, interrupt: false, form: false, models: false, timeline: false, summary: false, voice: false,
    })
    expect(c.permission).toBe(true)
    expect(c.stop).toBe(true)
  })

  test("Voice mode needs conversation and steer; models, timeline and summary their own features", () => {
    const c = sessionControls(claude(["turn", "steer", "conversation", "models", "timeline", "summary"]))
    expect(c.voice && c.models && c.timeline && c.summary && c.turn && c.steer).toBe(true)
    expect(sessionControls(claude(["conversation"])).voice).toBe(false)
  })

  test("hooks, screen and unknown evidence deliver queued; native and rpc do not", () => {
    expect(sessionControls(claude([], "hooks")).queued).toBe(true)
    expect(sessionControls(claude([], "screen")).queued).toBe(true)
    expect(sessionControls(claude([], "rpc")).queued).toBe(false)
    expect(sessionControls(claude([], "native")).queued).toBe(false)
    const unknown = sessionControls({ harness: "aider", evidence: "telepathy", features: [] })
    expect(unknown.evidence).toBe("unknown")
    expect(unknown.queued).toBe(true)
    expect(unknown.harnessName).toBe("aider")
    expect(sessionControls({ harness: "codex", evidence: "rpc", features: [] }).harnessName).toBe("Codex")
  })

  test("a hub that lists no features (older hub) leaves the controls on; the hub's 409 says what is unsupported", () => {
    const c = sessionControls({ harness: "claude-code", evidence: "hooks" })
    expect(c.turn && c.steer && c.stop && c.permission && c.form && c.timeline).toBe(true)
    expect(c.queued).toBe(true)
  })
})

describe("evidenceBadge", () => {
  test("none for an OpenCode session", () => {
    expect(evidenceBadge(sessionControls(undefined))).toBeUndefined()
  })

  test("each level has a short label and an explanation naming the harness", () => {
    const labels: Record<string, string> = { native: "Native", hooks: "Hooks", rpc: "RPC", screen: "Screen", unknown: "Unknown" }
    for (const [evidence, label] of Object.entries(labels)) {
      const badge = evidenceBadge(sessionControls(claude([], evidence)))!
      expect(badge.level).toBe(evidence as never)
      expect(badge.label).toBe(label)
      expect(badge.detail).toContain("Claude Code")
      expect(badge.detail.length).toBeGreaterThan(20)
    }
    expect(evidenceBadge(sessionControls(claude([], "screen")))!.detail).toMatch(/never counts as idle/)
    expect(evidenceBadge(sessionControls(claude([], "unknown")))!.detail).toMatch(/never counts as idle/)
    expect(evidenceBadge(sessionControls(claude([], "hooks")))!.detail).toMatch(/queued/)
  })
})

describe("promptGate", () => {
  test("OpenCode: the composer as before", () => {
    expect(promptGate(sessionControls(undefined), false)).toEqual({ show: true, allowed: true })
    expect(promptGate(sessionControls(undefined), true)).toEqual({ show: true, allowed: true })
  })

  test("no turn and no steer: no prompt box, a note says why", () => {
    const gate = promptGate(sessionControls(claude(["permission", "stop"])), false)
    expect(gate.show).toBe(false)
    expect(gate.allowed).toBe(false)
    expect(gate.hint).toMatch(/Claude Code/)
    expect(gate.hint).toMatch(/terminal/)
  })

  test("turn without steer: typing while it runs is disabled with a hint", () => {
    const c = sessionControls(claude(["turn"]))
    expect(promptGate(c, false)).toEqual({ show: true, allowed: true })
    const running = promptGate(c, true)
    expect(running.show).toBe(true)
    expect(running.allowed).toBe(false)
    expect(running.hint).toMatch(/idle/)
  })

  test("steer without turn: only while it runs", () => {
    const c = sessionControls(claude(["steer"]))
    expect(promptGate(c, true)).toEqual({ show: true, allowed: true })
    const idle = promptGate(c, false)
    expect(idle.allowed).toBe(false)
    expect(idle.hint).toMatch(/runs/)
  })
})

describe("deliveryNote", () => {
  test("OpenCode: steered and accepted are sent, a result is heard; a steer says so", () => {
    const c = sessionControls(undefined)
    expect(deliveryNote(c, "steered")).toEqual({ tick: "sent", toast: "Steered the running session" })
    expect(deliveryNote(c, "accepted")).toEqual({ tick: "sent" })
    expect(deliveryNote(c, "result")).toEqual({ tick: "heard" })
  })

  test("queued delivery: never claims steered or delivered", () => {
    const c = sessionControls(claude(["turn", "steer"]))
    const steered = deliveryNote(c, "steered")
    expect(steered.tick).toBe("queued")
    expect(steered.toast).toMatch(/^Queued/)
    expect(steered.toast).not.toMatch(/Steered/)
    expect(deliveryNote(c, "accepted").tick).toBe("queued")
    expect(deliveryNote(c, "result").tick).toBe("heard")
  })

  test("rpc delivery is confirmed like OpenCode's", () => {
    expect(deliveryNote(sessionControls({ harness: "codex", evidence: "rpc", features: ["turn", "steer"] }), "steered").tick).toBe("sent")
  })
})

describe("messageDeliveryLabel", () => {
  test("only messages not (yet) delivered get a label", () => {
    expect(messageDeliveryLabel("queued")).toBe("queued")
    expect(messageDeliveryLabel("retained")).toBe("held")
    expect(messageDeliveryLabel("pending")).toBe("pending")
    expect(messageDeliveryLabel("steer")).toBeUndefined()
    expect(messageDeliveryLabel("turn")).toBeUndefined()
    expect(messageDeliveryLabel(undefined)).toBeUndefined()
    expect(messageDeliveryLabel(42)).toBeUndefined()
  })
})

describe("unsupportedNotice", () => {
  test("a 409 code unsupported becomes a clear notice", () => {
    const text = unsupportedNotice({ status: 409, code: "unsupported", message: "The claude-code spoke does not support stop" })
    expect(text).toBe("Not available for this session: the claude-code spoke does not support stop. Use its terminal.")
  })

  test("anything else is not an unsupported answer", () => {
    expect(unsupportedNotice({ status: 409, code: "gone", message: "x" })).toBeUndefined()
    expect(unsupportedNotice({ status: 400, code: "unsupported", message: "x" })).toBeUndefined()
    expect(unsupportedNotice(new Error("boom"))).toBeUndefined()
    expect(unsupportedNotice(undefined)).toBeUndefined()
  })

  test("an empty message still says what happened", () => {
    expect(unsupportedNotice({ status: 409, code: "unsupported", message: "" })).toBe("Not available for this session. Use its terminal.")
  })
})
