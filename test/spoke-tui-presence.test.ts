import { afterEach, describe, expect, test } from "bun:test"
import { PresenceReporter, shownSessions } from "../src/tui-presence"

const reporters: PresenceReporter[] = []
async function waitFor(check: () => boolean, description: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(10)
  }
}

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
    await waitFor(() => sent.length >= 1, "initial presence report")
    expect(sent[0]).toEqual(["ses_a"])
    shown = ["ses_a", "ses_b"]
    await waitFor(() => sent.some((ids) => ids.length === 2), "changed presence report")
    const changed = sent.findIndex((ids) => ids.length === 2)
    expect(sent.slice(changed)).toEqual(sent.slice(changed).map(() => ["ses_a", "ses_b"]))
    fail = true
    const beforeFailure = sent.length
    await waitFor(() => sent.length > beforeFailure, "heartbeat retry after failure")
    expect(sent.at(-1)).toEqual(["ses_a", "ses_b"])
    reporter.stop()
    const count = sent.length
    // This checks the absence of timer callbacks, so wait longer than both configured intervals.
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
