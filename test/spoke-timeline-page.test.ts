import { describe, expect, test } from "bun:test"
import { TimelineCache, newestPage, timelineItems, type TimelineItem } from "../src/spoke/timeline"

/** `n` messages: even ones a user row, odd ones an assistant message with `parts` text rows. */
function rows(n: number, parts = 1, from = 0): TimelineItem[] {
  const out: TimelineItem[] = []
  for (let m = from; m < from + n; m++) {
    if (m % 2 === 0) out.push({ key: `m${m}:text`, messageID: `m${m}`, sessionID: "s", kind: "user", text: `q${m}` })
    else for (let p = 0; p < parts; p++) out.push({ key: `m${m}:${p}`, messageID: `m${m}`, partID: String(p), sessionID: "s", kind: "assistant", text: `a${m}.${p}` })
  }
  return out
}
const keys = (items: readonly TimelineItem[]) => items.map((i) => i.key)

describe("newestPage (newest-first paging)", () => {
  test("first page is the newest rows in chronological order, with an older cursor", () => {
    const items = rows(10)
    const page = newestPage(items, 4)
    expect(keys(page.items)).toEqual(["m6:text", "m7:0", "m8:text", "m9:0"])
    expect(page.older).toBe("m6:text")
  })

  test("following older cursors walks back to the beginning without gaps or overlaps", () => {
    const items = rows(25)
    const seen: string[] = []
    let page = newestPage(items, 7)
    let pages = 1
    seen.unshift(...keys(page.items))
    while (page.older) {
      page = newestPage(items, 7, page.older)
      seen.unshift(...keys(page.items))
      pages++
    }
    expect(seen).toEqual(keys(items))
    expect(pages).toBe(4)
    expect(page.older).toBeUndefined()
  })

  test("a short history fits in one page without a cursor", () => {
    const page = newestPage(rows(3), 50)
    expect(keys(page.items)).toEqual(["m0:text", "m1:0", "m2:text"])
    expect(page.older).toBeUndefined()
    expect(newestPage([], 10)).toEqual({ items: [] })
  })

  test("the cursor stays valid while new messages arrive at the end", () => {
    const before = rows(20)
    const first = newestPage(before, 5)
    // Five more messages arrive before the console asks for older rows.
    const after = [...before, ...rows(5, 1, 20)]
    const older = newestPage(after, 5, first.older)
    expect(keys(older.items)).toEqual(keys(before.slice(-10, -5)))
    // An offset from the end would have returned rows the console already shows.
    expect(keys(older.items)).not.toContain(first.items[0]!.key)
  })

  test("page boundaries prefer message boundaries (a page may exceed the limit a little)", () => {
    // m1, m3, m5 … have 4 parts each
    const items = rows(10, 4)
    const page = newestPage(items, 6)
    expect(new Set(page.items.map((i) => i.messageID)).size).toBeGreaterThan(1)
    expect(page.items.length).toBeLessThanOrEqual(12)
    // every message on the page is complete
    for (const id of new Set(page.items.map((i) => i.messageID))) expect(page.items.filter((i) => i.messageID === id).length).toBe(items.filter((i) => i.messageID === id).length)
  })

  test("a single message larger than twice the limit is split, and the cursor resumes inside it", () => {
    const items = rows(2, 30) // m0:text + m1:0..29
    const page = newestPage(items, 5)
    expect(page.items.length).toBe(10)
    expect(page.items.at(-1)!.key).toBe("m1:29")
    const rest: string[] = [...keys(page.items)]
    let cursor = page.older
    while (cursor) {
      const next = newestPage(items, 5, cursor)
      rest.unshift(...keys(next.items))
      cursor = next.older
    }
    expect(rest).toEqual(keys(items))
  })

  test("an unknown cursor is an error", () => {
    expect(() => newestPage(rows(4), 2, "nope:text")).toThrow("Invalid timeline cursor")
  })

  test("a session with more than 2000 rows still returns its newest rows first", () => {
    const items = rows(2600)
    const page = newestPage(items, 80)
    expect(page.items.at(-1)!.key).toBe(items.at(-1)!.key)
  })

  test("works on rows projected from OpenCode messages", () => {
    const items = timelineItems("s", [
      { id: "u1", type: "user", text: "hi" },
      { id: "a1", type: "assistant", content: [{ type: "text", text: "one" }, { type: "tool", name: "read", state: { status: "completed" } }] },
      { id: "u2", type: "user", text: "again" },
    ])
    expect(keys(newestPage(items, 1).items)).toEqual(["u2:text"])
    expect(keys(newestPage(items, 1, "u2:text").items)).toEqual(["a1:0", "a1:1"])
  })
})

describe("TimelineCache", () => {
  const item = (n: number): TimelineItem => ({ key: `k${n}`, messageID: `m${n}`, sessionID: "s", kind: "user", text: String(n) })

  test("serves cached rows within the TTL and reloads after it", async () => {
    let now = 1000
    let loads = 0
    const cache = new TimelineCache({ ttlMs: 30_000, now: () => now })
    const load = async () => [item(++loads)]
    expect(await cache.get("s", load)).toEqual([item(1)])
    now += 29_000
    expect(await cache.get("s", load)).toEqual([item(1)])
    expect(loads).toBe(1)
    now += 2000
    expect(await cache.get("s", load)).toEqual([item(2)])
    expect(loads).toBe(2)
  })

  test("fresh reads always load and refresh the cache", async () => {
    let loads = 0
    const cache = new TimelineCache()
    const load = async () => [item(++loads)]
    await cache.get("s", load)
    expect(await cache.get("s", load, true)).toEqual([item(2)])
    expect(await cache.get("s", load)).toEqual([item(2)])
    expect(loads).toBe(2)
  })

  test("invalidation drops a session's rows (and a load in flight is not stored)", async () => {
    let loads = 0
    const cache = new TimelineCache()
    const load = async () => [item(++loads)]
    await cache.get("s", load)
    cache.invalidate("s")
    expect(await cache.get("s", load)).toEqual([item(2)])
    let release!: () => void
    const slow = cache.get("s", () => new Promise((resolve) => (release = () => resolve([item(99)]))), true)
    cache.invalidate("s")
    release()
    expect(await slow).toEqual([item(99)])
    expect(await cache.get("s", load)).toEqual([item(3)])
  })

  test("keeps at most `max` sessions, dropping the least recently used", async () => {
    let loads = 0
    const cache = new TimelineCache({ max: 2 })
    const load = async () => [item(++loads)]
    await cache.get("a", load)
    await cache.get("b", load)
    await cache.get("a", load) // a is now most recent
    await cache.get("c", load) // evicts b
    expect(cache.size).toBe(2)
    await cache.get("a", load)
    expect(loads).toBe(3)
    await cache.get("b", load)
    expect(loads).toBe(4)
  })
})
