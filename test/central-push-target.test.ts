import { afterEach, describe, expect, test } from "bun:test"
import { isPrivateAddress, publicFetch, PublicURLError, publicURLProblem, pushEndpointProblem } from "../src/central/push-target"

const resolver = (table: Record<string, string[] | Error>) => async (host: string) => {
  const entry = table[host]
  if (entry instanceof Error) throw entry
  if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
  return entry
}

describe("isPrivateAddress", () => {
  test("loopback, private, link-local, CGNAT, unspecified, multicast and ULA addresses", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe",
    ]) expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true })
  })

  test("public addresses", () => {
    for (const ip of ["142.250.80.10", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2607:f8b0:4004:c1b::5f", "2a00:1450::1", "::ffff:8.8.8.8"]) {
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: false })
    }
  })
})

describe("pushEndpointProblem", () => {
  const publicDNS = resolver({
    "fcm.googleapis.com": ["142.250.80.10", "2607:f8b0:4004:c1b::5f"],
    "updates.push.services.mozilla.com": ["34.117.65.55"],
    "web.push.apple.com": ["17.188.128.1"],
    "wns2-by3p.notify.windows.com": ["20.42.65.92"],
    "rebind.example.com": ["93.184.215.14", "10.0.0.5"],
    "inside.example.com": ["::1"],
  })

  test("real push services are accepted", async () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QH4n",
      "https://wns2-by3p.notify.windows.com/w/?token=x",
    ]) expect(await pushEndpointProblem(endpoint, publicDNS)).toBeUndefined()
  })

  test("non-https, private IP literals and local names are rejected without a lookup", async () => {
    const lookups: string[] = []
    const spy = async (host: string) => {
      lookups.push(host)
      return ["142.250.80.10"]
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://10.0.0.1/x",
      "https://192.168.0.10:8443/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.100.100/x",
      "https://0x7f000001/x",
      "https://localhost/x",
      "https://api.localhost/x",
      "https://printer.local/x",
      "https://metadata.google.internal/x",
      "https://intranet/x",
      "https://user:pass@fcm.googleapis.com/x",
      "not a url",
    ]) expect({ endpoint, problem: await pushEndpointProblem(endpoint, spy) }).toEqual({ endpoint, problem: expect.any(String) })
    expect(lookups).toEqual([])
  })

  test("a public IP literal is accepted without a lookup", async () => {
    expect(await pushEndpointProblem("https://142.250.80.10/x", resolver({}))).toBeUndefined()
  })

  test("a hostname resolving to any private address, or failing to resolve, is rejected", async () => {
    expect(await pushEndpointProblem("https://rebind.example.com/x", publicDNS)).toMatch(/private|local/i)
    expect(await pushEndpointProblem("https://inside.example.com/x", publicDNS)).toMatch(/private|local/i)
    expect(await pushEndpointProblem("https://nxdomain.example.com/x", publicDNS)).toMatch(/resolve/i)
    expect(await pushEndpointProblem("https://empty.example.com/x", resolver({ "empty.example.com": [] }))).toMatch(/resolve/i)
  })
})

