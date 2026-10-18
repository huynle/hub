// Session browser on the hub: catalog fields, remote control without voice (speech stays gated), enabling voice
// (POST /api/sessions/:id/expose) and new sessions (POST /api/machines/:machineID/sessions).
import { afterEach, describe, expect, test } from "bun:test"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

type Client = Awaited<ReturnType<typeof spoke>>

/** Answers every server request with `reply(req)`; an Error answers ok:false. */
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

const post = (path: string, json?: unknown, init: { origin?: string | null; cookie?: string | null } = {}) =>
  h.api(path, { method: "POST", json: json ?? {}, ...init })

/** A machine with a service process reporting one exposed and one unexposed session. */
async function machine(options: { kind?: "service" | "standalone" } = {}) {
  const { machine, token } = h.store.addMachine("laptop")
  const client = await spoke(h, {
    machine: { token },
    hello: { kind: options.kind ?? "service", mode: "session" },
    sessions: [
      session("ses_on", { exposed: true, directory: "/u/voice/web", project: "/u/voice", projectName: "voice" }),
      session("ses_off", { exposed: false, directory: "/u/webshop", project: "/u/webshop", projectName: "webshop" }),
    ],
  })
  return { machineID: machine.id, client }
}

describe("catalog", () => {
  test("sessions carry exposure, workspace, owner process and machine, state and blockers", async () => {
    h = harness()
    const { machineID } = await machine()
    const body = (await (await h.api("/api/machines")).json()) as any
    const sessions = body.machines[0].processes[0].sessions
    expect(sessions.find((s: any) => s.id === "ses_on")).toMatchObject({
      exposed: true,
      project: "/u/voice",
      projectName: "voice",
      processID: "p1",
      machineID,
      state: "idle",
      blockers: [],
      conversation: false,
    })
    expect(sessions.find((s: any) => s.id === "ses_off")).toMatchObject({ exposed: false, state: "idle", status: [{ id: "ses_off", state: "idle" }] })
  })
})

