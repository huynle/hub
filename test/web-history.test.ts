import { describe, expect, test } from "bun:test"
import { HistoryPager, type PageQuery } from "../web/src/core/history-core"
import { Timeline } from "../web/src/core/timeline-core"
import { newestPage, type TimelineItem } from "../src/spoke/timeline"

/** `n` rows of a fake conversation (one row per message), `at` increasing. */
const conversation = (n: number, from = 0): TimelineItem[] =>
  Array.from({ length: n }, (_, i) => ({ key: `m${from + i}:0`, messageID: `m${from + i}`, sessionID: "s", kind: i % 2 ? "assistant" : "user", text: `row ${from + i}`, at: 1000 + from + i }) as TimelineItem)

/** A hub answering like the new spoke (newest-first pages), recording the queries. */
function fakeHub(rows: TimelineItem[]) {
  const state = { rows, queries: [] as PageQuery[], fail: undefined as undefined | { status?: number; message: string }, hold: undefined as undefined | Promise<void> }
  const fetch = async (query: PageQuery) => {
    state.queries.push(query)
    if (state.fail) throw Object.assign(new Error(state.fail.message), { status: state.fail.status })
    if (query.cursor !== undefined) throw new Error("forward cursor not expected")
    const rows = state.rows
    if (query.before && state.hold) await state.hold
    try {
      return newestPage(rows, query.limit, query.before)
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { status: 400 })
    }
  }
  return { state, fetch }
}
const keys = (timeline: Timeline) => timeline.rows().map((r) => r.key)

describe("Timeline: older pages", () => {
  test("rows of an older page go before the rows already shown, also when their times tie", () => {
    const timeline = new Timeline()
    timeline.load([{ key: "m2:0", kind: "assistant", text: "c", at: 5 }, { key: "m2:1", kind: "assistant", text: "d", at: 5 }])
    timeline.load([{ key: "m1:0", kind: "assistant", text: "a", at: 5 }, { key: "m1:1", kind: "assistant", text: "b", at: 5 }], { older: true })
    timeline.load([{ key: "m0:0", kind: "user", text: "q", at: 5 }], { older: true })
    expect(keys(timeline)).toEqual(["m0:0", "m1:0", "m1:1", "m2:0", "m2:1"])
    // Live rows still go at the end.
    timeline.upsert({ key: "m3:text", kind: "assistant", text: "live", at: 5 })
    expect(keys(timeline).at(-1)).toBe("m3:text")
  })

  test("forgetHistory drops loaded history rows but keeps local and live rows", () => {
    const timeline = new Timeline()
    timeline.load([{ key: "m1:0", kind: "user", text: "old", at: 1 }])
    timeline.upsert({ key: "local:1", kind: "user", text: "sending", at: 2 })
    timeline.forgetHistory()
    expect(keys(timeline)).toEqual(["local:1"])
  })
})

