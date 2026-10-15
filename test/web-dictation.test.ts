// Dictation (the composer's mic button, web/src/core/dictation-core.ts) and per-session drafts: the text lands
// in the draft of the session that was on screen when recording started, never anywhere else and never sent;
// leaving that session mid-recording cancels; a recording that is still starting when the user leaves is
// cancelled as soon as it exists (no orphan mic).
import { describe, expect, test } from "bun:test"
import { Dictation, type Recording } from "../web/src/core/dictation-core"
import { Drafts } from "../web/src/lib/composer"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness() {
  const drafts = new Drafts()
  const delivered: Array<[string, string]> = []
  const notes: Array<[string, string | undefined]> = []
  const recordings: Array<{ cancelled: boolean; finished: boolean; text: ReturnType<typeof deferred<string>>; tick?: (s: number) => void }> = []
  let starting = deferred<void>()
  let autoStart = true
  let held = 0
  const dictation = new Dictation({
    record: async (onTick) => {
      const rec = { cancelled: false, finished: false, text: deferred<string>(), tick: onTick }
      recordings.push(rec)
      if (!autoStart) await starting.promise
      const recording: Recording = {
        finish: () => {
          rec.finished = true
          return rec.text.promise
        },
        cancel: () => {
          rec.cancelled = true
        },
      }
      return recording
    },
    deliver: (sessionID, text) => {
      delivered.push([sessionID, text])
      drafts.append(sessionID, text)
    },
    notify: (text, kind) => notes.push([text, kind]),
    hold: () => {
      held++
      return () => held--
    },
  })
  return {
    dictation,
    drafts,
    delivered,
    notes,
    recordings,
    held: () => held,
    manualStart() {
      autoStart = false
      starting = deferred<void>()
      return starting
    },
  }
}

describe("Dictation", () => {
  test("records in session A and puts the text into A's draft only (nothing is sent)", async () => {
    const h = harness()
    h.drafts.set("A", "Fix the")
    h.drafts.set("B", "unrelated")
    await h.dictation.toggle("A")
    expect(h.dictation.state).toMatchObject({ phase: "recording", sessionID: "A", secondsLeft: 60 })
    expect(h.dictation.forSession("A")).toEqual({ recording: 60, transcribing: false })
    expect(h.dictation.forSession("B")).toEqual({ recording: false, transcribing: false })
    const done = h.dictation.toggle("A")
    expect(h.dictation.state.phase).toBe("transcribing")
    h.recordings[0]!.text.resolve("login bug")
    await done
    expect(h.delivered).toEqual([["A", "login bug"]])
    expect(h.drafts.get("A")).toBe("Fix the login bug")
    expect(h.drafts.get("B")).toBe("unrelated")
    expect(h.dictation.state).toEqual({ phase: "idle" })
  })

  test("the text goes to the session where recording started, even if finished from elsewhere", async () => {
    const h = harness()
    await h.dictation.toggle("A")
    // The mic button of another session does not finish A's recording into B.
    await h.dictation.toggle("B")
    expect(h.recordings).toHaveLength(1)
    expect(h.dictation.state).toMatchObject({ phase: "recording", sessionID: "A" })
    const done = h.dictation.toggle("A")
    h.recordings[0]!.text.resolve("hello")
    await done
    expect(h.delivered).toEqual([["A", "hello"]])
  })

  test("leaving the session mid-recording cancels it: nothing is transcribed or delivered", async () => {
    const h = harness()
    await h.dictation.toggle("A")
    h.dictation.viewing("B")
    expect(h.recordings[0]!.cancelled).toBe(true)
    expect(h.recordings[0]!.finished).toBe(false)
    expect(h.dictation.state).toEqual({ phase: "idle" })
    expect(h.notes.at(-1)?.[0]).toMatch(/Dictation cancelled/)
    expect(h.delivered).toEqual([])
    // Viewing the same session is not a navigation.
    await h.dictation.toggle("A")
    h.dictation.viewing("A")
    expect(h.recordings[1]!.cancelled).toBe(false)
  })

  test("leaving while the microphone is still starting cancels the recording as soon as it exists", async () => {
    const h = harness()
    const starting = h.manualStart()
    const toggled = h.dictation.toggle("A")
    expect(h.dictation.state).toMatchObject({ phase: "starting", sessionID: "A" })
    h.dictation.viewing("B")
    expect(h.dictation.state).toEqual({ phase: "idle" })
    starting.resolve()
    await toggled
    expect(h.recordings[0]!.cancelled).toBe(true)
    expect(h.dictation.state).toEqual({ phase: "idle" })
    expect(h.delivered).toEqual([])
  })

  test("leaving while transcribing still delivers to the original session's draft", async () => {
    const h = harness()
    await h.dictation.toggle("A")
    const done = h.dictation.toggle("A")
    h.dictation.viewing("B")
    h.recordings[0]!.text.resolve("keep me")
    await done
    expect(h.delivered).toEqual([["A", "keep me"]])
  })

  test("nothing heard, a transcription error, or a refused microphone are reported; the mic is held only while recording", async () => {
    const h = harness()
    await h.dictation.toggle("A")
    expect(h.held()).toBe(1)
    let done = h.dictation.toggle("A")
    h.recordings[0]!.text.resolve("")
    await done
    expect(h.notes.at(-1)).toEqual(["Didn't catch that. Try again.", "warn"])
    expect(h.held()).toBe(0)
    await h.dictation.toggle("A")
    done = h.dictation.toggle("A")
    h.recordings[1]!.text.reject(new Error("Transcription failed: 502"))
    await done
    expect(h.notes.at(-1)).toEqual(["Transcription failed: 502", "err"])
    expect(h.held()).toBe(0)
    expect(h.delivered).toEqual([])

    const refused = new Dictation({ record: async () => Promise.reject(new Error("Microphone permission was denied.")), deliver: () => {}, notify: (t, k) => h.notes.push([t, k]) })
    await refused.toggle("A")
    expect(refused.state).toEqual({ phase: "idle" })
    expect(h.notes.at(-1)).toEqual(["Microphone permission was denied.", "err"])
  })

  test("the countdown updates secondsLeft and notifies listeners", async () => {
    const h = harness()
    const seen: string[] = []
    h.dictation.subscribe(() => seen.push(`${h.dictation.state.phase}:${h.dictation.state.secondsLeft ?? ""}`))
    await h.dictation.toggle("A")
    h.recordings[0]!.tick!(42)
    expect(h.dictation.forSession("A").recording).toBe(42)
    expect(seen).toContain("recording:42")
  })
})

describe("Drafts", () => {
  test("each session keeps its own draft; appended dictation joins with a space", () => {
    const drafts = new Drafts()
    expect(drafts.get("A")).toBe("")
    drafts.set("A", "first  ")
    expect(drafts.append("A", "second")).toBe("first second")
    expect(drafts.append("B", "only B")).toBe("only B")
    expect(drafts.get("A")).toBe("first second")
    drafts.set("A", "")
    expect(drafts.get("A")).toBe("")
  })

  test("listeners hear which session's draft changed", () => {
    const drafts = new Drafts()
    const changed: string[] = []
    const off = drafts.subscribe((id) => changed.push(id))
    drafts.set("A", "x")
    drafts.append("B", "y")
    drafts.set("A", "x") // unchanged: no event
    off()
    drafts.set("A", "z")
    expect(changed).toEqual(["A", "B"])
  })
})
