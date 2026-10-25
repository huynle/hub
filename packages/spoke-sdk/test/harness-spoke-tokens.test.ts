// HarnessSpoke tokens and deliver: session and act tokens kept apart, in memory, never in logs or serialised output;
// each hub message admitted once (DeliveryLedger) whatever the harness does with duplicates.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { DeliverMeta, SessionInfo } from "../../protocol/src/index.ts"
import { HarnessSpoke, hubSessionID, type Admission, type DeliverRequest, type HarnessSpokeOptions } from "../src/index.ts"
import { call, fakeSockets } from "./fake-socket.ts"

const S1 = hubSessionID("cc", "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f")
const S2 = hubSessionID("cc", "0a1b2c3d-4d5a-4b6c-9e7f-3f2b8c1e4d5e")
const info = (id: string): SessionInfo => ({ id, title: "t", directory: "/w", updated: 1, owned: true })
const MACHINE = "hmt1.MACHINE-SECRET-TOKEN"
const SESSION_TOKEN = "hst1.SESSION-SECRET-TOKEN"
const ACT_TOKEN = "hat1.ACT-SECRET-TOKEN"
const META: DeliverMeta = { kind: "msg", from: "@alice", to: "@bob" }

const spokes: HarnessSpoke[] = []
afterEach(() => {
  for (const s of spokes.splice(0)) s.stop()
})

function connected(options: Partial<HarnessSpokeOptions> = {}) {
  const sockets = fakeSockets()
  const spoke = new HarnessSpoke({
    server: "https://hub.example",
    token: MACHINE,
    harness: "claude-code",
    harnessVersion: "2.1.296",
    evidence: "hooks",
    pluginVersion: "0.6.1",
    directory: "/w",
    socket: sockets.factory,
    ...options,
  })
  spokes.push(spoke)
  spoke.start()
  sockets.last.open()
  sockets.last.welcome()
  return { spoke, socket: sockets.last }
}

