// The launch API wired into the hub (P4-T9): /api/agent/launches over Central.launches, the real grants, kill
// switch and audit; every launch change as an SSE 'launch' event on /api/events and on Central.launchFeed (the
// hook webhooks hang off, P4-T10); "launches" in the hub's welcome features.
import { afterEach, expect, test } from "bun:test"
import { HUB_FEATURES } from "../src/protocol"
import { harness, sse, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const json = async (r: Response) => (await r.json()) as any
const body = { key: "k1", workspace: { repo: "/p/hub", branch: "feat/x" }, prompt: "Go", labels: { app: "brain" } }

test("HUB_FEATURES announces launches", () => {
  expect(HUB_FEATURES as readonly string[]).toContain("launches")
})

test("a user launches, lists, reads and stops a launch; each change is an SSE launch event and reaches launchFeed", async () => {
  h = await harness()
  const fed: Array<{ userID: string; id: string; state: string }> = []
  h.launchFeed.subscribe((userID, launch) => void fed.push({ userID, id: launch.id, state: launch.state }))
  const events = sse(await h.api("/api/events"))

  const created = await h.api("/api/agent/launches", { method: "POST", json: body })
  expect(created.status).toBe(201)
  const { launch } = await json(created)
  expect(launch).toMatchObject({ state: "queued", by: "user", spec: { labels: { app: "brain" } } })
  expect(await events.next((m) => m.type === "launch")).toMatchObject({ type: "launch", launch: { id: launch.id, state: "queued" } })
  expect((await h.api("/api/agent/launches", { method: "POST", json: body })).status).toBe(200)

  expect((await json(await h.api("/api/agent/launches?label=app=brain"))).launches.map((l: any) => l.id)).toEqual([launch.id])
  expect((await json(await h.api(`/api/agent/launches/${launch.id}`))).launch.id).toBe(launch.id)

  const stopped = await h.api(`/api/agent/launches/${launch.id}`, { method: "DELETE" })
  expect(stopped.status).toBe(200)
  expect((await json(stopped)).launch).toMatchObject({ state: "ended", outcome: "stopped" })
  expect(await events.next((m) => m.type === "launch" && m.launch.state === "ended")).toMatchObject({ launch: { id: launch.id, outcome: "stopped" } })
  expect(fed).toEqual([
    { userID: "local", id: launch.id, state: "queued" },
    { userID: "local", id: launch.id, state: "ended" },
  ])
  const audit = await json(await h.api("/api/agent/audit"))
  expect(audit.entries.map((e: any) => [e.verb, e.target.launchID, e.outcome])).toEqual([
    ["launch.stop", launch.id, "ok"],
    ["launch", launch.id, "ok"],
    ["launch", launch.id, "ok"],
  ])
  await events.cancel()
})

test("an app token launches only with sessions:launch and a launch grant on the repo; the kill switch pauses it", async () => {
  h = await harness()
  const token = await json(await h.api("/api/agent/app-tokens", { method: "POST", json: { scopes: ["sessions:launch"] } }))
  const asApp = (pathname: string, init: RequestInit & { json?: unknown } = {}) => h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token.token}` } })
  expect((await asApp("/api/agent/launches", { method: "POST", json: body })).status).toBe(403)
  const granted = await h.api("/api/agent/grants", { method: "POST", json: { holder: `app:${token.id}`, scope: { projects: ["/p/hub"] }, allow: ["launch"] } })
  expect(granted.status).toBe(201)
  await h.api("/api/agent/acting", { method: "PUT", json: { enabled: false } })
  expect((await asApp("/api/agent/launches", { method: "POST", json: body })).status).toBe(423)
  await h.api("/api/agent/acting", { method: "PUT", json: { enabled: true } })
  const created = await asApp("/api/agent/launches", { method: "POST", json: body })
  expect(created.status).toBe(201)
  const { launch } = await json(created)
  expect(launch.by).toBe(`app:${token.id}`)
  expect((await json(await asApp("/api/agent/launches"))).launches.map((l: any) => l.id)).toEqual([launch.id])
  expect((await asApp(`/api/agent/launches/${launch.id}`, { method: "DELETE" })).status).toBe(200)
  // outside the grant's projects
  expect((await asApp("/api/agent/launches", { method: "POST", json: { ...body, key: "k2", workspace: { repo: "/elsewhere", branch: "b" } } })).status).toBe(403)
})