describe("sessions without voice", () => {
  test("speech endpoints answer 403 not_exposed and never reach the spoke", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, () => ({}))
    for (const [action, json] of [["utterance", { text: "hi" }], ["conversation", { on: true }]] as const) {
      const res = await post(`/api/sessions/ses_off/${action}`, json)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Voice is not enabled for this session", code: "not_exposed" })
    }
    expect(seen).toEqual([])
  })

  test("inspection and typed control reach the spoke without Voice", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op === "turn") return { outcome: "succeeded", reply: "ok" }
      if (req.op === "context") return { messages: [] }
      if (req.op === "timeline") return { items: [] }
      if (req.op === "models") return { models: [] }
      if (req.op === "stop") return { stopped: [req.sessionID] }
      return {}
    })
    const turn = await post("/api/sessions/ses_off/turn", { text: "hi" })
    expect(turn.status).toBe(200)
    expect(await turn.json()).toEqual({ outcome: "succeeded", reply: "ok" })
    expect((await post("/api/sessions/ses_off/interrupt")).status).toBe(204)
    const stop = await post("/api/sessions/ses_off/stop")
    expect(stop.status).toBe(200)
    expect(await stop.json()).toEqual({ stopped: ["ses_off"] })
    for (const action of ["context", "timeline", "models"]) expect((await h.api(`/api/sessions/ses_off/${action}`)).status).toBe(200)
    expect(seen.map((r) => r.op)).toEqual(["turn", "interrupt", "stop", "context", "timeline", "models"])
    // A typed turn in a Voice-off session is not styled for speech.
    expect(seen[0]).toMatchObject({ op: "turn", sessionID: "ses_off", text: "hi", voiceStyle: false })
  })

  test("rename trims the title, reaches the owner spoke (also without Voice) and answers the title", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "rename" ? { title: req.title } : {}))
    const res = await post("/api/sessions/ses_off/rename", { title: "  Ship the release  " })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: "Ship the release" })
    expect(seen).toEqual([{ op: "rename", sessionID: "ses_off", title: "Ship the release" }])
  })

  test("rename refuses a missing, empty or too long title without asking the spoke", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, () => ({ title: "x" }))
    for (const json of [{}, { title: 5 }, { title: "" }, { title: "   " }, { title: "x".repeat(201) }]) {
      const res = await post("/api/sessions/ses_on/rename", json)
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/title/i)
    }
    expect((await post("/api/sessions/ses_on/rename", { title: "y".repeat(200) })).status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  test("rename falls back to another process reporting the session when the owner fails", async () => {
    h = harness()
    const { token } = h.store.addMachine("laptop")
    const owner = await spoke(h, { machine: { token }, processID: "p_owner", hello: { kind: "standalone" }, sessions: [session("ses_x", { owned: true })] })
    const other = await spoke(h, { machine: { token }, processID: "p_other", hello: { kind: "service" }, sessions: [session("ses_x")] })
    let otherFails = false
    const first = answer(owner, () => new Error("OpenCode refused"))
    const second = answer(other, (req) => (otherFails ? new Error("Unknown session") : { title: req.title }))
    const res = await post("/api/sessions/ses_x/rename", { title: "Fallback" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ title: "Fallback" })
    expect(first.map((r) => r.op)).toEqual(["rename"])
    expect(second.map((r) => r.op)).toEqual(["rename"])
    // Every reporter failing: the owner's error.
    otherFails = true
    const failed = await post("/api/sessions/ses_x/rename", { title: "Nope" })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as any).error).toBe("OpenCode refused")
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
  })

  test("a typed turn steers while the session tree is running", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "steer" ? { inboxID: "inb_1" } : undefined))
    client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_off" } } })
    await waitFor(() => h.registry.session("ses_off")?.state === "working")
    const res = await post("/api/sessions/ses_off/turn", { text: "use the other file" })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ mode: "steer", inboxID: "inb_1" })
    expect(seen).toEqual([{ op: "steer", sessionID: "ses_off", text: "use the other file" }])
  })

  test("GET /api/sessions/:id returns basic info with exposed:false", async () => {
    h = harness()
    await machine()
    const res = await h.api("/api/sessions/ses_off")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "ses_off", exposed: false, state: "idle", projectName: "webshop", status: [{ id: "ses_off" }], activity: [] })
    expect(await (await h.api("/api/sessions/ses_on")).json()).toMatchObject({ id: "ses_on", exposed: true })
  })
})

describe("right rail and unread", () => {
  test("summary and diff proxy to the owning spoke with validation; read marks are per user", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op === "summary") return { directory: "/u/webshop", changes: { files: [], additions: 0, deletions: 0 } }
      if (req.op === "diff") return req.file === "a.ts" ? { patch: { file: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@", truncated: false } } : {}
      return undefined
    })
    const summary = await h.api("/api/sessions/ses_off/summary")
    expect(summary.status).toBe(200)
    expect(await summary.json()).toEqual({ directory: "/u/webshop", changes: { files: [], additions: 0, deletions: 0 } })
    expect((await h.api("/api/sessions/ses_off/diff?file=a.ts")).status).toBe(200)
    expect((await h.api("/api/sessions/ses_off/diff?file=zzz")).status).toBe(404)
    expect((await h.api("/api/sessions/ses_off/diff")).status).toBe(400)
    expect((await h.api("/api/sessions/ses_missing/summary")).status).toBe(404)
    expect(seen).toEqual([
      { op: "summary", sessionID: "ses_off" },
      { op: "diff", sessionID: "ses_off", file: "a.ts" },
      { op: "diff", sessionID: "ses_off", file: "zzz" },
    ])

    const read = await post("/api/sessions/ses_off/read")
    expect(read.status).toBe(200)
    const { reads } = (await read.json()) as { reads: Record<string, number> }
    expect(reads.ses_off).toBeGreaterThan(0)
    expect(await (await h.api("/api/reads")).json()).toEqual({ reads })
    expect((await post("/api/sessions/ses_missing/read")).status).toBe(404)
  })
})

