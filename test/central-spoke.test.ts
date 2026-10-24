import { afterEach, describe, expect, test } from "bun:test"
import { TURN_GRACE_MS } from "../src/central/spoke-ws"
import { HUB_FEATURES, PROTOCOL_VERSION } from "../src/protocol"
import { connect, harness, hello, PUBLIC, session, spoke, sse, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

/** Answers every server request with `answer(req)` (or leaves it pending when it returns undefined). */
function answer(client: Awaited<ReturnType<typeof spoke>>, reply: (req: any) => unknown) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const result = reply(frame.req)
    if (result !== undefined) client.send({ t: "res", id: frame.id, ok: true, result })
  })
  return seen
}

describe("spoke authentication", () => {
  test("upgrade without, with invalid, or with revoked token is refused with 401", async () => {
    h = harness()
    const ws = `${h.url}/spoke/ws`
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }
    expect((await fetch(ws, { headers: upgrade })).status).toBe(401)
    expect((await fetch(ws, { headers: { ...upgrade, authorization: "Bearer nope" } })).status).toBe(401)
    const { machine, token } = h.store.addMachine("old")
    h.store.revokeMachine(machine.id)
    expect((await fetch(ws, { headers: { ...upgrade, authorization: `Bearer ${token}` } })).status).toBe(401)
    expect((await fetch(`${ws}?token=${token}`, { headers: upgrade })).status).toBe(401)
    await expect(connect(h, "nope")).rejects.toThrow()
  })

  test("hello with the wrong protocol version gets bye and close", async () => {
    h = harness()
    const client = await connect(h, h.store.addMachine("m").token)
    client.send(hello("p1", { v: PROTOCOL_VERSION + 1 }))
    expect(await client.next((f) => f.t === "bye")).toEqual({ t: "bye", reason: expect.stringContaining("version") })
    await client.closed
    expect(h.registry.connections()).toBe(0)
  })

  test("a first frame other than hello is a protocol error", async () => {
    h = harness()
    const client = await connect(h, h.store.addMachine("m").token)
    client.send({ t: "sessions", sessions: [] })
    expect((await client.next((f) => f.t === "bye")).reason).toBe("protocol error")
    await client.closed
  })

  test("invalid frames after hello are a protocol error", async () => {
    h = harness()
    const client = await spoke(h)
    client.send("{not json")
    expect((await client.next((f) => f.t === "bye")).reason).toBe("protocol error")
    await client.closed
    await waitFor(() => h.registry.connections() === 0)
  })

  test("hello must arrive within the hello timeout", async () => {
    h = harness({ timing: { helloTimeoutMs: 50 } })
    const client = await connect(h, h.store.addMachine("m").token)
    expect((await client.next((f) => f.t === "bye")).reason).toContain("hello")
    await client.closed
  })

  test("welcome carries machine ID, public URL and the hub's features; catalog shows reported sessions", async () => {
    h = harness()
    const { machine, token } = h.store.addMachine("laptop")
    const client = await connect(h, token)
    client.send(hello("p1"))
    expect(await client.next()).toEqual({ t: "welcome", v: PROTOCOL_VERSION, machineID: machine.id, publicURL: PUBLIC, features: [...HUB_FEATURES] })
    client.send({ t: "sessions", sessions: [session("ses_1", { owned: true })] })
    await waitFor(() => h.registry.hasSession("ses_1"))
    const body = (await (await h.api("/api/machines")).json()) as any
    const laptop = body.machines.find((m: any) => m.id === machine.id)
    expect(laptop).toMatchObject({ name: "laptop", online: true })
    expect(laptop.processes[0].sessions[0]).toMatchObject({ id: "ses_1", owned: true, busy: false })
    // An old hello (no harness) is listed as OpenCode, with its version under both names.
    expect(laptop.processes[0]).toMatchObject({ harness: "opencode", harnessVersion: "2.0.0", evidence: "native", opencodeVersion: "2.0.0" })
  })

  test("stale sockets are dropped by the heartbeat", async () => {
    // Several heartbeats fit in the sleep below; staleMs leaves room for pong latency under load.
    h = harness({ timing: { heartbeatMs: 20, staleMs: 400 } })
    const client = await spoke(h)
    // The Bun client answers pings automatically, so a live socket stays connected.
    await Bun.sleep(150)
    expect(h.registry.connections()).toBe(1)
    client.close()
    await waitFor(() => h.registry.connections() === 0)
  })

  test("revoking a machine closes its sockets with bye revoked", async () => {
    h = harness()
    const client = await spoke(h)
    const machineID = h.store.findMachine(client.token)!.id
    const res = await h.api(`/api/machines/${machineID}`, { method: "DELETE" })
    expect(res.status).toBe(204)
    expect((await client.next((f) => f.t === "bye")).reason).toBe("revoked")
    await client.closed
    expect(h.store.findMachine(client.token)).toBeUndefined()
  })
})

