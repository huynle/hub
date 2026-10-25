// Session tokens end to end (P1-T5): the hub pushes tokens to spokes that announce "sessionTokens", the tokens
// authenticate /api/agent as the session (never console routes), and they stop working when the session goes,
// the machine is revoked, the user is disabled, or they expire. Real server, fake spokes, fake clock.
import { afterEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import path from "node:path"
import { harness, session, spoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"

const DAY = 24 * 60 * 60 * 1000
let h: Harness
let clock: number
afterEach(async () => {
  await h?.stop()
})

const start = () => {
  clock = 1_800_000_000_000
  h = harness({ now: () => clock })
}
const bearer = (pathname: string, token: string, init: RequestInit = {}) =>
  h.api(pathname, { ...init, cookie: null, origin: null, headers: { authorization: `Bearer ${token}` } })

type Client = FakeSpoke & { token: string }
/** Answers sessionTokens requests (applying all) and records them; other requests get {}. */
function answer(client: Client) {
  const requests: any[] = []
  client.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t !== "req") return
    requests.push(frame.req)
    const result = frame.req.op === "sessionTokens" ? { applied: frame.req.tokens.map((t: any) => t.sessionID), skipped: [] } : {}
    client.send({ t: "res", id: frame.id, ok: true, result })
  })
  return requests
}
/** A spoke that announces sessionTokens, connected and reporting `sessions`. */
async function tokenSpoke(sessions: string[], options: { machine?: { token: string }; processID?: string; features?: string[] } = {}) {
  const client = await spoke(h, {
    ...(options.machine ? { machine: options.machine } : {}),
    processID: options.processID ?? "p1",
    hello: { harness: "opencode", harnessVersion: "2.0.0", features: options.features ?? ["sessionTokens"] },
  })
  const requests = answer(client)
  if (sessions.length) client.send({ t: "sessions", sessions: sessions.map((id) => session(id, id.includes("child") ? { parentID: sessions[0] } : {})) })
  return { client, requests }
}
const tokensOf = (requests: any[]) => new Map<string, string>(requests.filter((r) => r.op === "sessionTokens").flatMap((r) => r.tokens.map((t: any) => [t.sessionID, t.token])))
const machineOf = (client: Client) => h.store.findMachine(client.token)!.id

describe("push", () => {
  test("a spoke announcing sessionTokens gets a token for each session, subagents included, with the hub URL", async () => {
    start()
    const { requests } = await tokenSpoke(["ses_1", "ses_child"])
    await waitFor(() => tokensOf(requests).size === 2)
    const req = requests.find((r) => r.op === "sessionTokens")
    expect(req.hubURL).toBe("http://voice.test")
    for (const t of req.tokens) {
      expect(t.token).toMatch(/^hst1\./)
      expect(t.exp).toBe(clock + DAY)
    }
  })

  test("an older spoke without the feature gets no tokens", async () => {
    start()
    const client = await spoke(h, { sessions: [session("ses_1")] })
    const requests = answer(client)
    client.send({ t: "sessions", sessions: [session("ses_1"), session("ses_2")] })
    await waitFor(() => h.registry.hasSession("ses_2"))
    await Bun.sleep(50)
    expect(requests.filter((r) => r.op === "sessionTokens")).toEqual([])
  })

  test("the same snapshot again sends nothing; a reconnect gets every token again", async () => {
    start()
    const machine = h.store.addMachine("laptop")
    const first = await tokenSpoke(["ses_1"], { machine })
    await waitFor(() => tokensOf(first.requests).size === 1)
    first.client.send({ t: "sessions", sessions: [session("ses_1")] })
    await Bun.sleep(50)
    expect(first.requests.filter((r) => r.op === "sessionTokens")).toHaveLength(1)
    first.client.close()
    await first.client.closed
    await waitFor(() => h.registry.connections() === 0)
    const second = await tokenSpoke(["ses_1"], { machine })
    await waitFor(() => tokensOf(second.requests).size === 1)
  })

  test("no token for a session another user's process owns", async () => {
    start()
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const bobs = await tokenSpoke(["ses_shared"], { machine: h.store.addMachine("bob laptop", bob.id), processID: "pb" })
    await waitFor(() => tokensOf(bobs.requests).size === 1)
    const mine = await tokenSpoke(["ses_shared", "ses_mine"], { processID: "pm" })
    await waitFor(() => tokensOf(mine.requests).size >= 1)
    await Bun.sleep(50)
    expect([...tokensOf(mine.requests).keys()]).toEqual(["ses_mine"])
  })

  test("the signing keys live in token-keys.json (0600) in the state dir", async () => {
    start()
    const { requests } = await tokenSpoke(["ses_1"])
    await waitFor(() => tokensOf(requests).size === 1)
    expect(statSync(path.join(h.stateDir, "token-keys.json")).mode & 0o777).toBe(0o600)
  })
})

