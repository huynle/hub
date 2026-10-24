// The credential resolver (src/central/agent/actor.ts): one place that turns a request's cookie or bearer
// token into an AgentActor. Cookie and device token resolve through the device lookup; session and app
// tokens through pluggable verifiers (P1-T5, P1-T7).
import { describe, expect, test } from "bun:test"
import { agentAllows, createResolver, readCredentials, type BearerVerifier } from "../src/central/agent/actor"
import type { DeviceRecord, UserRecord } from "../src/central/store"

const alice: UserRecord = { id: "usr_alice", email: "alice@example.com", role: "user", created: 1 } as UserRecord
const carol: UserRecord = { id: "usr_carol", role: "user", created: 1, disabled: true } as UserRecord
const phone: DeviceRecord = { id: "dev_phone", name: "phone", tokenHash: "h", created: 1, lastSeen: 1, ownerID: alice.id }
const carolPhone: DeviceRecord = { ...phone, id: "dev_carol", ownerID: carol.id }
const users = new Map([alice, carol].map((u) => [u.id, u]))
const devices = new Map([
  ["tok_alice", phone],
  ["tok_carol", carolPhone],
])

const sessionVerifier: BearerVerifier = {
  kind: "session",
  verify: (token) =>
    token === "hst_good"
      ? { kind: "session", userID: alice.id, machineID: "mch_1", sessionID: "ses_1" }
      : token === "hst_old"
        ? "expired"
        : token === "hst_carol"
          ? { kind: "session", userID: carol.id, machineID: "mch_1", sessionID: "ses_2" }
          : undefined,
}
const appVerifier: BearerVerifier = {
  kind: "app",
  verify: async (token) => (token === "hat_good" ? { kind: "app", userID: alice.id, tokenID: "tok_1", scopes: ["sessions:read"] } : undefined),
}

const resolver = (verifiers: BearerVerifier[] = [sessionVerifier, appVerifier]) =>
  createResolver({ cookieName: "voice_device", findDevice: (t) => devices.get(t), user: (id) => users.get(id), verifiers })

const req = (headers: Record<string, string>) => new Request("http://hub.test/api/x", { headers })

describe("readCredentials", () => {
  test("finds the device cookie among other cookies and a Bearer token (case-insensitive scheme)", () => {
    expect(readCredentials(req({ cookie: "a=1; voice_device=tok_alice; b=2" }), "voice_device")).toEqual({ cookie: "tok_alice" })
    expect(readCredentials(req({ authorization: "bearer   tok_alice" }), "voice_device")).toEqual({ bearer: "tok_alice" })
    expect(readCredentials(req({ cookie: "other=1" }), "voice_device")).toEqual({})
  })

  test("other Authorization schemes (e.g. an auth proxy's Basic) are not credentials; an empty Bearer is", () => {
    expect(readCredentials(req({ authorization: "Basic dXNlcjpwYXNz" }), "voice_device")).toEqual({})
    expect(readCredentials(req({ authorization: "Bearer" }), "voice_device")).toEqual({ bearer: "" })
    expect(readCredentials(req({ authorization: "Bearer two tokens" }), "voice_device")).toEqual({ bearer: "" })
  })
})

describe("createResolver", () => {
  test("cookie → user actor via cookie", async () => {
    expect(await resolver()(req({ cookie: "voice_device=tok_alice" }))).toEqual({
      ok: true,
      credential: "cookie",
      actor: { kind: "user", userID: alice.id, deviceID: phone.id, via: "cookie" },
      user: alice,
      device: phone,
    })
  })

  test("device token (bearer form of the cookie) → the same user actor via device-token", async () => {
    expect(await resolver()(req({ authorization: "Bearer tok_alice" }))).toEqual({
      ok: true,
      credential: "device-token",
      actor: { kind: "user", userID: alice.id, deviceID: phone.id, via: "device-token" },
      user: alice,
      device: phone,
    })
  })

  test("session and app tokens resolve through their verifiers", async () => {
    const session = await resolver()(req({ authorization: "Bearer hst_good" }))
    expect(session).toMatchObject({ ok: true, credential: "session-token", actor: { kind: "session", sessionID: "ses_1" }, user: alice })
    expect((session as any).device).toBeUndefined()
    const app = await resolver()(req({ authorization: "Bearer hat_good" }))
    expect(app).toMatchObject({ ok: true, credential: "app-token", actor: { kind: "app", tokenID: "tok_1", scopes: ["sessions:read"] } })
  })

  test("without verifiers (this phase's default) session and app tokens are unknown bearers", async () => {
    expect(await resolver([])(req({ authorization: "Bearer hst_good" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
  })

  test("a verifier answering for another kind is ignored", async () => {
    const liar: BearerVerifier = { kind: "app", verify: () => ({ kind: "user", userID: alice.id, deviceID: "dev_x", via: "cookie" }) as any }
    expect(await resolver([liar])(req({ authorization: "Bearer anything" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
  })

  test("no credential, unknown cookie, unknown bearer, expired token", async () => {
    expect(await resolver()(req({}))).toEqual({ ok: false, reason: "none", bearer: false })
    expect(await resolver()(req({ cookie: "voice_device=nope" }))).toEqual({ ok: false, reason: "invalid", bearer: false })
    expect(await resolver()(req({ authorization: "Bearer nope" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
    expect(await resolver()(req({ authorization: "Bearer" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
    expect(await resolver()(req({ authorization: "Bearer hst_old" }))).toEqual({ ok: false, reason: "expired", bearer: true })
  })

  test("cookie and bearer together are refused, even when both are valid", async () => {
    expect(await resolver()(req({ cookie: "voice_device=tok_alice", authorization: "Bearer tok_alice" }))).toEqual({ ok: false, reason: "mixed", bearer: true })
  })

  test("a disabled user's device and tokens resolve to nothing", async () => {
    expect(await resolver()(req({ cookie: "voice_device=tok_carol" }))).toEqual({ ok: false, reason: "invalid", bearer: false })
    expect(await resolver()(req({ authorization: "Bearer tok_carol" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
    expect(await resolver()(req({ authorization: "Bearer hst_carol" }))).toEqual({ ok: false, reason: "invalid", bearer: true })
  })
})

describe("agentAllows (route classes on /api/agent)", () => {
  const user = { kind: "user", userID: "u", deviceID: "d", via: "cookie" } as const
  const session = { kind: "session", userID: "u", machineID: "m", sessionID: "s" } as const
  const app = { kind: "app", userID: "u", tokenID: "t", scopes: ["sessions:read"] } as const

  test("user actors (cookie or device token) reach every agent route, including token management", () => {
    expect(agentAllows({}, user)).toBe(true)
    expect(agentAllows({ session: true, scope: "sessions:launch" }, user)).toBe(true)
  })

  test("session tokens only where the route allows sessions", () => {
    expect(agentAllows({}, session)).toBe(false)
    expect(agentAllows({ session: true }, session)).toBe(true)
  })

  test("app tokens only on routes with a scope the token holds", () => {
    expect(agentAllows({}, app)).toBe(false)
    expect(agentAllows({ session: true }, app)).toBe(false)
    expect(agentAllows({ scope: "sessions:launch" }, app)).toBe(false)
    expect(agentAllows({ scope: "sessions:read" }, app)).toBe(true)
  })
})