describe("POST /api/sessions/:id/expose", () => {
  test("asks a reporting process (service first) and returns its answer", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "expose" ? { exposed: req.on } : undefined))
    const res = await post("/api/sessions/ses_off/expose", { on: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exposed: true })
    expect(seen).toEqual([{ op: "expose", sessionID: "ses_off", on: true }])
    // Once the spoke's fresh snapshot arrives, the session's endpoints open up.
    client.send({ t: "sessions", sessions: [session("ses_off", { exposed: true })] })
    await waitFor(() => h.registry.exposed("ses_off") === true)
    answer(client, (req) => (req.op === "context" ? { messages: [] } : undefined))
    expect((await h.api("/api/sessions/ses_off/context")).status).toBe(200)
  })

  test("validates the body, unknown sessions, origin and cookie; spoke errors are 502", async () => {
    h = harness()
    const { client } = await machine()
    answer(client, () => new Error("Unknown session"))
    expect((await post("/api/sessions/ses_off/expose", { on: "yes" })).status).toBe(400)
    expect((await post("/api/sessions/ses_nope/expose", { on: true })).status).toBe(404)
    expect((await post("/api/sessions/ses_off/expose", { on: true }, { origin: "https://evil.example" })).status).toBe(403)
    expect((await post("/api/sessions/ses_off/expose", { on: true }, { cookie: null })).status).toBe(401)
    const failed = await post("/api/sessions/ses_off/expose", { on: true })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as any).error).toMatch(/unknown session/i)
  })
})

describe("POST /api/machines/:machineID/sessions", () => {
  test("creates a session through the machine's service process in a reported workspace", async () => {
    h = harness()
    const { machineID, client } = await machine()
    const seen = answer(client, (req) => (req.op === "create" ? { sessionID: "ses_new" } : undefined))
    const res = await post(`/api/machines/${machineID}/sessions`, { directory: "/u/voice", title: "Voice idea" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ sessionID: "ses_new" })
    expect(seen).toEqual([{ op: "create", directory: "/u/voice", title: "Voice idea" }])
    // A reported session directory works too; the title is optional.
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/u/voice/web/" })).status).toBe(201)
    expect(seen[1]).toEqual({ op: "create", directory: "/u/voice/web" })
  })

  test("refuses unknown workspaces, bad input, unknown machines and machines without a service", async () => {
    h = harness()
    const { machineID, client } = await machine()
    const seen = answer(client, () => ({ sessionID: "ses_new" }))
    const unknown = await post(`/api/machines/${machineID}/sessions`, { directory: "/etc" })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as any).error).toBe("unknown workspace")
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "relative/path" })).status).toBe(400)
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/u/voice", title: 7 })).status).toBe(400)
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/u/voice", title: "x".repeat(201) })).status).toBe(400)
    expect((await post("/api/machines/mch_nope/sessions", { directory: "/u/voice" })).status).toBe(404)
    expect((await post(`/api/machines/${machineID}/sessions`, { directory: "/u/voice" }, { origin: null })).status).toBe(403)
    expect(seen).toEqual([])

    const standalone = await machine({ kind: "standalone" })
    const none = await post(`/api/machines/${standalone.machineID}/sessions`, { directory: "/u/voice" })
    expect(none.status).toBe(409)
    expect(((await none.json()) as any).error).toMatch(/background service/i)
  })
})

