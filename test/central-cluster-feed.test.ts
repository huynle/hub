// MessageFeed and LaunchFeed across pods (design §9, decision vkxkqiuf §6): attached to the Bus, a publication on
// one pod reaches the listeners of every pod (ask waiters, the agent watch); `origin` listeners (the console
// broadcast, webhooks, closing a launch's connections) run only on the pod that published.
import { describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { LaunchFeed } from "../src/central/agent/launch-routes"
import type { Launch } from "../src/central/agent/launch-store"
import { MessageFeed } from "../src/central/agent/message-routes"
import type { Message } from "../src/central/agent/messages"

const message = (id: string) => ({ id, kind: "msg", state: "sent" }) as unknown as Message
const launch = (id: string) => ({ id, owner: "u1", state: "queued" }) as unknown as Launch

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

for (const [name, make, item] of [
  ["MessageFeed", () => new MessageFeed(), message],
  ["LaunchFeed", () => new LaunchFeed(), launch],
] as const) {
  describe(`${name} on the Bus`, () => {
    test("without a Bus it stays in process", () => {
      const feed = make()
      const seen: string[] = []
      feed.subscribe((user, x: any) => seen.push(`${user}:${x.id}`))
      feed.publish("u1", item("m1") as any)
      expect(seen).toEqual(["u1:m1"])
    })

    test("a publication on A reaches B's listeners once, and A's at once", async () => {
      const bus = new MemoryBus()
      const a = make()
      const b = make()
      await Promise.all([a.attach({ bus, podID: "pod-a" }), b.attach({ bus, podID: "pod-b" })])
      const onA: string[] = []
      const onB: string[] = []
      a.subscribe((user, x: any) => onA.push(`${user}:${x.id}`))
      b.subscribe((user, x: any) => onB.push(`${user}:${x.id}`))
      a.publish("u1", item("m1") as any)
      expect(onA).toEqual(["u1:m1"])
      await until(() => onB.length === 1)
      await Bun.sleep(10)
      expect(onA).toEqual(["u1:m1"])
      expect(onB).toEqual(["u1:m1"])
      await Promise.all([a.detach(), b.detach()])
    })

    test("origin listeners run only on the publishing pod", async () => {
      const bus = new MemoryBus()
      const a = make()
      const b = make()
      await Promise.all([a.attach({ bus, podID: "pod-a" }), b.attach({ bus, podID: "pod-b" })])
      const originB: string[] = []
      const allB: string[] = []
      b.subscribe((_user, x: any) => originB.push(x.id), { origin: true })
      b.subscribe((_user, x: any) => allB.push(x.id))
      a.publish("u1", item("from-a") as any)
      await until(() => allB.length === 1)
      expect(originB).toEqual([])
      b.publish("u1", item("from-b") as any)
      expect(originB).toEqual(["from-b"])
      await Promise.all([a.detach(), b.detach()])
    })

    test("after detach a pod no longer hears the others", async () => {
      const bus = new MemoryBus()
      const a = make()
      const b = make()
      await Promise.all([a.attach({ bus, podID: "pod-a" }), b.attach({ bus, podID: "pod-b" })])
      const onB: string[] = []
      b.subscribe((_user, x: any) => onB.push(x.id))
      await b.detach()
      a.publish("u1", item("m1") as any)
      await Bun.sleep(20)
      expect(onB).toEqual([])
      await a.detach()
    })
  })
}