describe("verify over HTTP", () => {
  async function minted() {
    const { client, requests } = await tokenSpoke(["ses_1", "ses_child"])
    await waitFor(() => tokensOf(requests).size === 2)
    return { client, token: tokensOf(requests).get("ses_1")!, child: tokensOf(requests).get("ses_child")!, machineID: machineOf(client) }
  }

  test("whoami answers the session actor, for subagents too", async () => {
    start()
    const { token, child, machineID } = await minted()
    const res = await bearer("/api/agent/whoami", token)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).actor).toEqual({ kind: "session", userID: "local", machineID, sessionID: "ses_1", via: "shell" })
    expect(((await (await bearer("/api/agent/whoami", child)).json()) as any).actor.sessionID).toBe("ses_child")
  })

  test("refused on console routes (403)", async () => {
    start()
    const { token } = await minted()
    for (const pathname of ["/api/me", "/api/sessions"]) {
      const res = await bearer(pathname, token)
      expect(res.status).toBe(403)
    }
  })

  test("expired: 401 token_expired", async () => {
    start()
    const { token } = await minted()
    clock += DAY
    const res = await bearer("/api/agent/whoami", token)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe("token_expired")
  })

  test("tampered: 401 unauthorized", async () => {
    start()
    const { token } = await minted()
    const res = await bearer("/api/agent/whoami", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe("unauthorized")
  })

  test("a session the machine no longer reports: 401", async () => {
    start()
    const { client, token, child } = await minted()
    client.send({ t: "sessions", sessions: [session("ses_child")] })
    await waitFor(() => !h.registry.hasSession("ses_1"))
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
    expect((await bearer("/api/agent/whoami", child)).status).toBe(200)
  })

  test("the spoke disconnecting ends its tokens: 401", async () => {
    start()
    const { client, token } = await minted()
    client.close()
    await waitFor(() => h.registry.connections() === 0)
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
  })

  test("revoking the machine bumps its epoch and ends its tokens", async () => {
    start()
    const { token, machineID } = await minted()
    const before = h.store.machineEpoch(machineID)
    expect((await h.api(`/api/machines/${machineID}`, { method: "DELETE" })).status).toBe(204)
    expect(h.store.machineEpoch(machineID)).toBe(before + 1)
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
  })

  test("disabling the user bumps their epoch: their tokens stay dead after re-enabling", async () => {
    start()
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const { client, requests } = await tokenSpoke(["ses_b"], { machine: h.store.addMachine("bob laptop", bob.id) })
    await waitFor(() => tokensOf(requests).size === 1)
    const token = tokensOf(requests).get("ses_b")!
    expect((await bearer("/api/agent/whoami", token)).status).toBe(200)
    const before = h.store.userEpoch(bob.id)
    expect((await h.api(`/api/admin/users/${bob.id}`, { method: "PUT", json: { disabled: true } })).status).toBe(200)
    expect(h.store.userEpoch(bob.id)).toBe(before + 1)
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
    await client.closed
    expect((await h.api(`/api/admin/users/${bob.id}`, { method: "PUT", json: { disabled: false } })).status).toBe(200)
    expect((await bearer("/api/agent/whoami", token)).status).toBe(401)
  })

  test("a role change alone does not bump the user epoch", async () => {
    start()
    const bob = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const before = h.store.userEpoch(bob.id)
    expect((await h.api(`/api/admin/users/${bob.id}`, { method: "PUT", json: { role: "admin" } })).status).toBe(200)
    expect(h.store.userEpoch(bob.id)).toBe(before)
  })
})