describe("status and SSE", () => {
  test("events update status and SSE emits status and delta", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const events = sse(await h.api("/api/events"))
    expect((await events.next()).type).toBe("catalog")
    client.send({ t: "event", event: { type: "session.execution.started", data: { sessionID: "ses_1" } } })
    const status = await events.next((m) => m.type === "status")
    expect(status).toMatchObject({ sessionID: "ses_1", sessions: [{ id: "ses_1", state: "working" }] })
    client.send({ t: "event", event: { type: "session.text.delta", data: { sessionID: "ses_1", delta: "Hel" } } })
    expect(await events.next((m) => m.type === "delta")).toEqual({ type: "delta", sessionID: "ses_1", rootID: "ses_1", text: "Hel" })
    await events.cancel()
  })
})

describe("turns", () => {
  test("routes to the owned standalone process with voiceStyle, returns its TurnResult", async () => {
    h = harness()
    const machine = h.store.addMachine("laptop")
    const svc = await spoke(h, { machine, processID: "svc", hello: { kind: "service" }, sessions: [session("ses_1")] })
    const svcSeen = answer(svc, () => ({ outcome: "succeeded", reply: "from service" }))
    const tui = await spoke(h, { machine, processID: "tui", sessions: [session("ses_1", { owned: true })] })
    const tuiSeen = answer(tui, () => ({ outcome: "succeeded", reply: "from tui" }))
    const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: " hello " } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: "succeeded", reply: "from tui" })
    expect(tuiSeen).toEqual([{ op: "turn", sessionID: "ses_1", text: "hello", voiceStyle: true }])
    expect(svcSeen).toEqual([])
  })

  test("falls back to the service process when nobody owns the session", async () => {
    h = harness()
    const machine = h.store.addMachine("laptop")
    const tui = await spoke(h, { machine, processID: "tui", sessions: [session("ses_1")] })
    const tuiSeen = answer(tui, () => ({ outcome: "succeeded", reply: "tui" }))
    const svc = await spoke(h, { machine, processID: "svc", hello: { kind: "service" } })
    answer(svc, () => ({ outcome: "succeeded", reply: "service" }))
    const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "hi" } })
    expect(await res.json()).toEqual({ outcome: "succeeded", reply: "service" })
    expect(tuiSeen).toEqual([])
  })

  test("second turn while one runs is 409; unreported session is 404; empty text is 400", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true }), session("ses_2")] })
    let finish: (() => void) | undefined
    client.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t === "req") finish = () => client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "succeeded", reply: "ok" } })
    })
    const first = h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "one" } })
    await waitFor(() => finish !== undefined)
    const second = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "two" } })
    expect(second.status).toBe(409)
    expect(((await second.json()) as any).error).toBe("A turn is already running for this session")
    finish!()
    expect((await first).status).toBe(200)

    // 0.3.0: a session none of your machines reports is 404 (as another user's would be).
    const none = await h.api("/api/sessions/ses_unreported/turn", { method: "POST", json: { text: "x" } })
    expect(none.status).toBe(404)
    expect(((await none.json()) as any).error).toBe("Not found")
    expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "  " } })).status).toBe(400)
  })

  test("a prompt over 100,000 characters is 400 and never reaches the spoke", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = answer(client, () => ({ outcome: "succeeded", reply: "ok" }))
    const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "x".repeat(100_001) } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe("Prompt longer than 100000 characters")
    expect(seen).toEqual([])
    expect(h.registry.catalog()[0]!.processes[0]!.sessions[0]!.busy).toBe(false)
    expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "x".repeat(100_000) } })).status).toBe(200)
  })

  test("a request too large for one frame is refused at once instead of hanging", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const seen = answer(client, () => ({}))
    const connID = h.registry.owner("ses_1")!
    const started = Date.now()
    await expect(h.spokes.request(connID, { op: "steer", sessionID: "ses_1", text: '"'.repeat(600_000) })).rejects.toThrow(/too large/i)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(seen).toEqual([])
  })

  for (const action of ["stop", "interrupt"] as const) {
    test(`${action} releases the hub's turn lock and ends the in-flight turn request`, async () => {
      h = harness()
      const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
      let turns = 0
      answer(client, (req) => {
        if (req.op === "stop") return { stopped: [req.sessionID] }
        if (req.op === "interrupt") return {}
        if (req.op === "turn" && ++turns > 1) return { outcome: "succeeded", reply: "again" }
        return undefined // the first turn never gets an answer (e.g. the spoke lost it)
      })
      const first = h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "one" } })
      await waitFor(() => turns === 1)
      expect((await h.api(`/api/sessions/ses_1/${action}`, { method: "POST" })).status).toBeLessThan(300)
      const ended = await first
      expect(ended.status).toBe(200)
      expect(await ended.json()).toMatchObject({ outcome: "interrupted" })
      const next = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "two" } })
      expect(next.status).toBe(200)
      expect(await next.json()).toEqual({ outcome: "succeeded", reply: "again" })
    })
  }

  test("the hub waits a grace period past the turn timeout so the spoke's own timeout result wins", async () => {
    expect(TURN_GRACE_MS).toBe(15_000)
    h = harness({ env: { HUB_TURN_TIMEOUT_MS: "100" }, timing: { turnGraceMs: 400 } })
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    client.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t !== "req") return
      setTimeout(() => client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "timeout", reply: "partial" } }), 200)
    })
    const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "slow" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: "timeout", reply: "partial" })
  })

  test("turn timeout is 504 and releases the session", async () => {
    h = harness({ env: { HUB_TURN_TIMEOUT_MS: "100" }, timing: { turnGraceMs: 50 } })
    await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "slow" } })
    expect(res.status).toBe(504)
    expect(h.registry.catalog()[0]!.processes[0]!.sessions[0]!.busy).toBe(false)
  })

  test("spoke error response is 502; disconnect mid-turn is 502", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    client.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t === "req" && frame.req.text === "fail") client.send({ t: "res", id: frame.id, ok: false, error: "boom" })
      if (frame.t === "req" && frame.req.text === "drop") client.close()
    })
    const failed = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "fail" } })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as any).error).toContain("boom")
    const dropped = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "drop" } })
    expect(dropped.status).toBe(502)
  })

  describe("Prefer: respond-async", () => {
    const async = { "prefer": "respond-async" }

    test("a slow turn answers 202 at once; the lock holds until it ends; its result comes over SSE", async () => {
      h = harness({ timing: { turnAcceptMs: 50 } })
      const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
      let finish: (() => void) | undefined
      client.ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.t === "req" && frame.req.op === "turn") finish = () => client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "failed", message: "model error", reply: "half" } })
      })
      const events = sse(await h.api("/api/events"))
      const started = Date.now()
      const res = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "long task" }, headers: async })
      expect(res.status).toBe(202)
      expect(res.headers.get("preference-applied")).toBe("respond-async")
      expect(await res.json()).toEqual({ mode: "turn" })
      expect(Date.now() - started).toBeLessThan(2000)
      // Still the session's turn: a second one is refused until it ends.
      expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "two" }, headers: async })).status).toBe(409)
      finish!()
      expect(await events.next((m) => m.type === "turn")).toEqual({ type: "turn", sessionID: "ses_1", outcome: "failed", message: "model error", reply: "half" })
      await waitFor(() => h.registry.catalog()[0]!.processes[0]!.sessions[0]!.busy === false)
      await events.cancel()
    })

    test("a turn that settles within the accept window answers as before (result or error)", async () => {
      h = harness({ timing: { turnAcceptMs: 2000 } })
      const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
      client.ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.t !== "req") return
        if (frame.req.text === "fail") client.send({ t: "res", id: frame.id, ok: false, error: "boom" })
        else client.send({ t: "res", id: frame.id, ok: true, result: { outcome: "succeeded", reply: "quick" } })
      })
      const quick = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "hi" }, headers: async })
      expect(quick.status).toBe(200)
      expect(await quick.json()).toEqual({ outcome: "succeeded", reply: "quick" })
      const failed = await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "fail" }, headers: async })
      expect(failed.status).toBe(502)
    })

    test("a background turn that errors (spoke gone) reports failed over SSE and releases the lock", async () => {
      h = harness({ timing: { turnAcceptMs: 50 } })
      const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
      let drop: (() => void) | undefined
      client.ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.t === "req" && frame.req.op === "turn") drop = () => client.send({ t: "res", id: frame.id, ok: false, error: "boom" })
      })
      const events = sse(await h.api("/api/events"))
      expect((await h.api("/api/sessions/ses_1/turn", { method: "POST", json: { text: "x" }, headers: async })).status).toBe(202)
      drop!()
      expect(await events.next((m) => m.type === "turn")).toMatchObject({ type: "turn", sessionID: "ses_1", outcome: "failed", message: expect.stringContaining("boom") })
      await waitFor(() => h.registry.catalog()[0]!.processes[0]!.sessions[0]!.busy === false)
      await events.cancel()
    })
  })

  test("context is fetched from the owner", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    answer(client, (req) => (req.op === "context" ? { messages: [{ role: "user", text: "hi" }] } : undefined))
    const res = await h.api("/api/sessions/ses_1/context")
    expect(await res.json()).toEqual({ messages: [{ role: "user", text: "hi" }] })
  })
})

