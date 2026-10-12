import { afterEach, describe, expect, test } from "bun:test"
import type { EnrollPoll } from "../src/protocol"
import { pollEnrollment, startEnrollment } from "../src/spoke/enroll"

type Handler = (path: string, body: any) => Response | Promise<Response>
const servers: Array<{ stop: (force?: boolean) => void }> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function fake(handler: Handler) {
  const requests: Array<{ path: string; body: any }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      requests.push({ path: url.pathname, body })
      return handler(url.pathname, body)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

const START = { userCode: "ABCD-EFGH", deviceCode: "dev_1", approveURL: "https://voice.example/approve", intervalMs: 5, expiresAt: Date.now() + 60_000 }

describe("enrollment", () => {
  test("startEnrollment posts the machine name and returns the start payload", async () => {
    const srv = fake(() => Response.json(START))
    expect(await startEnrollment(srv.url, "laptop")).toEqual(START)
    expect(srv.requests).toEqual([{ path: "/spoke/enroll", body: { machineName: "laptop" } }])
  })

  test("startEnrollment rejects on HTTP errors and malformed replies", async () => {
    const bad = fake(() => new Response("nope", { status: 500 }))
    await expect(startEnrollment(bad.url, "laptop")).rejects.toThrow(/500/)
    const junk = fake(() => Response.json({ userCode: 1 }))
    await expect(startEnrollment(junk.url, "laptop")).rejects.toThrow(/invalid/i)
    await expect(startEnrollment("http://127.0.0.1:1", "laptop")).rejects.toThrow()
  })

  test("pollEnrollment polls until approved", async () => {
    const replies: EnrollPoll[] = [{ status: "pending" }, { status: "pending" }, { status: "approved", machineID: "m_1", machineToken: "tok" }]
    const srv = fake(() => Response.json(replies.shift()))
    const outcome = await pollEnrollment(srv.url, START)
    expect(outcome).toEqual({ status: "approved", machineID: "m_1", machineToken: "tok" })
    expect(srv.requests).toHaveLength(3)
    expect(srv.requests[0]).toEqual({ path: "/spoke/enroll/poll", body: { deviceCode: "dev_1" } })
  })

  test("pollEnrollment returns denied/expired from the server", async () => {
    const denied = fake(() => Response.json({ status: "denied" }))
    expect(await pollEnrollment(denied.url, START)).toEqual({ status: "denied" })
    const expired = fake(() => Response.json({ status: "expired" }))
    expect(await pollEnrollment(expired.url, START)).toEqual({ status: "expired" })
  })

  test("pollEnrollment keeps trying through transient errors and gives up after expiry", async () => {
    let calls = 0
    const srv = fake(() => (++calls < 3 ? new Response("down", { status: 502 }) : Response.json({ status: "approved", machineID: "m", machineToken: "t" })))
    expect((await pollEnrollment(srv.url, START)).status).toBe("approved")

    const pending = fake(() => Response.json({ status: "pending" }))
    const outcome = await pollEnrollment(pending.url, { ...START, expiresAt: Date.now() + 50 })
    expect(outcome).toEqual({ status: "expired" })
  })

  test("pollEnrollment stops when aborted", async () => {
    const srv = fake(() => Response.json({ status: "pending" }))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    expect(await pollEnrollment(srv.url, START, { signal: abort.signal })).toEqual({ status: "cancelled" })
  })
})
