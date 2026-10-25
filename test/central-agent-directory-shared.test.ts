// The agent directory on a shared (cluster) Store: its writes are async and awaited, so a change made before the
// pod's store has loaded, or retried after another pod's concurrent write, is applied before the call resolves and
// its errors reach the caller. Two pods = two Store.shared instances on one memoryBackends() bundle.
import { describe, expect, test } from "bun:test"
import { Directory, type ReportedSession } from "../src/central/agent/directory"
import { AgentError } from "../src/central/agent/errors"
import { memoryBackends } from "../src/central/backend"
import { Store } from "../src/central/store"

const root = (sessionID: string, title: string): ReportedSession => ({ sessionID, title, machineID: "mch_1", project: "hub" })

async function pods() {
  const backends = memoryBackends()
  const open = (pod: string) => Store.shared({ state: backends.state, bus: backends.bus, instanceID: pod })
  const a = open("pod-a")
  await a.ready()
  const alice = (await a.upsertUser({ email: "alice@example.test", role: "user" })).id
  const reported: ReportedSession[] = [root("ses_a", "Fix login"), root("ses_b", "Write docs")]
  const source = { reported: () => reported, archived: () => new Set<string>() }
  return { a, open, alice, source }
}

describe("directory on a shared store", () => {
  test("a write before the store loaded is applied when the call resolves", async () => {
    const { open, alice, source } = await pods()
    const b = open("pod-b")
    const dir = new Directory({ store: b, source })
    const role = await dir.claimRole(alice, "ses_a", "reviewer", { exclusive: true })
    expect(role).toMatchObject({ role: "reviewer", exclusive: true, generation: 1 })
    expect(b.agentData(alice).roles?.map((r) => r.sessionID)).toEqual(["ses_a"])
  })

  test("errors reject the call", async () => {
    const { a, alice, source } = await pods()
    const dir = new Directory({ store: a, source })
    await dir.setName(alice, "ses_a", "api")
    const failed = await dir.setName(alice, "ses_b", "api").then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failed).toBeInstanceOf(AgentError)
    expect((failed as AgentError).code).toBe("name_taken")
  })

  test("concurrent writes on two pods both land (the loser retries on fresh data)", async () => {
    const { a, open, alice, source } = await pods()
    const b = open("pod-b")
    await b.ready()
    const dirA = new Directory({ store: a, source })
    const dirB = new Directory({ store: b, source })
    await Promise.all([dirA.setName(alice, "ses_a", "api"), dirB.setName(alice, "ses_b", "docs")])
    await a.recheck({ users: [alice] })
    const names = (a.agentData(alice).names ?? []).filter((n) => n.expiresAt === undefined).map((n) => `${n.sessionID}=${n.name}`).sort()
    expect(names).toEqual(["ses_a=api", "ses_b=docs"])
  })
})