describe("permissions", () => {
  test("routed only when pending, to the process that asked, with the asking session", async () => {
    h = harness()
    const machine = h.store.addMachine("laptop")
    const owner = await spoke(h, { machine, processID: "a", sessions: [session("ses_1", { owned: true })] })
    const ownerSeen = answer(owner, () => ({}))
    const other = await spoke(h, { machine, processID: "b", hello: { kind: "service" }, sessions: [session("ses_1")] })
    const otherSeen = answer(other, () => ({}))

    const body = { requestID: "per_1", decision: "once" }
    expect((await h.api("/api/sessions/ses_1/permission", { method: "POST", json: body })).status).toBe(409)

    other.send({ t: "event", event: { type: "session.created", data: { sessionID: "ses_sub", parentID: "ses_1", title: "sub" } } })
    other.send({ t: "event", event: { type: "permission.asked", data: { sessionID: "ses_sub", id: "per_1", action: "bash" } } })
    await waitFor(() => h.registry.permissionTarget("ses_1", "per_1") !== undefined)
    expect((await h.api("/api/sessions/ses_1/permission", { method: "POST", json: { ...body, decision: "maybe" } })).status).toBe(400)
    const res = await h.api("/api/sessions/ses_1/permission", { method: "POST", json: body })
    expect(res.status).toBe(204)
    expect(otherSeen).toEqual([{ op: "permission", sessionID: "ses_sub", requestID: "per_1", decision: "once" }])
    expect(ownerSeen).toEqual([])
  })
})

