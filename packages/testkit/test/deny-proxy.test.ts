import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { denyProxy, until, type DenyProxy } from "../src/index.ts"

let proxies: DenyProxy[] = []
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.stop()
})
const start = async () => {
  const p = await denyProxy()
  proxies.push(p)
  return p
}

/** Sends raw bytes to the proxy and returns everything it answers before closing. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request))
    let out = ""
    socket.on("data", (d) => (out += d.toString("utf8")))
    socket.on("close", () => resolve(out))
    socket.on("error", reject)
  })
}

describe("denyProxy", () => {
  test("refuses CONNECT with 403 and records the host and port", async () => {
    const proxy = await start()
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`)
    const answer = await raw(proxy.port, "CONNECT downloads.claude.ai:443 HTTP/1.1\r\nHost: downloads.claude.ai:443\r\n\r\n")
    expect(answer.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true)
    expect(proxy.attempts).toEqual([{ method: "CONNECT", target: "downloads.claude.ai:443", host: "downloads.claude.ai", port: 443, at: expect.any(Number) }])
    expect(proxy.hosts()).toEqual(["downloads.claude.ai"])
  })

  test("refuses plain HTTP proxy requests and records the host", async () => {
    const proxy = await start()
    const res = await fetch("http://chatgpt.com/backend-api/x", { proxy: proxy.url } as any)
    expect(res.status).toBe(403)
    expect(proxy.attempts[0]).toMatchObject({ method: "GET", host: "chatgpt.com", port: 80 })
    expect(proxy.attempts[0]!.target).toMatch(/^http:\/\/chatgpt\.com(:80)?\/backend-api\/x$/)
  })

  test("an HTTPS fetch through it fails without reaching the host", async () => {
    const proxy = await start()
    // Bun surfaces the refused CONNECT as the proxy's 403; other clients throw. Either way nothing reached github.com.
    const status = await fetch("https://github.com/", { proxy: proxy.url } as any).then((r) => r.status, () => "rejected")
    expect([403, "rejected"]).toContain(status)
    await until(() => proxy.attempts.length > 0)
    expect(proxy.attempts[0]).toMatchObject({ method: "CONNECT", host: "github.com", port: 443 })
  })

  test("hosts() lists each host once, in first-seen order", async () => {
    const proxy = await start()
    for (const target of ["api.github.com:443", "chatgpt.com:443", "api.github.com:443"]) await raw(proxy.port, `CONNECT ${target} HTTP/1.1\r\n\r\n`)
    expect(proxy.hosts()).toEqual(["api.github.com", "chatgpt.com"])
    expect(proxy.attempts.length).toBe(3)
  })

  test("closes on garbage and records it", async () => {
    const proxy = await start()
    const answer = await raw(proxy.port, "\x16\x03\x01garbage\r\n\r\n")
    expect(answer.startsWith("HTTP/1.1 400")).toBe(true)
    expect(proxy.attempts[0]).toMatchObject({ method: "", host: "" })
  })

  test("env() points every proxy variable at it and exempts loopback", async () => {
    const proxy = await start()
    expect(proxy.env()).toEqual({
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      ALL_PROXY: proxy.url,
      https_proxy: proxy.url,
      http_proxy: proxy.url,
      all_proxy: proxy.url,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    })
  })

  test("stop() closes the listener", async () => {
    const proxy = await denyProxy()
    await proxy.stop()
    await expect(raw(proxy.port, "CONNECT x:443 HTTP/1.1\r\n\r\n")).rejects.toThrow()
  })
})
