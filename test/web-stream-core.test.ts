// The console's live stream policy: pause while hidden, resume with the last event id, reconnect a dead stream.
import { describe, expect, test } from "bun:test"
import { HIDDEN_CLOSE_MS, STALE_MS, StreamKeeper, streamURL } from "../web/src/core/stream-core"

function setup(keepOpen = () => false) {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  const log: string[] = []
  const keeper = new StreamKeeper({
    setTimer: (fn, ms) => {
      const id = next++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
    open: (url) => log.push(`open ${url}`),
    close: () => log.push("close"),
    keepOpen,
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers = timers.filter((t) => t !== due)
      now = due.at
      due.fn()
    }
    now = end
  }
  return { keeper, log, advance }
}

describe("streamURL", () => {
  test("adds lite, the open session and the last id; nothing for a full stream", () => {
    expect(streamURL({ lite: false })).toBe("/api/events")
    expect(streamURL({ lite: true })).toBe("/api/events?lite=1")
    expect(streamURL({ lite: true, session: "ses 1" }, "e.5")).toBe("/api/events?lite=1&session=ses%201&last=e.5")
  })
})

describe("StreamKeeper", () => {
  test("opens on start; a hidden page closes the stream after HIDDEN_CLOSE_MS; visible reopens with the last id", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.received("e.3")
    keeper.hidden()
    advance(HIDDEN_CLOSE_MS - 1)
    expect(log).toEqual(["open /api/events?lite=1"])
    advance(1)
    expect(log.at(-1)).toBe("close")
    expect(keeper.state).toBe("paused")
    keeper.visible()
    expect(log.at(-1)).toBe("open /api/events?lite=1&last=e.3")
    expect(keeper.state).toBe("open")
  })

  test("coming back before the delay keeps the stream (no reconnect)", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.hidden()
    advance(10_000)
    keeper.visible()
    advance(HIDDEN_CLOSE_MS)
    expect(log).toEqual(["open /api/events?lite=1"])
  })

  test("Voice mode keeps the stream open while hidden", () => {
    const { keeper, log, advance } = setup(() => true)
    keeper.start({ lite: false })
    keeper.hidden()
    // Heartbeats keep arriving every 20 s.
    for (let i = 0; i < 5; i++) {
      advance(20_000)
      keeper.received()
    }
    expect(log).toEqual(["open /api/events"])
  })

  test("no message or ping for STALE_MS: reconnects with the last id", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.received("e.1")
    advance(STALE_MS - 1)
    keeper.received()
    advance(STALE_MS - 1)
    expect(log).toEqual(["open /api/events?lite=1"])
    advance(1)
    expect(log.slice(1)).toEqual(["close", "open /api/events?lite=1&last=e.1"])
  })

  test("the watchdog does not run while paused", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.hidden()
    advance(HIDDEN_CLOSE_MS + STALE_MS * 3)
    expect(log).toEqual(["open /api/events?lite=1", "close"])
  })

  test("a scope change reopens with the last id; the same scope does nothing", () => {
    const { keeper, log } = setup()
    keeper.start({ lite: true })
    keeper.received("e.7")
    keeper.setScope({ lite: true })
    expect(log.length).toBe(1)
    keeper.setScope({ lite: true, session: "ses_1" })
    expect(log.slice(1)).toEqual(["close", "open /api/events?lite=1&session=ses_1&last=e.7"])
  })

  test("a scope change while paused is used at the next resume", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.hidden()
    advance(HIDDEN_CLOSE_MS)
    keeper.setScope({ lite: true, session: "ses_2" })
    expect(log.at(-1)).toBe("close")
    keeper.visible()
    expect(log.at(-1)).toBe("open /api/events?lite=1&session=ses_2")
  })

  test("stop closes and cancels timers; hidden/visible after stop do nothing", () => {
    const { keeper, log, advance } = setup()
    keeper.start({ lite: true })
    keeper.stop()
    keeper.visible()
    advance(STALE_MS * 2)
    expect(log).toEqual(["open /api/events?lite=1", "close"])
    expect(keeper.state).toBe("stopped")
  })
})
