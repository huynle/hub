// Spoken progress cues in conversation mode: pure scheduler with injected time.
import { describe, expect, test } from "bun:test"
import { CUE_PHRASES, CueScheduler, isWorking, subagentChanges } from "../web/src/core/feedback-core"

const speak = (cue: "working" | "subagent" | "still") => [{ type: "speak" as const, cue, text: CUE_PHRASES[cue] }]

describe("CueScheduler", () => {
  test("phrases", () => {
    expect(CUE_PHRASES).toEqual({ working: "Working on it.", subagent: "Started a subagent.", still: "Still working." })
  })

  test("heard plays a soft earcon right away", () => {
    const c = new CueScheduler()
    expect(c.heard(0)).toEqual([{ type: "earcon", name: "heard" }])
  })

  test("heard while the user is talking again: no earcon", () => {
    const c = new CueScheduler()
    c.userTalking(true, 0)
    expect(c.heard(10)).toEqual([])
  })

  test("'Working on it.' 5 s after heard when working and the agent said nothing; only once", () => {
    const c = new CueScheduler()
    c.heard(0)
    c.working(true, 1000)
    expect(c.tick(4999)).toEqual([])
    expect(c.tick(5000)).toEqual(speak("working"))
    expect(c.tick(6000)).toEqual([])
    expect(c.tick(10_000)).toEqual([])
  })

  test("agent speech within 5 s cancels the acknowledgement", () => {
    const c = new CueScheduler()
    c.heard(0)
    c.working(true, 500)
    c.agentSaid(3000)
    expect(c.tick(5000)).toEqual([])
    expect(c.tick(9000)).toEqual([])
  })

  test("not working yet at 5 s: acknowledges once work starts; finished silently: nothing", () => {
    const c = new CueScheduler()
    c.heard(0)
    expect(c.tick(6000)).toEqual([])
    c.working(true, 8000)
    expect(c.tick(8000)).toEqual(speak("working"))

    const d = new CueScheduler()
    d.heard(0)
    d.working(true, 1000)
    d.working(false, 2000)
    expect(d.tick(6000)).toEqual([])
    d.working(true, 7000)
    expect(d.tick(7000)).toEqual([])
  })

  test("never speaks while the user talks, the agent speaks, or a cue plays; waits politely", () => {
    const c = new CueScheduler()
    c.heard(0)
    c.working(true, 0)
    c.userTalking(true, 4500)
    expect(c.tick(5000)).toEqual([])
    c.userTalking(false, 6000)
    expect(c.tick(6000)).toEqual(speak("working"))

    const d = new CueScheduler()
    d.heard(0)
    d.working(true, 0)
    d.cueSpeaking(true, 100)
    expect(d.tick(5000)).toEqual([])
    d.cueSpeaking(false, 5200)
    expect(d.tick(5200)).toEqual(speak("working"))
  })

  test("agent speech playing holds the cue; the say that started it cancels the acknowledgement", () => {
    const c = new CueScheduler()
    c.heard(0)
    c.working(true, 0)
    c.agentSpeaking(true, 4000)
    expect(c.tick(5000)).toEqual([])
    c.agentSpeaking(false, 9000)
    expect(c.tick(9000)).toEqual([])
    c.agentSaid(9500)
    expect(c.tick(20_000)).toEqual([])
  })

  test("'Started a subagent.' unless the agent said something in the last 3 s", () => {
    const c = new CueScheduler()
    c.working(true, 0)
    c.subagentStarted(10_000)
    expect(c.tick(10_000)).toEqual(speak("subagent"))
    expect(c.tick(11_000)).toEqual([])

    const d = new CueScheduler()
    d.working(true, 0)
    d.agentSaid(8000)
    d.subagentStarted(10_000)
    expect(d.tick(10_000)).toEqual([])

    const e = new CueScheduler()
    e.working(true, 0)
    e.agentSaid(6000)
    e.subagentStarted(10_000)
    expect(e.tick(10_000)).toEqual(speak("subagent"))
  })

  test("a pending subagent cue is dropped when the agent speaks first", () => {
    const c = new CueScheduler()
    c.working(true, 0)
    c.userTalking(true, 9000)
    c.subagentStarted(10_000)
    c.agentSaid(10_500)
    c.userTalking(false, 11_000)
    expect(c.tick(11_000)).toEqual([])
  })

  test("the subagent cue also serves as the acknowledgement", () => {
    const c = new CueScheduler()
    c.heard(0)
    c.working(true, 100)
    c.subagentStarted(1000)
    expect(c.tick(1000)).toEqual(speak("subagent"))
    expect(c.tick(5000)).toEqual([])
  })

  test("'Still working.' after 40 s without speech while work continues, at most every 40 s", () => {
    const c = new CueScheduler()
    c.working(true, 0)
    expect(c.tick(39_999)).toEqual([])
    expect(c.tick(40_000)).toEqual(speak("still"))
    expect(c.tick(41_000)).toEqual([])
    c.agentSaid(60_000)
    expect(c.tick(80_000)).toEqual([])
    expect(c.tick(100_000)).toEqual(speak("still"))
    c.working(false, 110_000)
    expect(c.tick(200_000)).toEqual([])
  })

  test("speech playback ending restarts the 40 s quiet window", () => {
    const c = new CueScheduler()
    c.working(true, 0)
    c.agentSpeaking(true, 30_000)
    c.agentSpeaking(false, 35_000)
    expect(c.tick(74_999)).toEqual([])
    expect(c.tick(75_000)).toEqual(speak("still"))
  })

  test("subagent finished: double earcon; nothing while the user talks", () => {
    const c = new CueScheduler()
    expect(c.subagentFinished(0)).toEqual([{ type: "earcon", name: "done" }])
    c.userTalking(true, 1)
    expect(c.subagentFinished(2)).toEqual([])
  })

  test("disabled: no cues at all", () => {
    const c = new CueScheduler()
    c.enabled = false
    expect(c.heard(0)).toEqual([])
    c.working(true, 0)
    c.subagentStarted(100)
    expect(c.subagentFinished(200)).toEqual([])
    expect(c.tick(60_000)).toEqual([])
  })
})

