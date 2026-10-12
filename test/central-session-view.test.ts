// Hub side of the 0.4 session view (docs/session-view.md): open/terminal pass-through, the machine's
// terminals (Herdr workspaces), new sessions opened in Herdr, and per-user view preferences synced
// between a user's devices (never across users).
import { afterEach, describe, expect, test } from "bun:test"
import { Store } from "../src/central/store"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"
import { fakeProvider, oidcEnv, signIn, type FakeProvider } from "./oidc-fake"

let h: Harness
let idp: FakeProvider | undefined
afterEach(async () => {
  await h?.stop()
  idp?.stop()
  idp = undefined
})

type Client = Awaited<ReturnType<typeof spoke>>

function answer(client: Client, reply: (req: any) => unknown) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const result = reply(frame.req)
    if (result instanceof Error) client.send({ t: "res", id: frame.id, ok: false, error: result.message })
    else if (result !== undefined) client.send({ t: "res", id: frame.id, ok: true, result })
  })
  return seen
}

const json = async (r: Response) => (await r.json()) as any
const HERDR = { source: "herdr" as const, workspaceID: "w5", workspace: "app", title: "Fix login", status: "working" as const }
const WORKSPACES = [
  { id: "w5", label: "app", directories: ["/home/user/app", "/home/user/app/web"] },
  { id: "w7", label: "notes", directories: ["/home/user/notes"] },
]

describe("open sessions and terminals", () => {
  test("open and terminal pass through to the catalog and the session view (open from any reporter)", async () => {
    h = harness()
    const { machine, token } = h.store.addMachine("laptop")
    await spoke(h, {
      machine: { token },
      processID: "p_service",
      hello: { kind: "service" },
      sessions: [session("ses_a", { open: true, terminal: HERDR, updated: 1 }), session("ses_b")],
    })
    // A standalone reports the same session more recently, without open.
    await spoke(h, { machine: { token }, processID: "p_tui", sessions: [session("ses_a", { updated: 5 })] })
    const body = await json(await h.api("/api/machines"))
    const service = body.machines[0].processes.find((p: any) => p.id === "p_service")
    expect(service.sessions.find((s: any) => s.id === "ses_a")).toMatchObject({ open: true, terminal: HERDR })
    expect(service.sessions.find((s: any) => s.id === "ses_b").open).toBeUndefined()
    expect(await json(await h.api("/api/sessions/ses_a"))).toMatchObject({ id: "ses_a", open: true, terminal: HERDR, updated: 5 })
    expect((await json(await h.api("/api/sessions/ses_b"))).open).toBeUndefined()
    expect(machine.id).toBe(body.machines[0].id)
  })

  test("the machine's terminals frame shows in GET /api/machines and the SSE catalog; it goes when its process does", async () => {
    h = harness()
    const { token } = h.store.addMachine("laptop")
    const events = sse(await h.api("/api/events"))
    const service = await spoke(h, { machine: { token }, processID: "p_service", hello: { kind: "service" } })
    service.send({ t: "terminals", herdr: { workspaces: WORKSPACES } })
    const catalog = await events.next((m) => m.type === "catalog" && m.machines[0]?.terminals)
    expect(catalog.machines[0].terminals).toEqual({ herdr: { workspaces: WORKSPACES } })
    expect((await json(await h.api("/api/machines"))).machines[0].terminals).toEqual({ herdr: { workspaces: WORKSPACES } })
    // Herdr went away: an empty frame clears it.
    service.send({ t: "terminals" })
    await waitFor(() => h.registry.terminals(h.store.machines()[0]!.id)?.herdr === undefined)
    service.send({ t: "terminals", herdr: { workspaces: WORKSPACES } })
    await waitFor(() => h.registry.terminals(h.store.machines()[0]!.id)?.herdr !== undefined)
    service.close()
    await waitFor(() => h.registry.terminals(h.store.machines()[0]!.id) === undefined)
    expect((await json(await h.api("/api/machines"))).machines[0].terminals).toBeUndefined()
    events.cancel()
  })
})

