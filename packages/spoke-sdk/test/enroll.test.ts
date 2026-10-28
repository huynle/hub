// Device-code enrollment options used by `hubctl machine enroll`: a strict redirect policy and redeem-safe polling.
// The default behaviour (follow redirects, abort in-flight requests) is covered by test/spoke-enroll.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import { EnrollmentRefused, pollEnrollment, startEnrollment } from "../src/enroll.ts"

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

const START = { userCode: "ABCD-EFGH", deviceCode: "dev_1", approveURL: "http://127.0.0.1/approve?code=ABCD-EFGH", intervalMs: 5, expiresAt: Date.now() + 60_000 }
const redirect = (to: string) => new Response(null, { status: 307, headers: { location: to } })

describe("redirect policy", () => {
  test("redirect: error refuses a redirected start without following it", async () => {
    const target = fake(() => Response.json(START))
    const srv = fake(() => redirect(`${target.url}/spoke/enroll`))
    await expect(startEnrollment(srv.url, "laptop", { redirect: "error" })).rejects.toBeInstanceOf(EnrollmentRefused)
    expect(target.requests).toHaveLength(0)
  })

  test("redirect: error stops polling at once instead of retrying until expiry", async () => {
    const target = fake(() => Response.json({ status: "approved", machineID: "m", machineToken: "t" }))
    const srv = fake(() => redirect(`${target.url}/spoke/enroll/poll`))
    await expect(pollEnrollment(srv.url, START, { redirect: "error" })).rejects.toBeInstanceOf(EnrollmentRefused)
    expect(srv.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
  })

  test("the default still follows redirects", async () => {
    const target = fake(() => Response.json(START))
    const srv = fake(() => redirect(`${target.url}/spoke/enroll`))
    expect(await startEnrollment(srv.url, "laptop")).toEqual(START)
  })
})

describe("redeem-safe polling", () => {
  const slowApproval = () => fake(async () => {
    await Bun.sleep(80)
    return Response.json({ status: "approved", machineID: "m_1", machineToken: "tok" })
  })

  test("keepRedeemed: an abort during an in-flight poll keeps the credential the hub already handed out", async () => {
    const srv = slowApproval()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    expect(await pollEnrollment(srv.url, START, { signal: abort.signal, keepRedeemed: true })).toEqual({ status: "approved", machineID: "m_1", machineToken: "tok" })
  })

  test("keepRedeemed: an abort between polls still cancels before the next request", async () => {
    const srv = fake(() => Response.json({ status: "pending" }))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    expect(await pollEnrollment(srv.url, { ...START, intervalMs: 10 }, { signal: abort.signal, keepRedeemed: true })).toEqual({ status: "cancelled" })
  })

  test("without keepRedeemed the in-flight poll is aborted (existing behaviour)", async () => {
    const srv = slowApproval()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    expect(await pollEnrollment(srv.url, START, { signal: abort.signal })).toEqual({ status: "cancelled" })
  })
})
