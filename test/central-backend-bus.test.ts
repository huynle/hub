// Backend Bus contract: publish/subscribe and request/reply with a timeout (fake timers), run against every
// implementation in test/backend-impls.ts.
import { describe, expect, test } from "bun:test"
import { implementations } from "./backend-impls"
import { BusNoResponderError, BusRemoteError, BusTimeoutError, type Timers } from "../src/central/backend/types"

/** Timers that fire only when the test says so. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(++next, { fn, ms })
      return next
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  return {
    timers,
    pending: () => [...pending.values()].map((p) => p.ms),
    fireAll: () => {
      const due = [...pending.values()]
      pending.clear()
      for (const p of due) p.fn()
    },
  }
}

for (const impl of implementations("bus")) {
  describe(`${impl.name} publish/subscribe`, () => {
    test("subscribers of a topic get its messages in order; other topics do not", async () => {
      const bus = await impl.make()
      const got: Array<[string, unknown]> = []
      await bus.subscribe("user.alice", (message, topic) => void got.push([topic, message]))
      await bus.subscribe("user.bob", () => void got.push(["wrong", null]))
      expect(await bus.publish("user.alice", { n: 1 })).toBe(1)
      expect(await bus.publish("user.alice", { n: 2 })).toBe(1)
      expect(got).toEqual([["user.alice", { n: 1 }], ["user.alice", { n: 2 }]])
    })

    test("every subscriber gets a copy; publish counts them; none is 0", async () => {
      const bus = await impl.make()
      const a: unknown[] = []
      const b: unknown[] = []
      await bus.subscribe("t", (m) => {
        ;(m as { n: number }).n = 99
        a.push(m)
      })
      await bus.subscribe("t", (m) => void b.push(m))
      const message = { n: 1 }
      expect(await bus.publish("t", message)).toBe(2)
      expect(message).toEqual({ n: 1 })
      expect(b).toEqual([{ n: 1 }])
      expect(await bus.publish("nobody", {})).toBe(0)
    })

    test("unsubscribe stops delivery (and is idempotent)", async () => {
      const bus = await impl.make()
      const got: unknown[] = []
      const off = await bus.subscribe("t", (m) => void got.push(m))
      await bus.publish("t", 1)
      await off()
      await off()
      expect(await bus.publish("t", 2)).toBe(0)
      expect(got).toEqual([1])
    })

    test.skipIf(!impl.supports("options"))("a failing subscriber does not reach the publisher or the other subscribers", async () => {
      const errors: unknown[] = []
      const bus = await impl.make({ onError: (error) => void errors.push(error) })
      const got: unknown[] = []
      await bus.subscribe("t", () => {
        throw new Error("boom")
      })
      await bus.subscribe("t", async () => {
        throw new Error("async boom")
      })
      await bus.subscribe("t", (m) => void got.push(m))
      expect(await bus.publish("t", "x")).toBe(3)
      expect(got).toEqual(["x"])
      expect(errors.map((e) => (e as Error).message).sort()).toEqual(["async boom", "boom"])
    })
  })
}

for (const impl of implementations("bus")) {
  describe(`${impl.name} request/reply`, () => {
    test("a request gets the responder's reply (copied both ways)", async () => {
      const bus = await impl.make({ timers: fakeTimers().timers })
      await bus.serve("pod.p1.rpc", async (message) => ({ echo: message }))
      expect(await bus.request<unknown>("pod.p1.rpc", { op: "status" }, { timeoutMs: 1000 })).toEqual({ echo: { op: "status" } })
    })

    test("no responder: rejects at once with BusNoResponderError", async () => {
      const bus = await impl.make({ timers: fakeTimers().timers })
      const error = await bus.request("pod.gone.rpc", {}, { timeoutMs: 1000 }).catch((e) => e)
      expect(error).toBeInstanceOf(BusNoResponderError)
    })

    test.skipIf(!impl.supports("timers"))("a responder that never answers: BusTimeoutError when the timeout fires; a late reply is ignored", async () => {
      const clock = fakeTimers()
      const bus = await impl.make({ timers: clock.timers })
      let answer: (value: unknown) => void = () => {}
      await bus.serve("slow", () => new Promise((resolve) => (answer = resolve)))
      const reply = bus.request("slow", {}, { timeoutMs: 2500 }).catch((e) => e)
      await Promise.resolve()
      expect(clock.pending()).toEqual([2500])
      clock.fireAll()
      const error = await reply
      expect(error).toBeInstanceOf(BusTimeoutError)
      expect((error as BusTimeoutError).timeoutMs).toBe(2500)
      answer("late")
    })

    test.skipIf(!impl.supports("timers"))("a reply clears its timeout", async () => {
      const clock = fakeTimers()
      const bus = await impl.make({ timers: clock.timers })
      await bus.serve("fast", () => "ok")
      expect(await bus.request<string>("fast", {}, { timeoutMs: 1000 })).toBe("ok")
      expect(clock.pending()).toEqual([])
    })

    test("a responder that throws: BusRemoteError with its message", async () => {
      const bus = await impl.make({ timers: fakeTimers().timers })
      await bus.serve("bad", () => {
        throw new Error("no such session")
      })
      const error = await bus.request("bad", {}, { timeoutMs: 1000 }).catch((e) => e)
      expect(error).toBeInstanceOf(BusRemoteError)
      expect((error as Error).message).toBe("no such session")
    })

    test("one responder per topic; after it stops serving the topic has none", async () => {
      const bus = await impl.make({ timers: fakeTimers().timers })
      const stop = await bus.serve("t", () => 1)
      expect(await bus.serve("t", () => 2).catch((e) => e)).toBeInstanceOf(Error)
      await stop()
      expect(await bus.request("t", {}, { timeoutMs: 1000 }).catch((e) => e)).toBeInstanceOf(BusNoResponderError)
      await bus.serve("t", () => 3)
      expect(await bus.request<number>("t", {}, { timeoutMs: 1000 })).toBe(3)
    })
  })
}