describe("permissions asked where several processes see them", () => {
  async function twoForwarders(firstReply: (req: any) => unknown, secondReply: (req: any) => unknown) {
    h = harness()
    const machine = h.store.addMachine("laptop")
    const first = await spoke(h, { machine, processID: "a", hello: { kind: "service" }, sessions: [session("ses_1")] })
    const firstSeen = answer(first, firstReply)
    const second = await spoke(h, { machine, processID: "b", sessions: [session("ses_1", { owned: true })] })
    const secondSeen = answer(second, secondReply)
    const asked = { t: "event", event: { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash" } } } as const
    first.send(asked)
    await waitFor(() => h.registry.permissionTarget("ses_1", "per_1") !== undefined)
    second.send(asked)
    await Bun.sleep(50)
    return { firstSeen, secondSeen, second }
  }

  test("a process that does not hold the request (gone) is skipped for the next one that saw it", async () => {
    const { firstSeen, secondSeen } = await twoForwarders(() => ({ gone: true }), () => ({}))
    const res = await h.api("/api/sessions/ses_1/permission", { method: "POST", json: { requestID: "per_1", decision: "once" } })
    expect(res.status).toBe(204)
    expect(firstSeen).toHaveLength(1)
    expect(secondSeen).toEqual([{ op: "permission", sessionID: "ses_1", requestID: "per_1", decision: "once" }])
  })

  test("a request nobody holds any more is a 409 with a friendly message and its card goes away", async () => {
    // An older spoke answers with OpenCode's error instead of {gone: true}.
    const { firstSeen, secondSeen, second } = await twoForwarders(() => ({ gone: true }), () => undefined)
    second.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.t === "req") second.send({ t: "res", id: frame.id, ok: false, error: `Permission request not found: ${frame.req.requestID}` })
    })
    const res = await h.api("/api/sessions/ses_1/permission", { method: "POST", json: { requestID: "per_1", decision: "once" } })
    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.code).toBe("gone")
    expect(body.error).toMatch(/already answered or expired/i)
    expect(firstSeen).toHaveLength(1)
    expect(secondSeen).toHaveLength(1)
    const view = (await (await h.api("/api/sessions/ses_1")).json()) as any
    expect(view.blockers).toEqual([])
    expect((await h.api("/api/sessions/ses_1/permission", { method: "POST", json: { requestID: "per_1", decision: "once" } })).status).toBe(409)
  })
})

