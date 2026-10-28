// The SDK's transport against an in-process fake hub (Bun.serve): bearer requests, query strings, JSON bodies, and the
// {error: {code, message, hint?, ...}} envelope turned into typed errors.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, HubError, HubTransportError, isHubError } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const TOKEN = "hst1.secret-session-token"
const client = (url = hub.url) => new HubClient({ url, token: TOKEN })

/** The rejection of a promise (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

describe("requests", () => {
  test("pin and previewed inactive archive use narrow agent routes", async () => {
    hub.routes["PUT /api/agent/sessions/@api/pin"] = () => Response.json({ sessionID: "ses_1", pinned: true, changed: true })
    hub.routes["POST /api/agent/sessions/archive-inactive"] = () => Response.json((hub.seen.at(-1)?.body as any)?.preview ? { candidates: ["ses_1"], previewToken: "hai1_x", expiresAt: 2 } : { changed: ["ses_1"], skipped: [] })
    expect(await client().setPinned("@api", true)).toMatchObject({ pinned: true, changed: true })
    expect(await client().previewArchiveInactive("7d", 10)).toMatchObject({ previewToken: "hai1_x" })
    expect(await client().archiveInactive("hai1_x")).toEqual({ changed: ["ses_1"], skipped: [] })
  })
  test("webhook management uses the durable agent API and delete accepts 204", async () => {
    const webhook = { id: "wh_1", url: "https://hooks.example/x", events: ["message.*"], by: "app:tok", created: 1 }
    hub.routes["POST /api/agent/webhooks"] = () => Response.json({ webhook, secret: "whsec_once" }, { status: 201 })
    hub.routes["GET /api/agent/webhooks"] = () => Response.json({ webhooks: [webhook] })
    hub.routes["GET /api/agent/webhooks/wh_1"] = () => Response.json({ webhook, deliveries: [] })
    hub.routes["DELETE /api/agent/webhooks/wh_1"] = () => new Response(null, { status: 204 })
    expect((await client().webhookCreate({ url: webhook.url, events: webhook.events })).secret).toBe("whsec_once")
    expect((await client().webhooks()).webhooks).toEqual([webhook])
    expect((await client().webhook("wh_1")).webhook).toEqual(webhook)
    expect(await client().webhookDelete("wh_1")).toBeUndefined()
  })
  test("archive state uses the tenant-addressed PUT contract", async () => {
    hub.routes["PUT /api/agent/sessions/@api/archive"] = () => Response.json({ sessionID: "ses_1", archived: true, changed: true })
    expect(await client().setArchived("@api", true)).toEqual({ sessionID: "ses_1", archived: true, changed: true })
    expect(hub.seen[0]!.body).toEqual({ archived: true })
  })

  test("GET by default with the bearer token and accept JSON; a trailing slash on the URL is dropped", async () => {
    hub.routes["GET /api/agent/whoami"] = () => Response.json({ ok: 1 })
    const answer = await client(`${hub.url}//`).call("GET", "/api/agent/whoami")
    expect(answer).toEqual({ ok: 1 })
    const [seen] = hub.seen
    expect(seen!.method).toBe("GET")
    expect(seen!.path).toBe("/api/agent/whoami")
    expect(seen!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen!.headers.accept).toBe("application/json")
    expect(seen!.headers["content-type"]).toBeUndefined()
  })

  test("a body is sent as JSON", async () => {
    hub.routes["POST /api/agent/name"] = () => Response.json({ sessionID: "ses_1", name: "api" })
    await client().call("POST", "/api/agent/name", { body: { name: "@api" } })
    expect(hub.seen[0]!.headers["content-type"]).toBe("application/json")
    expect(hub.seen[0]!.body).toEqual({ name: "@api" })
  })

  test("query: unset values are skipped, arrays repeat the key, nothing set means no '?'", async () => {
    hub.routes["GET /api/agent/sessions"] = () => Response.json({ sessions: [] })
    await client().call("GET", "/api/agent/sessions", { query: { project: "hub", state: undefined, label: ["a=1", "b=2"] } })
    await client().call("GET", "/api/agent/sessions", { query: { project: undefined } })
    expect(hub.seen.map((s) => s.path)).toEqual(["/api/agent/sessions?project=hub&label=a%3D1&label=b%3D2", "/api/agent/sessions"])
  })

  test("204 answers undefined", async () => {
    hub.routes["DELETE /api/agent/app-tokens/t1"] = () => new Response(null, { status: 204 })
    expect(await client().call("DELETE", "/api/agent/app-tokens/t1")).toBeUndefined()
  })

  test("request() resolves the raw response when OK", async () => {
    hub.routes["GET /api/agent/status"] = () => new Response("raw", { status: 200 })
    const response = await client().request("GET", "/api/agent/status")
    expect(await response.text()).toBe("raw")
  })

  test("a fetch given in the options is used", async () => {
    const calls: string[] = []
    const custom = async (input: string) => {
      calls.push(input)
      return Response.json({ via: "custom" })
    }
    const answer = await new HubClient({ url: "http://hub.invalid", token: TOKEN, fetch: custom }).call("GET", "/api/agent/whoami")
    expect(answer).toEqual({ via: "custom" })
    expect(calls).toEqual(["http://hub.invalid/api/agent/whoami"])
  })
})

describe("errors", () => {
  test("the envelope becomes a HubError with code, message, hint, status and the extra fields", async () => {
    const candidates = [{ sessionID: "ses_1" }, { sessionID: "ses_2" }]
    hub.routes["GET /api/agent/sessions/@api"] = () => Response.json({ error: { code: "ambiguous", message: "2 sessions match", hint: "use an ID", candidates } }, { status: 409 })
    const error = await rejection(client().call("GET", "/api/agent/sessions/@api"))
    expect(error).toBeInstanceOf(HubError)
    const hubError = error as HubError
    expect(hubError.code).toBe("ambiguous")
    expect(hubError.message).toBe("2 sessions match")
    expect(hubError.hint).toBe("use an ID")
    expect(hubError.status).toBe(409)
    expect(hubError.envelope).toEqual({ code: "ambiguous", message: "2 sessions match", hint: "use an ID", candidates })
    expect(isHubError(error)).toBe(true)
    expect(isHubError(error, "ambiguous", "not_found")).toBe(true)
    expect(isHubError(error, "gone")).toBe(false)
    expect(isHubError(new Error("x"))).toBe(false)
  })

  test("retryAfter is read from the envelope", async () => {
    hub.routes["POST /api/agent/name"] = () => Response.json({ error: { code: "rate_limited", message: "slow down", retryAfter: 12.5 } }, { status: 429 })
    const error = (await rejection(client().call("POST", "/api/agent/name", { body: {} }))) as HubError
    expect(error.retryAfter).toBe(12.5)
    expect(error.hint).toBeUndefined()
  })

  test("a failure without the envelope is an http HubTransportError naming the status and path", async () => {
    hub.routes["GET /api/agent/status"] = () => new Response("<html>bad gateway</html>", { status: 502 })
    const error = (await rejection(client().call("GET", "/api/agent/status", { query: { x: "1" } }))) as HubTransportError
    expect(error).toBeInstanceOf(HubTransportError)
    expect(error.kind).toBe("http")
    expect(error.status).toBe(502)
    expect(error.message).toBe(`HTTP 502 from ${hub.url}/api/agent/status?x=1`)
    expect(isHubError(error)).toBe(false)
  })

  test("redirects are not followed", async () => {
    hub.routes["GET /api/agent/whoami"] = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } })
    const error = (await rejection(client().call("GET", "/api/agent/whoami"))) as HubTransportError
    expect(error.kind).toBe("http")
    expect(error.status).toBe(302)
  })

  test("an unreachable hub is an unreachable HubTransportError; the token is never in the message", async () => {
    const dead = fakeHub()
    dead.stop()
    const error = (await rejection(client(dead.url).call("GET", "/api/agent/whoami"))) as HubTransportError
    expect(error).toBeInstanceOf(HubTransportError)
    expect(error.kind).toBe("unreachable")
    expect(error.message).toStartWith(`cannot reach ${dead.url} (`)
    expect(error.message).not.toContain(TOKEN)
  })

  test("an OK answer that is not JSON is a bad_response HubTransportError", async () => {
    hub.routes["GET /api/agent/whoami"] = () => new Response("not json", { status: 200 })
    const error = (await rejection(client().call("GET", "/api/agent/whoami"))) as HubTransportError
    expect(error.kind).toBe("bad_response")
    expect(error.message).toBe(`the hub at ${hub.url} did not answer JSON for /api/agent/whoami`)
  })

  test("an abort rejects with the abort itself, not a HubTransportError", async () => {
    let release = () => {}
    hub.routes["GET /api/agent/whoami"] = () => new Promise<Response>((resolve) => (release = () => resolve(Response.json({}))))
    const controller = new AbortController()
    const pending = client().call("GET", "/api/agent/whoami", { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const error = await rejection(pending)
    release()
    expect(error).not.toBeInstanceOf(HubTransportError)
    expect((error as Error).name).toBe("AbortError")
  })
})
