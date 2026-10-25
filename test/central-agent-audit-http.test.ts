// GET /api/agent/audit through the hub (P3-T5): the user's own agent audit, users only (a session token cannot
// read it), in the hub's route table as access "agent".
import { afterEach, describe, expect, test } from "bun:test"
import type { BearerVerifier } from "../src/central/agent/actor"
import { harness, type Harness } from "./central-harness"

const SESSION_TOKEN = "hst_fake_session"
const verifiers: BearerVerifier[] = [
  { kind: "session", verify: (token) => (token === SESSION_TOKEN ? { kind: "session", userID: "local", machineID: "mch_x", sessionID: "ses_1" } : undefined) },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

describe("GET /api/agent/audit", () => {
  test("is an agent route", async () => {
    h = await harness({ agent: { verifiers } } as any)
    expect(h.routes).toContainEqual({ method: "GET", path: "/api/agent/audit", access: "agent" })
  })

  test("the signed-in user gets their (empty) log, not cached", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const res = await h.api("/api/agent/audit")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ entries: [] })
  })

  test("a session token is refused (403 forbidden)", async () => {
    h = await harness({ agent: { verifiers } } as any)
    const res = await h.api("/api/agent/audit", { cookie: null, origin: null, headers: { authorization: `Bearer ${SESSION_TOKEN}` } })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe("forbidden")
  })
})