describe("session and act tokens", () => {
  test("stores tokens for reported sessions and skips unknown or expired ones", async () => {
    let now = 1000
    const { spoke, socket } = connected({ now: () => now })
    spoke.upsertSession(info(S1))
    const res = await call(socket, {
      op: "sessionTokens",
      hubURL: "https://hub.internal",
      tokens: [
        { sessionID: S1, token: SESSION_TOKEN, exp: 5000 },
        { sessionID: S2, token: "hst1.other", exp: 5000 },
      ],
    })
    expect(res).toEqual({ t: "res", id: expect.any(String), ok: true, result: { applied: [S1], skipped: [{ sessionID: S2, reason: "unknown" }] } } as never)
    expect(spoke.sessionToken(S1)).toEqual({ token: SESSION_TOKEN, url: "https://hub.internal" })
    const expired = await call(socket, { op: "sessionTokens", tokens: [{ sessionID: S1, token: "hst1.old", exp: 900 }] })
    expect(expired.result).toEqual({ applied: [], skipped: [{ sessionID: S1, reason: "expired" }] })
    expect(spoke.sessionToken(S1)?.token).toBe(SESSION_TOKEN)
    now = 6000
    expect(spoke.sessionToken(S1)).toBeUndefined()
  })

  test("act tokens are kept apart from session tokens", async () => {
    const { spoke, socket } = connected({ now: () => 1000 })
    spoke.upsertSession(info(S1))
    spoke.upsertSession(info(S2))
    await call(socket, { op: "actTokens", tokens: [{ sessionID: S1, token: ACT_TOKEN, exp: 5000 }] })
    expect(spoke.actToken(S1)).toEqual({ token: ACT_TOKEN, url: "https://hub.example" })
    expect(spoke.sessionToken(S1)).toBeUndefined()
    await call(socket, { op: "sessionTokens", tokens: [{ sessionID: S2, token: SESSION_TOKEN, exp: 5000 }] })
    expect(spoke.actToken(S2)).toBeUndefined()
    expect(spoke.sessionToken(S2)?.token).toBe(SESSION_TOKEN)
  })

  test("an ended session's tokens are dropped", async () => {
    const { spoke, socket } = connected({ now: () => 1000 })
    spoke.upsertSession(info(S1))
    await call(socket, { op: "sessionTokens", tokens: [{ sessionID: S1, token: SESSION_TOKEN, exp: 5000 }] })
    await call(socket, { op: "actTokens", tokens: [{ sessionID: S1, token: ACT_TOKEN, exp: 5000 }] })
    spoke.endSession(S1)
    expect(spoke.sessionToken(S1)).toBeUndefined()
    expect(spoke.actToken(S1)).toBeUndefined()
  })

  test("no token ever appears in logs, serialised output, inspect output or the frames sent", async () => {
    const methods = ["log", "error", "warn", "info", "debug"] as const
    const spies = methods.map((m) => spyOn(console, m).mockImplementation(() => {}))
    try {
      const { spoke, socket } = connected({ now: () => 1000, handlers: { stop: async () => Promise.reject(new Error("boom")) } })
      spoke.upsertSession(info(S1))
      await call(socket, { op: "sessionTokens", hubURL: "https://hub.internal", tokens: [{ sessionID: S1, token: SESSION_TOKEN, exp: 5000 }] })
      await call(socket, { op: "actTokens", tokens: [{ sessionID: S1, token: ACT_TOKEN, exp: 5000 }] })
      await call(socket, { op: "stop", sessionID: S1 })
      await call(socket, { op: "sessionTokens", tokens: [{ sessionID: S2, token: SESSION_TOKEN, exp: 5000 }] })
      const outputs = [
        JSON.stringify(spoke),
        Bun.inspect(spoke),
        String(spoke),
        ...socket.raw,
        ...spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" "))),
      ]
      for (const out of outputs) {
        expect(out).not.toContain(SESSION_TOKEN)
        expect(out).not.toContain(ACT_TOKEN)
        expect(out).not.toContain(MACHINE)
      }
      expect(JSON.parse(JSON.stringify(spoke))).toMatchObject({ harness: "claude-code", sessions: 1 })
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

describe("deliver", () => {
  const req = (over: Partial<DeliverRequest> = {}): DeliverRequest => ({ op: "deliver", sessionID: S1, messageID: "msg_1", text: "[hub] hi", wake: true, meta: META, ...over })

  test("is announced only with a deliver handler", () => {
    const sockets = fakeSockets()
    const base = { server: "https://h", token: "t", harness: "x", harnessVersion: "1", evidence: "hooks", pluginVersion: "1", directory: "/", socket: sockets.factory } as const
    expect(new HarnessSpoke(base).features).not.toContain("deliver")
    expect(new HarnessSpoke({ ...base, deliver: async () => ({ result: { delivered: "queued" }, resumed: false }) }).features).toContain("deliver")
  })

  test("admits a message once: a retry with the same messageID gets the first result", async () => {
    const seen: DeliverRequest[] = []
    const { spoke, socket } = connected({
      deliver: async (r): Promise<Admission> => {
        seen.push(r)
        return { result: { delivered: "queued", inboxID: "in_1" }, resumed: true }
      },
    })
    spoke.upsertSession(info(S1))
    const [a, b] = await Promise.all([call(socket, req()), call(socket, req())])
    const c = await call(socket, req())
    for (const res of [a, b, c]) expect(res).toMatchObject({ ok: true, result: { delivered: "queued", inboxID: "in_1" } })
    expect(seen).toHaveLength(1)
    await call(socket, req({ messageID: "msg_2" }))
    expect(seen).toHaveLength(2)
  })

  test("a wake retry of a message admitted without waking is admitted again", async () => {
    const seen: boolean[] = []
    const { spoke } = connected({
      deliver: async (r) => {
        seen.push(r.wake)
        return { result: { delivered: r.wake ? "turn" : "queued" }, resumed: r.wake }
      },
    })
    spoke.upsertSession(info(S1))
    expect(await spoke.dispatch(req({ wake: false }))).toEqual({ delivered: "queued" })
    expect(await spoke.dispatch(req({ wake: false }))).toEqual({ delivered: "queued" })
    expect(await spoke.dispatch(req({ wake: true }))).toEqual({ delivered: "turn" })
    expect(await spoke.dispatch(req({ wake: true }))).toEqual({ delivered: "turn" })
    expect(seen).toEqual([false, true])
  })

  test("a failed admission is not remembered", async () => {
    let calls = 0
    const { spoke } = connected({
      deliver: async () => {
        if (++calls === 1) throw new Error("harness busy")
        return { result: { delivered: "queued" }, resumed: true }
      },
    })
    spoke.upsertSession(info(S1))
    await expect(spoke.dispatch(req())).rejects.toThrow("harness busy")
    expect(await spoke.dispatch(req())).toEqual({ delivered: "queued" })
    expect(calls).toBe(2)
  })

  test("refuses a prompt without hubPrompt, and a session it does not report", async () => {
    const deliver = async (): Promise<Admission> => ({ result: { delivered: "queued" }, resumed: true })
    const { spoke } = connected({ deliver })
    spoke.upsertSession(info(S1))
    await expect(spoke.dispatch(req({ meta: { kind: "prompt", from: "@a", to: "@b", grant: "grt_1" } }))).rejects.toThrow(/"hubPrompt"/)
    await expect(spoke.dispatch(req({ sessionID: S2 }))).rejects.toThrow(S2)
    const prompts = connected({ deliver, features: ["hubPrompt"] }).spoke
    prompts.upsertSession(info(S1))
    expect(await prompts.dispatch(req({ meta: { kind: "prompt", from: "@a", to: "@b", grant: "grt_1" } }))).toEqual({ delivered: "queued" })
  })
})