describe("subagentChanges / isWorking", () => {
  const tree = (root: string, kids: Record<string, string>) => [
    { id: "root", title: "Root", state: root },
    ...Object.entries(kids).map(([id, state]) => ({ id, title: id.toUpperCase(), state })),
  ]

  test("started: children now working that were not working or blocked before", () => {
    expect(subagentChanges(undefined, tree("working", { a: "working", b: "idle" }), "root")).toEqual({ started: ["a"], finished: [] })
    expect(subagentChanges(tree("working", { a: "blocked" }), tree("working", { a: "working" }), "root")).toEqual({ started: [], finished: [] })
    expect(subagentChanges(tree("working", { a: "idle" }), tree("working", { a: "working" }), "root")).toEqual({ started: ["a"], finished: [] })
  })

  test("finished: working/blocked children that went idle, failed or dropped out; the root never counts", () => {
    const before = tree("working", { a: "working", b: "blocked", c: "working", d: "idle" })
    const after = tree("idle", { a: "idle", b: "error" })
    expect(subagentChanges(before, after, "root")).toEqual({ started: [], finished: ["a", "b", "c"] })
    expect(subagentChanges(tree("idle", {}), tree("working", {}), "root")).toEqual({ started: [], finished: [] })
  })

  test("isWorking: any session in the tree working (blocked waits for the user)", () => {
    expect(isWorking(tree("idle", { a: "working" }))).toBe(true)
    expect(isWorking(tree("working", {}))).toBe(true)
    expect(isWorking(tree("blocked", { a: "idle" }))).toBe(false)
    expect(isWorking(undefined)).toBe(false)
  })
})