describe("POST /api/machines/:machineID/sessions with herdrWorkspace", () => {
  async function machine() {
    const { machine, token } = h.store.addMachine("laptop")
    const client = await spoke(h, {
      machine: { token },
      hello: { kind: "service" },
      sessions: [session("ses_a", { directory: "/home/user/app", project: "/home/user/app", projectName: "app" })],
    })
    client.send({ t: "terminals", herdr: { workspaces: WORKSPACES } })
    await waitFor(() => h.registry.terminals(machine.id) !== undefined)
    return { machineID: machine.id, client }
  }
  const post = (path: string, json: unknown) => h.api(path, { method: "POST", json })

  test("forwards herdrWorkspace and returns openedIn; a Herdr pane folder is a valid directory", async () => {
    h = harness()
    const { machineID, client } = await machine()
    const seen = answer(client, (req) => (req.op === "create" ? { sessionID: "ses_new", openedIn: "herdr" } : undefined))
    const res = await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/notes", title: "Idea", herdrWorkspace: "w7" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ sessionID: "ses_new", openedIn: "herdr" })
    expect(seen).toEqual([{ op: "create", directory: "/home/user/notes", title: "Idea", herdrWorkspace: "w7" }])
  })

  test("Herdr failed: 201 without openedIn, with the spoke's warning (or a generic one)", async () => {
    h = harness()
    const { machineID, client } = await machine()
    let reply: unknown = { sessionID: "ses_new", warning: "Could not open the session in Herdr: boom" }
    answer(client, () => reply)
    const res = await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/app", herdrWorkspace: "w5" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ sessionID: "ses_new", warning: "Could not open the session in Herdr: boom" })
    reply = { sessionID: "ses_new2" }
    const generic = await json(await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/app", herdrWorkspace: "w5" }))
    expect(generic.sessionID).toBe("ses_new2")
    expect(generic.openedIn).toBeUndefined()
    expect(generic.warning).toMatch(/herdr/i)
    // Without herdrWorkspace no warning is added.
    expect(await json(await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/app" }))).toEqual({ sessionID: "ses_new2" })
  })

  test("validates herdrWorkspace", async () => {
    h = harness()
    const { machineID, client } = await machine()
    const seen = answer(client, () => ({ sessionID: "ses_new" }))
    for (const bad of [5, "", "x".repeat(101)]) {
      expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/app", herdrWorkspace: bad })).status).toBe(400)
    }
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/home/user/elsewhere", herdrWorkspace: "w5" })).status).toBe(400)
    expect(seen).toEqual([])
  })
})

describe("view preferences", () => {
  const EMPTY = { hiddenSessions: [], hiddenWorkspaces: [], pinnedSessions: [], pinnedWorkspaces: [] }
  const put = (json: unknown, init: { cookie?: string; origin?: string | null } = {}) => h.api("/api/prefs/view", { method: "PUT", json, ...init })

  test("GET defaults to empty lists; PUT replaces only the lists given; stored on the user record", async () => {
    h = harness()
    expect(await json(await h.api("/api/prefs/view"))).toEqual({ prefs: EMPTY })
    const first = await put({ hiddenSessions: ["ses_a", "ses_a", "ses_b"], pinnedWorkspaces: ["herdr:w5", "/home/user/app"] })
    expect(first.status).toBe(200)
    expect(await json(first)).toEqual({ prefs: { ...EMPTY, hiddenSessions: ["ses_a", "ses_b"], pinnedWorkspaces: ["herdr:w5", "/home/user/app"] } })
    await put({ pinnedSessions: ["ses_c"] })
    const after = await json(await h.api("/api/prefs/view"))
    expect(after.prefs).toEqual({ ...EMPTY, hiddenSessions: ["ses_a", "ses_b"], pinnedSessions: ["ses_c"], pinnedWorkspaces: ["herdr:w5", "/home/user/app"] })
    expect(Store.open(h.stateDir).user("local")?.viewPrefs).toEqual(after.prefs)
  })

  test("refuses bad input and cross-origin writes", async () => {
    h = harness()
    for (const bad of [
      { hiddenSessions: "ses_a" },
      { hiddenSessions: [3] },
      { hiddenSessions: ["x".repeat(4097)] },
      { hiddenSessions: Array.from({ length: 501 }, (_, i) => `ses_${i}`) },
      { other: [] },
      {},
      [],
    ]) {
      expect((await put(bad)).status).toBe(400)
    }
    expect((await put({ hiddenSessions: ["ses_a"] }, { origin: null })).status).toBe(403)
    expect((await h.api("/api/prefs/view", { cookie: null })).status).toBe(401)
    expect((await json(await h.api("/api/prefs/view"))).prefs).toEqual(EMPTY)
    // Limits are inclusive.
    expect((await put({ hiddenWorkspaces: Array.from({ length: 500 }, (_, i) => `/w/${i}`), pinnedSessions: ["x".repeat(4096)] })).status).toBe(200)
  })

  test("SSE prefs reach the user's other devices, not the device that changed them, and never another user", async () => {
    idp = fakeProvider()
    h = harness({ env: oidcEnv(idp), noDevice: true })
    const phone = (await signIn(h.url, idp, "alice@example.com")).cookie!
    const laptop = (await signIn(h.url, idp, "alice@example.com")).cookie!
    const bob = (await signIn(h.url, idp, "bob@example.com")).cookie!
    const onPhone = sse(await h.api("/api/events", { cookie: phone }))
    const onLaptop = sse(await h.api("/api/events", { cookie: laptop }))
    const onBob = sse(await h.api("/api/events", { cookie: bob }))
    for (const s of [onPhone, onLaptop, onBob]) await s.next((m) => m.type === "catalog")
    expect((await put({ hiddenSessions: ["ses_alice"] }, { cookie: phone })).status).toBe(200)
    const pushed = await onLaptop.next((m) => m.type === "prefs")
    expect(pushed.prefs.hiddenSessions).toEqual(["ses_alice"])
    await expect(onPhone.next((m) => m.type === "prefs", 300)).rejects.toThrow(/timed out/)
    await expect(onBob.next((m) => m.type === "prefs", 300)).rejects.toThrow(/timed out/)
    // Each user has their own prefs.
    expect((await json(await h.api("/api/prefs/view", { cookie: bob }))).prefs.hiddenSessions).toEqual([])
    expect((await json(await h.api("/api/prefs/view", { cookie: laptop }))).prefs.hiddenSessions).toEqual(["ses_alice"])
    for (const s of [onPhone, onLaptop, onBob]) s.cancel()
  })
})
