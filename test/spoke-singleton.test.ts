import { describe, expect, test } from "bun:test"
import { joinProcess } from "../src/spoke/singleton"

class FakeSpoke {
  started = 0
  stopped = 0
  constructor(readonly name: string) {}
  start() {
    this.started++
  }
  stop() {
    this.stopped++
  }
}

const freshKey = () => Symbol(`test-${Math.random()}`)

describe("joinProcess", () => {
  test("only the first instance in a process creates and starts the spoke", () => {
    const key = freshKey()
    const created: FakeSpoke[] = []
    const make = (name: string) => () => {
      const s = new FakeSpoke(name)
      created.push(s)
      return s
    }
    const a = joinProcess(make("a"), key)
    const b = joinProcess(make("b"), key)
    expect(created.map((s) => s.name)).toEqual(["a"])
    expect(created[0]!.started).toBe(1)
    expect(a.isActive()).toBe(true)
    expect(b.isActive()).toBe(false)
    expect(b.active()).toBe(created[0])
    expect(a.processID).toBe(b.processID)
    expect(a.processID).toMatch(/^proc_/)
  })

  test("when the active instance leaves, the next instance takes over with its own factory", () => {
    const key = freshKey()
    const created: FakeSpoke[] = []
    const make = (name: string) => () => {
      const s = new FakeSpoke(name)
      created.push(s)
      return s
    }
    const a = joinProcess(make("a"), key)
    const b = joinProcess(make("b"), key)
    a.leave()
    expect(created[0]!.stopped).toBe(1)
    expect(created.map((s) => s.name)).toEqual(["a", "b"])
    expect(b.isActive()).toBe(true)
    expect(b.active()?.name).toBe("b")
    b.leave()
    expect(created[1]!.stopped).toBe(1)
    expect(b.active()).toBeUndefined()
  })

  test("a passive instance leaving does not disturb the active spoke", () => {
    const key = freshKey()
    const a = joinProcess(() => new FakeSpoke("a"), key)
    const b = joinProcess(() => new FakeSpoke("b"), key)
    b.leave()
    expect(a.active()?.name).toBe("a")
    expect(a.active()?.stopped).toBe(0)
    b.leave() // idempotent
    expect(a.isActive()).toBe(true)
  })

  test("a factory that throws never escapes; a later instance can still start", () => {
    const key = freshKey()
    const broken = joinProcess(() => {
      throw new Error("boom")
    }, key)
    expect(broken.active()).toBeUndefined()
    const ok = joinProcess(() => new FakeSpoke("ok"), key)
    expect(ok.isActive()).toBe(true)
  })

  test("state from another pid (forked process) is discarded", () => {
    const key = freshKey()
    ;(globalThis as Record<symbol, unknown>)[key] = { pid: -1, processID: "proc_old", instances: [], spoke: new FakeSpoke("stale") }
    const a = joinProcess(() => new FakeSpoke("a"), key)
    expect(a.active()?.name).toBe("a")
    expect(a.processID).not.toBe("proc_old")
  })
})
