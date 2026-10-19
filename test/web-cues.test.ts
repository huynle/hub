// Spoken progress cues in conversation mode: pure scheduler with injected time (ackMs pinned at 5 s here;
// the 2.5 s default and the event-driven CueClock are tested in web-cue-clock).
import { describe, expect, test } from "bun:test"
import { CUE_VARIANTS, CuePicker, CueScheduler, cueTexts, isWorking, subagentChanges, type CueName } from "../web/src/core/feedback-core"

const speak = (cue: CueName) => [{ type: "speak" as const, cue, text: expect.any(String) }]

/** Deterministic RNG (mulberry32) so picks are reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("cue phrases", () => {
  test("each kind has several short spoken variants, none of the old fixed phrases", () => {
    expect(CUE_VARIANTS.working.length).toBeGreaterThanOrEqual(8)
    expect(CUE_VARIANTS.subagent.length).toBeGreaterThanOrEqual(4)
    expect(CUE_VARIANTS.still.length).toBeGreaterThanOrEqual(4)
    const all = Object.values(CUE_VARIANTS).flat()
    expect(new Set(all).size).toBe(all.length)
    for (const text of all) expect(text.replace(/[.,!?]/g, "").split(/\s+/).length).toBeLessThanOrEqual(6)
    expect(all).not.toContain("Working on it.")
    expect(all).not.toContain("Started a subagent.")
  })

  test("cueTexts interleaves kinds so the first of each kind is fetched first", () => {
    const texts = cueTexts()
    expect(texts.slice(0, 3)).toEqual([CUE_VARIANTS.working[0]!, CUE_VARIANTS.subagent[0]!, CUE_VARIANTS.still[0]!])
    expect([...texts].sort()).toEqual(Object.values(CUE_VARIANTS).flat().sort())
  })
})

describe("CuePicker", () => {
  test("never repeats the last phrase of a kind and uses every variant before reusing one", () => {
    const p = new CuePicker({ rng: rng(1) })
    const n = CUE_VARIANTS.working.length
    const picks = Array.from({ length: n * 4 }, () => p.pick("working"))
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
    for (let r = 0; r < 4; r++) expect(new Set(picks.slice(r * n, (r + 1) * n)).size).toBe(n)
    for (const t of picks) expect(CUE_VARIANTS.working).toContain(t)
  })

  test("deterministic under an injected RNG; rounds are reshuffled", () => {
    const a = new CuePicker({ rng: rng(7) })
    const b = new CuePicker({ rng: rng(7) })
    const seq = (p: CuePicker) => Array.from({ length: 30 }, () => p.pick("working"))
    const first = seq(a)
    expect(seq(b)).toEqual(first)
    const n = CUE_VARIANTS.working.length
    expect(first.slice(n, 2 * n)).not.toEqual(first.slice(0, n))
  })

  test("kinds are independent", () => {
    const p = new CuePicker({ rng: rng(3) })
    expect(CUE_VARIANTS.still).toContain(p.pick("still"))
    expect(CUE_VARIANTS.subagent).toContain(p.pick("subagent"))
  })

  test("prefers a ready (cached) variant; never the last one", () => {
    const ready = new Set([CUE_VARIANTS.working[2]!, CUE_VARIANTS.working[5]!])
    const p = new CuePicker({ rng: rng(9), ready: (t) => ready.has(t) })
    const picks = Array.from({ length: 6 }, () => p.pick("working"))
    for (const t of picks) expect(ready.has(t)).toBe(true)
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
  })

  test("only the last phrase ready: picks a fresh one (pending tone) rather than repeat", () => {
    const only = CUE_VARIANTS.still[0]!
    const p = new CuePicker({ rng: rng(2), ready: (t) => t === only })
    expect(p.pick("still")).toBe(only)
    expect(p.pick("still")).not.toBe(only)
  })

  test("nothing ready: still picks a variant (the player plays the pending tone and loads it)", () => {
    const p = new CuePicker({ rng: rng(4), ready: () => false })
    expect(CUE_VARIANTS.subagent).toContain(p.pick("subagent"))
  })
})

describe("CueScheduler phrase choice", () => {
  test("speaks the picker's phrase for the cue", () => {
    const c = new CueScheduler({ ackMs: 10, pick: (cue) => `pick:${cue}` })
    c.heard(0)
    c.working(true, 0)
    expect(c.tick(10)).toEqual([{ type: "speak", cue: "working", text: "pick:working" }])
  })

  test("default picker varies the acknowledgement between turns", () => {
    const c = new CueScheduler({ ackMs: 10 })
    const said: string[] = []
    for (let i = 0; i < 6; i++) {
      const t = i * 1000
      c.heard(t)
      c.working(true, t)
      const [cue] = c.tick(t + 10)
      said.push((cue as { text: string }).text)
      c.cueSpeaking(false, t + 20)
      c.working(false, t + 30)
    }
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1])
    for (const t of said) expect(CUE_VARIANTS.working).toContain(t)
  })
})


describe("CueScheduler", () => {
  test("heard plays a soft earcon right away", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    expect(c.heard(0)).toEqual([{ type: "earcon", name: "heard" }])
  })

  test("end of speech plays the heard earcon at once; the hub's heard can skip it (already acknowledged)", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.userTalking(true, 0)
    expect(c.speechEnded(100)).toEqual([{ type: "earcon", name: "heard" }])
    expect(c.gated).toBe(false)
    expect(c.heard(400, { tone: false })).toEqual([])
    const off = new CueScheduler({ ackMs: 5000 })
    off.enabled = false
    expect(off.speechEnded(0)).toEqual([])
  })

  test("heard while the user is talking again: no earcon", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.userTalking(true, 0)
    expect(c.heard(10)).toEqual([])
  })

  test("the acknowledgement 5 s after heard when working and the agent said nothing; only once", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    c.working(true, 1000)
    expect(c.tick(4999)).toEqual([])
    expect(c.tick(5000)).toEqual(speak("working"))
    expect(c.tick(6000)).toEqual([])
    expect(c.tick(10_000)).toEqual([])
  })

  test("agent speech within 5 s cancels the acknowledgement", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    c.working(true, 500)
    c.agentSaid(3000)
    expect(c.tick(5000)).toEqual([])
    expect(c.tick(9000)).toEqual([])
  })

  test("not working yet at 5 s: acknowledges once work starts; finished silently: nothing", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    expect(c.tick(6000)).toEqual([])
    c.working(true, 8000)
    expect(c.tick(8000)).toEqual(speak("working"))

    const d = new CueScheduler({ ackMs: 5000 })
    d.heard(0)
    d.working(true, 1000)
    d.working(false, 2000)
    expect(d.tick(6000)).toEqual([])
    d.working(true, 7000)
    expect(d.tick(7000)).toEqual([])
  })

  test("never speaks while the user talks, the agent speaks, or a cue plays; waits politely", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    c.working(true, 0)
    c.userTalking(true, 4500)
    expect(c.tick(5000)).toEqual([])
    c.userTalking(false, 6000)
    expect(c.tick(6000)).toEqual(speak("working"))

    const d = new CueScheduler({ ackMs: 5000 })
    d.heard(0)
    d.working(true, 0)
    d.cueSpeaking(true, 100)
    expect(d.tick(5000)).toEqual([])
    d.cueSpeaking(false, 5200)
    expect(d.tick(5200)).toEqual(speak("working"))
  })

  test("agent speech playing holds the cue; the say that started it cancels the acknowledgement", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    c.working(true, 0)
    c.agentSpeaking(true, 4000)
    expect(c.tick(5000)).toEqual([])
    c.agentSpeaking(false, 9000)
    expect(c.tick(9000)).toEqual([])
    c.agentSaid(9500)
    expect(c.tick(20_000)).toEqual([])
  })

  test("the subagent cue unless the agent said something in the last 3 s", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.working(true, 0)
    c.subagentStarted(10_000)
    expect(c.tick(10_000)).toEqual(speak("subagent"))
    expect(c.tick(11_000)).toEqual([])

    const d = new CueScheduler({ ackMs: 5000 })
    d.working(true, 0)
    d.agentSaid(8000)
    d.subagentStarted(10_000)
    expect(d.tick(10_000)).toEqual([])

    const e = new CueScheduler({ ackMs: 5000 })
    e.working(true, 0)
    e.agentSaid(6000)
    e.subagentStarted(10_000)
    expect(e.tick(10_000)).toEqual(speak("subagent"))
  })

  test("a pending subagent cue is dropped when the agent speaks first", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.working(true, 0)
    c.userTalking(true, 9000)
    c.subagentStarted(10_000)
    c.agentSaid(10_500)
    c.userTalking(false, 11_000)
    expect(c.tick(11_000)).toEqual([])
  })

  test("the subagent cue also serves as the acknowledgement", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    c.heard(0)
    c.working(true, 100)
    c.subagentStarted(1000)
    expect(c.tick(1000)).toEqual(speak("subagent"))
    expect(c.tick(5000)).toEqual([])
  })

  test("the still-working cue after 40 s without speech while work continues, at most every 40 s", () => {
    const c = new CueScheduler({ ackMs: 5000 })
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
    const c = new CueScheduler({ ackMs: 5000 })
    c.working(true, 0)
    c.agentSpeaking(true, 30_000)
    c.agentSpeaking(false, 35_000)
    expect(c.tick(74_999)).toEqual([])
    expect(c.tick(75_000)).toEqual(speak("still"))
  })

  test("subagent finished: double earcon; nothing while the user talks", () => {
    const c = new CueScheduler({ ackMs: 5000 })
    expect(c.subagentFinished(0)).toEqual([{ type: "earcon", name: "done" }])
    c.userTalking(true, 1)
    expect(c.subagentFinished(2)).toEqual([])
  })

  test("disabled: no cues at all", () => {
    const c = new CueScheduler({ ackMs: 5000 })
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