describe("publicURLProblem (generic, P4-T10)", () => {
  const publicDNS = resolver({ "hooks.example.com": ["93.184.215.14"], "inside.example.com": ["10.0.0.5"] })

  test("labels its problems; push wording is unchanged", async () => {
    expect(await publicURLProblem("http://hooks.example.com/x", { resolve: publicDNS, label: "Webhook URL" })).toBe("Webhook URL must be https")
    expect(await publicURLProblem("nope", { resolve: publicDNS, label: "Webhook URL" })).toBe("Webhook URL is not a URL")
    expect(await pushEndpointProblem("http://fcm.googleapis.com/x", publicDNS)).toBe("Push endpoint must be https")
    expect(await publicURLProblem("https://hooks.example.com/x", { resolve: publicDNS })).toBeUndefined()
    expect(await publicURLProblem("https://inside.example.com/x", { resolve: publicDNS })).toMatch(/private or local/)
  })

  test("allowPrivate admits http, loopback, private and local names without a lookup; never other schemes or credentials", async () => {
    const lookups: string[] = []
    const spy = async (host: string) => (lookups.push(host), ["10.0.0.5"])
    for (const url of ["http://127.0.0.1:8080/hook", "https://10.0.0.1/x", "http://printer.local/x", "http://intranet/x", "https://inside.example.com/x"]) {
      expect({ url, problem: await publicURLProblem(url, { resolve: spy, allowPrivate: true }) }).toEqual({ url, problem: undefined })
    }
    expect(lookups).toEqual([])
    expect(await publicURLProblem("ftp://127.0.0.1/x", { resolve: spy, allowPrivate: true })).toMatch(/http/)
    expect(await publicURLProblem("http://u:p@127.0.0.1/x", { resolve: spy, allowPrivate: true })).toMatch(/credentials/)
  })
})

describe("publicFetch (send-time SSRF checks, P4-T10)", () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => void server?.stop(true))
  const serve = (handler: (request: Request) => Response | Promise<Response>) => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
    return `http://127.0.0.1:${server.port}`
  }
  const local = { resolve: resolver({}), allowPrivate: true, timeoutMs: 2000, maxBytes: 1024 }

  test("posts and returns the status and the body", async () => {
    const seen: string[] = []
    const base = serve(async (request) => (seen.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`), new Response("ok", { status: 202 })))
    expect(await publicFetch(`${base}/hook`, { method: "POST", body: "hi" }, local)).toEqual({ status: 202, body: "ok", truncated: false })
    expect(seen).toEqual(["POST /hook hi"])
  })

  test("never follows a redirect", async () => {
    let followed = false
    const base = serve((request) => (new URL(request.url).pathname === "/elsewhere" ? ((followed = true), new Response("x")) : Response.redirect("/elsewhere", 302)))
    const result = await publicFetch(`${base}/hook`, { method: "POST", body: "" }, local)
    expect(result.status).toBe(302)
    expect(followed).toBe(false)
  })

  test("caps the response body it reads", async () => {
    const base = serve(() => new Response("x".repeat(100_000)))
    const result = await publicFetch(`${base}/`, { method: "POST", body: "" }, { ...local, maxBytes: 10 })
    expect(result).toEqual({ status: 200, body: "x".repeat(10), truncated: true })
  })

  test("times out a slow receiver", async () => {
    const base = serve(async () => (await Bun.sleep(1000), new Response("late")))
    await expect(publicFetch(`${base}/`, { method: "POST", body: "" }, { ...local, timeoutMs: 50 })).rejects.toThrow(/timed out/i)
  })

  test("re-resolves the host on every send and refuses before connecting", async () => {
    const table: Record<string, string[]> = { "hooks.example.com": ["93.184.215.14"] }
    let lookups = 0
    const resolve = async (host: string) => (lookups++, table[host] ?? [])
    const calls: string[] = []
    const fakeFetch = (async (url: string) => (calls.push(String(url)), new Response("ok"))) as unknown as typeof fetch
    const options = { resolve, timeoutMs: 1000, maxBytes: 1024, fetch: fakeFetch, label: "Webhook URL" }
    expect((await publicFetch("https://hooks.example.com/x", { method: "POST", body: "" }, options)).status).toBe(200)
    table["hooks.example.com"] = ["127.0.0.1"] // DNS rebinding after registration
    const blocked = publicFetch("https://hooks.example.com/x", { method: "POST", body: "" }, options)
    await expect(blocked).rejects.toBeInstanceOf(PublicURLError)
    await expect(blocked).rejects.toThrow(/Webhook URL resolves to a private or local address/)
    expect(lookups).toBe(2)
    expect(calls).toEqual(["https://hooks.example.com/x"])
  })
})