describe("per-session models", () => {
  test("lists models and persists user-owned session preferences through the spoke", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op === "models") return { models: [{ providerID: "anthropic", modelID: "claude", name: "Claude", enabled: true, status: "active", variants: ["fast"] }] }
      if (req.op === "setModelPrefs") return { prefs: { voice: req.voice, ...(req.worker ? { worker: req.worker } : {}) }, defaults: {} }
      return undefined
    })
    expect(await (await h.api("/api/sessions/ses_on/models")).json()).toEqual({ models: [{ providerID: "anthropic", modelID: "claude", name: "Claude", enabled: true, status: "active", variants: ["fast"] }] })
    expect(await (await h.api("/api/sessions/ses_on/model-prefs")).json()).toEqual({ prefs: {}, defaults: {} })
    const selection = { providerID: "anthropic", modelID: "claude", variant: "fast" }
    const put = await h.api("/api/sessions/ses_on/model-prefs", { method: "PUT", json: { voice: selection } })
    expect(await put.json()).toEqual({ prefs: { voice: selection }, defaults: {} })
    expect(h.store.modelPrefs("local", "ses_on")).toEqual({ voice: selection })
    expect(seen).toContainEqual({ op: "setModelPrefs", sessionID: "ses_on", voice: selection })
    expect(seen).toContainEqual({ op: "setModelPrefs", sessionID: "ses_on", voice: null, worker: null })
  })

  test("model routes preserve session isolation and validate selections", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, () => ({ models: [] }))
    expect((await h.api("/api/sessions/ses_missing/models")).status).toBe(404)
    expect((await h.api("/api/sessions/ses_off/models")).status).toBe(200)
    expect((await h.api("/api/sessions/ses_on/model-prefs", { method: "PUT", json: { voice: { providerID: "bad space", modelID: "x" } } })).status).toBe(400)
    // Only the Voice-off session's catalog request reached the spoke; invalid input never does.
    expect(seen).toEqual([{ op: "models", sessionID: "ses_off" }])
  })

  test("PUT model-prefs rejects a model or variant that is not in the session's catalog", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op === "models") return { models: [{ providerID: "anthropic", modelID: "claude", name: "Claude", enabled: true, status: "active", variants: ["fast"] }] }
      if (req.op === "setModelPrefs") return { prefs: {}, defaults: {} }
      return undefined
    })
    const put = (json: unknown) => h.api("/api/sessions/ses_on/model-prefs", { method: "PUT", json })
    const unknownModel = await put({ voice: { providerID: "anthropic", modelID: "nope" } })
    expect(unknownModel.status).toBe(400)
    expect(((await unknownModel.json()) as any).error).toMatch(/Unknown model/)
    expect((await put({ worker: { providerID: "openai", modelID: "claude" } })).status).toBe(400)
    expect((await put({ voice: { providerID: "anthropic", modelID: "claude", variant: "slow" } })).status).toBe(400)
    expect(seen.some((req) => req.op === "setModelPrefs")).toBe(false)
    expect(h.store.modelPrefs("local", "ses_on")).toEqual({})
    // A known model (with or without a listed variant) and clearing are accepted.
    expect((await put({ voice: { providerID: "anthropic", modelID: "claude" }, worker: { providerID: "anthropic", modelID: "claude", variant: "fast" } })).status).toBe(200)
    expect((await put({ voice: null })).status).toBe(200)
  })

  test("PUT model-prefs answers 502 when the catalog cannot be fetched, and stores nothing", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "models" ? new Error("catalog down") : { prefs: {}, defaults: {} }))
    const res = await h.api("/api/sessions/ses_on/model-prefs", { method: "PUT", json: { voice: { providerID: "anthropic", modelID: "claude" } } })
    expect(res.status).toBe(502)
    expect(seen.some((req) => req.op === "setModelPrefs")).toBe(false)
    expect(h.store.modelPrefs("local", "ses_on")).toEqual({})
  })
})

describe("timeline history and details", () => {
  test("proxies bounded pages and full details for owned sessions, with or without Voice", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op === "timeline") return { items: [{ key: "u1:text", kind: "user", text: "hi" }], cursor: "next" }
      if (req.op === "timelinePart") return { detail: { state: { input: { secret: "visible to owner" }, content: [{ type: "text", text: "full" }] } } }
      return undefined
    })
    expect(await (await h.api("/api/sessions/ses_on/timeline?limit=25")).json()).toEqual({ items: [{ key: "u1:text", kind: "user", text: "hi" }], cursor: "next" })
    expect(await (await h.api("/api/sessions/ses_on/timeline/messages/msg_1/parts/tool_1")).json()).toEqual({ detail: { state: { input: { secret: "visible to owner" }, content: [{ type: "text", text: "full" }] } } })
    expect(seen).toEqual([
      { op: "timeline", sessionID: "ses_on", limit: 25 },
      { op: "timelinePart", sessionID: "ses_on", messageID: "msg_1", partID: "tool_1" },
    ])
    expect((await h.api("/api/sessions/ses_off/timeline")).status).toBe(200)
    expect((await h.api("/api/sessions/ses_missing/timeline")).status).toBe(404)
    expect((await h.api("/api/sessions/ses_on/timeline?limit=500")).status).toBe(400)
  })
})

