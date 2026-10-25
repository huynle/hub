// Launch labels and events in the read routes (P4-T9; design §6.1): a launched session carries its launch's labels
// in /api/agent/status, /sessions (and ?label=k=v finds it) and /sessions/:addr; /api/agent/watch streams
// compact 'launch' events (users: all of theirs; apps and sessions: those they started).
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { validateLaunchSpec } from "../src/central/agent/launch-spec"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

const APP = "hat_fake_app"
const verifiers: BearerVerifier[] = [{ kind: "app", verify: (token) => (token === APP ? { kind: "app", userID: "local", tokenID: "tok_1", scopes: ["sessions:read"] } : undefined) }]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const LABELS = { app: "brain", "brain.task": "t1" }

async function start() {
  h = harness({ agent: { verifiers }, timing: { heartbeatMs: 40 } } as any)
  const { machine, token } = h.store.addMachine("laptop")
  const client = await spoke(h, {
    machine: { token },
    sessions: [session("ses_1", { title: "API refactor", directory: "/u/hub", project: "/u/hub", projectName: "hub" }), session("ses_2", { title: "Web work", directory: "/u/web", project: "/u/web", projectName: "web" })],
  })
  // show asks the spoke for its summary
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t === "req") client.send({ t: "res", id: frame.id, ok: true, result: {} })
  })
  await waitFor(() => (h.store.agentData("local").names?.length ?? 0) === 2)
  return { machine }
}

/** A launch of the user's that started ses_1 (written straight to the store). */
async function launched(machineID: string, labels: Record<string, string> = LABELS) {
  const store = h.launches.store
  const { launch } = await store.create("local", validateLaunchSpec({ workspace: { repo: "/u/hub", branch: "b" }, labels }), { by: "user" })
  await store.transition("local", launch.id, "placing", { reason: "placing" })
  await store.transition("local", launch.id, "provisioning", { reason: "on laptop", machineID })
  return store.transition("local", launch.id, "running", { reason: "running", sessionID: "ses_1" })
}

describe("labels of launched sessions", () => {
  test("status, sessions and show carry the launch's labels; ?label= finds the session; others have none", async () => {
    const { machine } = await start()
    await launched(machine.id)
    const { sessions } = await json(await h.api("/api/agent/sessions"))
    expect(Object.fromEntries(sessions.map((s: any) => [s.id, s.labels]))).toEqual({ ses_1: LABELS, ses_2: {} })
    expect((await json(await h.api("/api/agent/sessions?label=app=brain"))).sessions.map((s: any) => s.id)).toEqual(["ses_1"])
    expect((await json(await h.api("/api/agent/sessions?label=app=brain&label=brain.task=t2"))).sessions).toEqual([])
    const status = await json(await h.api("/api/agent/status"))
    const all = status.machines[0].projects.flatMap((p: any) => p.sessions)
    expect(all.find((s: any) => s.id === "ses_1").labels).toEqual(LABELS)
    expect((await json(await h.api("/api/agent/sessions/@api-refactor"))).labels).toEqual(LABELS)
    expect((await json(await h.api("/api/agent/sessions/@web-work"))).labels).toEqual({})
  })

  test("the latest launch of a session wins", async () => {
    const { machine } = await start()
    await launched(machine.id)
    // later by creation (ties order by id)
    await Bun.sleep(3)
    await launched(machine.id, { app: "other" })
    expect((await json(await h.api("/api/agent/sessions?label=app=other"))).sessions.map((s: any) => s.id)).toEqual(["ses_1"])
  })
})

describe("launch events on GET /api/agent/watch", () => {
  test("the user's watch gets compact launch events (state, labels); ?blocked=1 and another session's watch do not", async () => {
    await start()
    const events = sse(await h.api("/api/agent/watch"))
    const blocked = sse(await h.api("/api/agent/watch?blocked=1"))
    const other = sse(await h.api("/api/agent/watch?session=@web-work"))
    await events.next((m) => m.type === "ready")
    await blocked.next((m) => m.type === "ready")
    await other.next((m) => m.type === "ready")
    const created = await json(await h.api("/api/agent/launches", { method: "POST", json: { workspace: { repo: "/u/hub", branch: "b" }, labels: LABELS } }))
    const event = await events.next((m) => m.type === "launch")
    expect(event).toEqual({ type: "launch", id: created.launch.id, state: "queued", reason: created.launch.reason, labels: LABELS, at: expect.any(Number) })
    // a later session event reaches the others, never the launch
    h.launchFeed.publish("local", { ...(await h.launches.store.get("local", created.launch.id))!, state: "running", sessionID: "ses_2" })
    expect(await other.next((m) => m.type === "launch")).toMatchObject({ id: created.launch.id, state: "running", sessionID: "ses_2" })
    await expect(blocked.next((m) => m.type === "launch", 150)).rejects.toThrow(/timed out/)
    for (const s of [events, blocked, other]) await s.cancel()
  })

  test("an app's watch gets only the launches it started", async () => {
    await start()
    const app = sse(await h.api("/api/agent/watch", { cookie: null, origin: null, headers: { authorization: `Bearer ${APP}` } }))
    await app.next((m) => m.type === "ready")
    const mine = await json(await h.api("/api/agent/launches", { method: "POST", json: { workspace: { repo: "/u/hub", branch: "b" } } }))
    const stored = (await h.launches.store.get("local", mine.launch.id))!
    h.launchFeed.publish("local", { ...stored, id: "lch_app", by: "app:tok_1" })
    expect(await app.next((m) => m.type === "launch")).toMatchObject({ id: "lch_app" })
    await app.cancel()
  })
})
