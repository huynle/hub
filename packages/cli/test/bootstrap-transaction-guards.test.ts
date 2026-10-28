// Guard rails of the transactional applier beyond the happy path: hooks only observe, another host's interrupted
// journal (a shared home) is never recovered from here, failure output never carries a credential, and two steps
// of one plan may edit the same file (the second's precondition is the file as it was before this transaction).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { canonicalJSON, findSecrets, type Action, type JournalEntry, type TransactionJournal } from "../src/bootstrap/contracts/index.ts"
import type { ActionExecutor } from "../src/bootstrap/transaction/executor.ts"
import { txFail, txOk } from "../src/bootstrap/transaction/result.ts"
import { ACTIONS, JOURNAL_APPLYING, OTHER_HOST } from "./bootstrap/fixtures.ts"
import { World } from "./bootstrap/transaction-fixtures.ts"

const ALL = { confirmActivation: true }
let worlds: World[] = []
const world = () => {
  const w = new World()
  worlds.push(w)
  return w
}
afterEach(() => {
  for (const w of worlds) w.cleanup()
  worlds = []
})

describe("guards", () => {
  test("hooks observe copies: mutating what they receive changes nothing", async () => {
    const w = world()
    const hooks = {
      beforeAction: (entry: JournalEntry, journal: TransactionJournal) => {
        ;(entry as { status: string }).status = "undone"
        ;(journal.entries as JournalEntry[]).length = 0
      },
    }
    const r = await w.applier({ hooks }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(r.ok ? "ok" : r.code).toBe("ok")
    const journal = JSON.parse(w.journalTexts().find((t) => t.includes('"hub.transaction-journal"'))!)
    expect(journal.state).toBe("committed")
    expect(journal.entries.length).toBeGreaterThan(5)
    expect(journal.entries.every((e: { status: string }) => e.status === "done")).toBe(true)
  })

  test("another host's interrupted journal is never recovered from this host", async () => {
    const w = world()
    const dir = w.box.path("state", "hub/bootstrap/journal")
    mkdirSync(dir, { recursive: true })
    const foreign = { ...JOURNAL_APPLYING, hostFingerprint: OTHER_HOST }
    writeFileSync(`${dir}/${foreign.txID}.json`, canonicalJSON(foreign))
    const before = w.snapshot({ includeBootstrapState: true })
    const recover = await w.applier().recover({ mode: "rollback" })
    expect(recover.ok ? "ok" : recover.code).toBe("recovery_required")
    const apply = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(apply.ok ? "ok" : apply.code).toBe("recovery_required")
    expect(JSON.parse(readFileSync(`${dir}/${foreign.txID}.json`, "utf8"))).toEqual(foreign)
    expect(w.snapshot()).toEqual(Object.fromEntries(Object.entries(before).filter(([k]) => !k.includes("hub/bootstrap"))))
  })

  test("a failure message carrying a credential never reaches the output", async () => {
    const w = world()
    const leaky: ActionExecutor<"verify-harness"> = {
      kind: "verify-harness",
      plan: () => ({ class: "external" }),
      change: async () => txOk({ type: "effect", perform: async () => txFail("harness_not_ready", "provider said: Bearer sk-live-0123456789abcdef rejected") }),
    }
    const r = await w.applier({ executors: { ...w.executors(), "verify-harness": leaky } }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(r.ok ? "ok" : r.code).toBe("harness_not_ready")
    expect(JSON.stringify(r)).not.toContain("sk-live")
    expect(findSecrets(JSON.parse(JSON.stringify(r)))).toEqual([])
  })

  test("two steps may edit the same file; the second's precondition is the file before this transaction", async () => {
    const w = world()
    const second = { ...ACTIONS["merge-config"], id: "opencode-plugin-2", set: [{ pointer: "/plugin/-", value: "other-plugin" }] } as Action
    const replan = w.replan((p) => {
      const first = p.actions.find((a) => a.id === "opencode-plugin")!
      const actions = [...p.actions]
      actions.splice(actions.indexOf(first) + 1, 0, { ...second, precondition: (first as { precondition: unknown }).precondition } as Action)
      return { ...p, actions }
    })
    const r = await w.applier().apply({ token: w.token((await replan()).plan), replan, consent: ALL })
    expect(r.ok ? "ok" : r.code).toBe("ok")
    expect(JSON.parse(w.read("config", "opencode/opencode.json")).plugin).toEqual(["@huynle/hub", "other-plugin"])
  })
})