describe("HistoryPager", () => {
  test("opens with one request for the newest page, then pages back to the beginning", async () => {
    const hub = fakeHub(conversation(1000))
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 80 })
    await pager.first()
    expect(hub.state.queries).toEqual([{ limit: 80, order: "desc" }])
    expect(keys(timeline).at(-1)).toBe("m999:0")
    expect(keys(timeline).length).toBe(80)
    expect(pager.state).toBe("idle")
    expect(pager.hasOlder).toBe(true)
    await pager.older()
    expect(hub.state.queries[1]).toEqual({ limit: 80, before: "m920:0" })
    expect(keys(timeline)[0]).toBe("m840:0")
    while (pager.hasOlder) await pager.older()
    expect(pager.state).toBe("done")
    expect(keys(timeline)).toEqual(conversation(1000).map((r) => r.key))
  })

  test("a session with more than 2000 rows shows its newest rows", async () => {
    const hub = fakeHub(conversation(2600))
    const timeline = new Timeline()
    await new HistoryPager(timeline, hub.fetch).first()
    expect(keys(timeline).at(-1)).toBe("m2599:0")
  })

  test("asking for older rows while a page loads sends one request", async () => {
    const hub = fakeHub(conversation(300))
    const pager = new HistoryPager(new Timeline(), hub.fetch, { limit: 50 })
    await pager.first()
    const a = pager.older()
    expect(pager.state).toBe("loading")
    const b = pager.older()
    await Promise.all([a, b])
    expect(hub.state.queries.length).toBe(2)
  })

  test("a failed older page shows an error and Retry loads it", async () => {
    const hub = fakeHub(conversation(200))
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 50 })
    await pager.first()
    hub.state.fail = { status: 502, message: "OpenCode did not answer" }
    await pager.older()
    expect(pager.state).toBe("error")
    expect(pager.error).toContain("OpenCode did not answer")
    hub.state.fail = undefined
    await pager.retry()
    expect(pager.state).toBe("idle")
    expect(keys(timeline).length).toBe(100)
  })

  test("an unknown cursor (history rewritten) makes Retry start over from the newest page", async () => {
    const hub = fakeHub(conversation(200))
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 50 })
    await pager.first()
    hub.state.rows = conversation(60, 500) // a different history: the cursor's row is gone
    await pager.older()
    expect(pager.state).toBe("error")
    await pager.retry()
    expect(hub.state.queries.at(-1)).toEqual({ limit: 50, order: "desc" })
    expect(keys(timeline)).toEqual(conversation(50, 510).map((r) => r.key))
  })

  test("resync keeps loaded older rows when the newest page overlaps them", async () => {
    const hub = fakeHub(conversation(300))
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 50 })
    await pager.first()
    await pager.older()
    hub.state.rows = conversation(310)
    await pager.resync()
    expect(keys(timeline)).toEqual(conversation(310).slice(200).map((r) => r.key))
    expect(pager.hasOlder).toBe(true)
    await pager.older()
    expect(hub.state.queries.at(-1)).toEqual({ limit: 50, before: "m200:0" })
  })

  test("resync after a gap (many new rows) starts over from the newest page", async () => {
    const hub = fakeHub(conversation(300))
    const timeline = new Timeline()
    timeline.upsert({ key: "local:1", kind: "user", text: "sending", at: 99_999 })
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 50 })
    await pager.first()
    hub.state.rows = conversation(500)
    await pager.resync()
    expect(keys(timeline)).toEqual([...conversation(500).slice(450).map((r) => r.key), "local:1"])
    await pager.older()
    expect(hub.state.queries.at(-1)).toEqual({ limit: 50, before: "m450:0" })
  })

  test("an older page that arrives after a resync reset is dropped", async () => {
    const hub = fakeHub(conversation(300))
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, hub.fetch, { limit: 50 })
    await pager.first()
    let release!: () => void
    hub.state.hold = new Promise((resolve) => (release = resolve))
    const pending = pager.older()
    hub.state.rows = conversation(500)
    await pager.resync()
    release()
    await pending
    expect(keys(timeline)).toEqual(conversation(500).slice(450).map((r) => r.key))
  })

  test("an older spoke answering oldest-first pages (cursor) still loads the whole history the old way", async () => {
    const rows = conversation(450)
    const queries: PageQuery[] = []
    const fetch = async (query: PageQuery) => {
      queries.push(query)
      const offset = Number(query.cursor ?? 0)
      const limit = query.limit
      const items = rows.slice(offset, offset + limit)
      return { items, ...(offset + items.length < rows.length ? { cursor: String(offset + items.length) } : {}) }
    }
    const timeline = new Timeline()
    const pager = new HistoryPager(timeline, fetch, { limit: 80 })
    await pager.first()
    expect(queries).toEqual([{ limit: 80, order: "desc" }, { limit: 200, cursor: "80" }, { limit: 200, cursor: "280" }])
    expect(keys(timeline)).toEqual(rows.map((r) => r.key))
    expect(pager.state).toBe("done")
  })
})