describe("image prompts", () => {
  const pngBytes = (size = 32) => {
    const bytes = Buffer.alloc(size)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    return bytes
  }
  const png = pngBytes().toString("base64")
  const image = { mime: "image/png", data: png, name: "shot.png" }

  test("a turn forwards images; image-only prompts are allowed", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "turn" ? { outcome: "succeeded", reply: "a cat" } : undefined))
    const res = await post("/api/sessions/ses_off/turn", { text: "  ", images: [image] })
    expect(res.status).toBe(200)
    expect(seen).toEqual([{ op: "turn", sessionID: "ses_off", text: "", voiceStyle: false, images: [image] }])
    // No images key at all without images (older spokes keep working).
    await post("/api/sessions/ses_off/turn", { text: "plain", images: [] })
    expect(seen[1]).toEqual({ op: "turn", sessionID: "ses_off", text: "plain", voiceStyle: false })
  })

  test("a steer while running forwards images too", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => (req.op === "steer" ? { inboxID: "inb_1" } : undefined))
    client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_off" } } })
    await waitFor(() => h.registry.session("ses_off")?.state === "working")
    const res = await post("/api/sessions/ses_off/turn", { text: "this one", images: [image] })
    expect(res.status).toBe(202)
    expect(seen).toEqual([{ op: "steer", sessionID: "ses_off", text: "this one", images: [image] }])
  })

  test("invalid images answer 400 with a clear message and never reach the spoke", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, () => ({}))
    const big = pngBytes(Math.floor(512 * 1024 * 0.9)).toString("base64")
    const cases: Array<[unknown, RegExp]> = [
      [Array.from({ length: 5 }, () => image), /at most 4/],
      [[{ ...image, mime: "image/svg+xml" }], /type must be/],
      [[{ ...image, data: "%%%" }], /base64/],
      [[{ ...image, mime: "image/jpeg" }], /does not match/],
      [[{ ...image, data: pngBytes(512 * 1024 + 1).toString("base64") }], /larger than 512 KB/],
      [[{ ...image, data: big }, { ...image, data: big }], /together/],
      ["nope", /array/],
    ]
    for (const [images, message] of cases) {
      const res = await post("/api/sessions/ses_off/turn", { text: "x", images })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(message)
    }
    expect((await post("/api/sessions/ses_off/turn", { text: "", images: [] })).status).toBe(400)
    expect(seen).toEqual([])
  })

  test("serves a user message's image with its type, uncached; 404 without one, 413 when too large", async () => {
    h = harness()
    const { client } = await machine()
    const seen = answer(client, (req) => {
      if (req.op !== "timelineFile") return undefined
      if (req.messageID === "big") return { tooLarge: true }
      if (req.messageID === "svg") return { file: { mime: "image/svg+xml", data: png } }
      return req.index === 0 ? { file: image } : {}
    })
    const res = await h.api("/api/sessions/ses_on/timeline/messages/msg_1/files/0")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(Buffer.from(await res.arrayBuffer()).equals(pngBytes())).toBe(true)
    expect(seen).toEqual([{ op: "timelineFile", sessionID: "ses_on", messageID: "msg_1", index: 0 }])
    expect((await h.api("/api/sessions/ses_on/timeline/messages/msg_1/files/1")).status).toBe(404)
    expect((await h.api("/api/sessions/ses_on/timeline/messages/big/files/0")).status).toBe(413)
    expect((await h.api("/api/sessions/ses_on/timeline/messages/svg/files/0")).status).toBe(404)
    expect((await h.api("/api/sessions/ses_on/timeline/messages/msg_1/files/x")).status).toBe(400)
    expect((await h.api("/api/sessions/ses_on/timeline/messages/msg_1/files/1000")).status).toBe(400)
    expect((await h.api("/api/sessions/ses_missing/timeline/messages/msg_1/files/0")).status).toBe(404)
  })
})
