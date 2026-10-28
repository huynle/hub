// GET /spoke/presence (HBS-13 integration item 6): the one read-only query a machine credential can make about
// itself, so `hubctl setup verify` can prove a harness's spoke is connected (spoke-connected readiness). It answers
// only for the token's own machine, lists only which harness spokes are connected (harness, evidence level,
// features), and never sessions, directories, pids or other machines. A launch-bound token, a revoked or unknown
// machine token, or no token at all is refused with 401; anything but GET is not a route.
import { afterEach, describe, expect, test } from "bun:test"
import { harness, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const presence = (token: string | undefined, init: RequestInit = {}) =>
  fetch(`${h.url}/spoke/presence`, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual" })

describe("GET /spoke/presence", () => {
  test("lists the connected harness spokes of the token's own machine only", async () => {
    h = await harness()
    const laptop = await h.store.addMachine("laptop")
    const other = await h.store.addMachine("desktop")
    await spoke(h, { machine: laptop, processID: "p1", hello: { harness: "claude-code", harnessVersion: "2.1.90", evidence: "hooks" } })
    await spoke(h, { machine: other, processID: "p2", hello: { harness: "codex", evidence: "rpc" } })
    await waitFor(() => h.registry.catalog().length === 2)

    const res = await presence(laptop.token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.machineID).toBe(laptop.machine.id)
    expect(body.spokes).toEqual([{ harness: "claude-code", evidence: "hooks", features: expect.any(Array) }])
    const text = JSON.stringify(body)
    for (const leaked of ["p1", "p2", "desktop", "sessions", "directory", "pid", laptop.token]) expect(text).not.toContain(leaked)
  })

  test("a machine with nothing connected has no spokes", async () => {
    h = await harness()
    const laptop = await h.store.addMachine("laptop")
    const body = (await (await presence(laptop.token)).json()) as any
    expect(body).toEqual({ machineID: laptop.machine.id, spokes: [] })
  })

  test("no token, an unknown or a revoked machine token: 401", async () => {
    h = await harness()
    const laptop = await h.store.addMachine("laptop")
    expect((await presence(undefined)).status).toBe(401)
    expect((await presence("mt_nope")).status).toBe(401)
    await h.store.revokeMachine(laptop.machine.id)
    expect((await presence(laptop.token)).status).toBe(401)
  })

  test("read-only: other methods are not this route", async () => {
    h = await harness()
    const laptop = await h.store.addMachine("laptop")
    expect((await presence(laptop.token, { method: "POST" })).status).not.toBe(200)
    expect((await presence(laptop.token, { method: "DELETE" })).status).not.toBe(200)
  })
})