describe("forms (questions)", () => {
  test("answered from the hub through the process that asked; cancel too; validation and gone", async () => {
    h = harness()
    const machine = h.store.addMachine("laptop")
    const client = await spoke(h, { machine, processID: "a", sessions: [session("ses_1", { owned: true })] })
    const seen = answer(client, (req) => (req.formID === "frm_gone" ? { gone: true } : {}))
    const post = (json: unknown) => h.api("/api/sessions/ses_1/form", { method: "POST", json })
    expect((await post({ formID: "frm_1", answer: { q0: "red" } })).status).toBe(409)
    client.send({ t: "event", event: { type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_1", title: "Q", fields: [{ key: "q0", type: "string" }] } } } })
    client.send({ t: "event", event: { type: "form.created", data: { form: { id: "frm_gone", sessionID: "ses_1", title: "Q2" } } } })
    await waitFor(() => h.registry.formTargets("ses_1", "frm_gone").length > 0)
    expect((await post({ formID: "frm_1" })).status).toBe(400)
    expect((await post({ formID: "frm_1", answer: { q0: { x: 1 } } })).status).toBe(400)
    expect((await post({ formID: "frm_1", answer: { q0: "red", q1: ["a"] } })).status).toBe(204)
    expect((await post({ formID: "frm_1", cancel: true })).status).toBe(204)
    expect(seen).toEqual([
      { op: "form", sessionID: "ses_1", formID: "frm_1", answer: { q0: "red", q1: ["a"] } },
      { op: "form", sessionID: "ses_1", formID: "frm_1", cancel: true },
    ])
    const gone = await post({ formID: "frm_gone", answer: {} })
    expect(gone.status).toBe(409)
    expect(((await gone.json()) as any).code).toBe("gone")
    const view = (await (await h.api("/api/sessions/ses_1")).json()) as any
    expect(view.blockers.map((b: any) => b.id)).toEqual(["frm_1"])
    expect(view.blockers[0].fields).toEqual([{ key: "q0", type: "string" }])
  })
})

describe("spoke requests", () => {
  test("pairCode returns a code that pairs a device exactly once", async () => {
    h = harness()
    const client = await spoke(h)
    client.send({ t: "req", id: "r1", req: { op: "pairCode" } })
    const res = await client.next((f) => f.t === "res" && f.id === "r1")
    expect(res.ok).toBe(true)
    const { code, url, expiresAt } = res.result
    expect(code).toMatch(/^\d{6}$/)
    expect(url).toBe(`${PUBLIC}/pair`)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const paired = await h.api("/api/pair", { method: "POST", cookie: null, json: { code, deviceName: "phone" } })
    expect(paired.status).toBe(200)
    const setCookie = paired.headers.get("set-cookie")!
    expect(setCookie).toMatch(/^voice_device=[A-Za-z0-9_-]{43}; /)
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).toContain("Path=/")
    expect(setCookie).toContain("Max-Age=34560000")
    expect(setCookie).not.toContain("Secure")
    const again = await h.api("/api/pair", { method: "POST", cookie: null, json: { code, deviceName: "x" } })
    expect(again.status).toBe(401)
  })

  test("openLink returns a login URL that signs a browser in and redirects to the session", async () => {
    h = harness()
    const client = await spoke(h)
    client.send({ t: "req", id: "r2", req: { op: "openLink", sessionID: "ses_1" } })
    const res = await client.next((f) => f.t === "res" && f.id === "r2")
    const url = new URL(res.result.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC}/login`)
    expect(url.searchParams.get("next")).toBe("/s/ses_1")
    const login = await h.api(`/login${url.search}`, { cookie: null, origin: null })
    expect(login.status).toBe(302)
    expect(login.headers.get("location")).toBe("/s/ses_1#speech") // no speech key yet: land on speech setup
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    expect((await h.api("/api/me", { cookie })).status).toBe(200)
    const reuse = await h.api(`/login${url.search}`, { cookie: null, origin: null })
    expect(reuse.status).toBe(401)
  })

  test("openLink with voice lands on the session with ?voice=1 through the sign-in redirect", async () => {
    h = harness({ env: { OPENROUTER_API_KEY: "sk-or-v1-test-0123456789" } })
    const client = await spoke(h)
    client.send({ t: "req", id: "r2", req: { op: "openLink", sessionID: "ses_1", voice: true } })
    const res = await client.next((f) => f.t === "res" && f.id === "r2")
    const url = new URL(res.result.url)
    expect(url.searchParams.get("next")).toBe("/s/ses_1?voice=1")
    const login = await h.api(`/login${url.search}`, { cookie: null, origin: null })
    expect(login.status).toBe(302)
    expect(login.headers.get("location")).toBe("/s/ses_1?voice=1")
    // voice without a session is just the home page.
    client.send({ t: "req", id: "r3", req: { op: "openLink", voice: true } })
    const home = await client.next((f) => f.t === "res" && f.id === "r3")
    expect(new URL(home.result.url).searchParams.get("next")).toBe("/")
  })

  test("openLink without a session signs in to the home page; with speech ready there is no setup detour", async () => {
    h = harness({ env: { OPENROUTER_API_KEY: "sk-or-v1-test-0123456789" } })
    const client = await spoke(h)
    client.send({ t: "req", id: "r2", req: { op: "openLink" } })
    const res = await client.next((f) => f.t === "res" && f.id === "r2")
    expect(res.ok).toBe(true)
    const url = new URL(res.result.url)
    expect(url.searchParams.get("next")).toBe("/")
    const login = await h.api(`/login${url.search}`, { cookie: null, origin: null })
    expect(login.status).toBe(302)
    expect(login.headers.get("location")).toBe("/")
  })

  test("handoff emits SSE and notifies", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { title: "Fix bug" })] })
    const events = sse(await h.api("/api/events"))
    client.send({ t: "req", id: "r3", req: { op: "handoff", sessionID: "ses_1" } })
    expect(await client.next((f) => f.t === "res" && f.id === "r3")).toEqual({ t: "res", id: "r3", ok: true, result: { notified: 2 } })
    expect(await events.next((m) => m.type === "handoff")).toEqual({ type: "handoff", sessionID: "ses_1" })
    expect(h.notified).toEqual([{ kind: "handoff", sessionID: "ses_1", title: "Fix bug" }])
    await events.cancel()
  })
})
