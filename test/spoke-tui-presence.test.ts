import { afterEach, describe, expect, test } from "bun:test"
import { PresenceReporter, shownSessions } from "../src/tui-presence"

const reporters: PresenceReporter[] = []
afterEach(() => {
  for (const r of reporters.splice(0)) r.stop()
})

describe("shownSessions", () => {
  test("the current route's root session plus open tabs, deduplicated", () => {
    const root = (id: string) => (id === "ses_kid" ? "ses_a" : id)
    expect(shownSessions({ route: { type: "session", sessionID: "ses_kid" }, root, tabs: ["ses_b", "ses_a"] })).toEqual(["ses_a", "ses_b"])
    expect(shownSessions({ route: { type: "home" }, root, tabs: [] })).toEqual([])
    expect(shownSessions({ route: { type: "session", sessionID: "ses_x" }, root: () => { throw new Error("no data") }, tabs: undefined })).toEqual(["ses_x"])
  })
})

describe("PresenceReporter", () => {
  test("sends at start, on change (polled), and as a heartbeat; failures are ignored", async () => {
    let shown = ["ses_a"]
    const sent: string[][] = []
    let fail = false
    const reporter = new PresenceReporter({
      read: () => shown,
      send: async (ids) => {
        sent.push([...ids])
        if (fail) throw new Error("server gone")
      },
      pollMs: 10,
      heartbeatMs: 80,
    })
    reporters.push(reporter)
    reporter.start()
    await Bun.sleep(30)
    expect(sent).toEqual([["ses_a"]])
    shown = ["ses_a", "ses_b"]
    await Bun.sleep(30)
    expect(sent).toEqual([["ses_a"], ["ses_a", "ses_b"]])
    fail = true
    await Bun.sleep(80)
    expect(sent.length).toBeGreaterThanOrEqual(3)
    expect(sent.at(-1)).toEqual(["ses_a", "ses_b"])
    reporter.stop()
    const count = sent.length
    await Bun.sleep(100)
    expect(sent.length).toBe(count)
  })

  test("a read that throws reports nothing for that tick", async () => {
    const sent: string[][] = []
    const reporter = new PresenceReporter({
      read: () => {
        throw new Error("renderer gone")
      },
      send: async (ids) => void sent.push([...ids]),
      pollMs: 10,
      heartbeatMs: 1000,
    })
    reporters.push(reporter)
    reporter.start()
    await Bun.sleep(40)
    expect(sent).toEqual([])
  })
})
