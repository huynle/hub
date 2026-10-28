// The spoke-connected probes (HBS-13 integration item 6): one read-only GET /spoke/presence with the machine
// credential, under the enrollment policy (https, or plain http on loopback only; never across a redirect), shaped
// into each adapter's probe interface. Nothing is sent without a stored credential or to an insecure hub.
import { describe, expect, test } from "bun:test"
import type { MachineCredential } from "../src/bootstrap/contracts/index.ts"
import { claudeSpokeProbes, codexSpokeStatus, opencodeSpokeProbe, spokePresence } from "../src/setup/spoke-probe.ts"

const CRED: MachineCredential = { server: "https://hub.example", machineID: "mch_1", machineName: "laptop", token: "mt_secret_token" }
const ctx = { env: {}, home: "/h", platform: "darwin", arch: "arm64", now: () => 1 }

function fakeFetch(reply: { status: number; body?: unknown }, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
}

const PRESENT = { machineID: "mch_1", spokes: [{ harness: "opencode", evidence: "native", features: [] }, { harness: "claude-code", evidence: "hooks", features: ["deliver"] }] }

describe("spokePresence", () => {
  test("asks the hub with the machine token, without following redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await spokePresence({ credential: async () => CRED, fetch: fakeFetch({ status: 200, body: PRESENT }, calls) })
    expect(r).toEqual({ ok: true, spokes: PRESENT.spokes })
    expect(calls[0]!.url).toBe("https://hub.example/spoke/presence")
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer mt_secret_token")
    expect(calls[0]!.init.redirect).toBe("manual")
  })

  test("not enrolled, an insecure hub, a refusal or a redirect: not connected, and the detail never carries the token", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const none = await spokePresence({ credential: async () => undefined, fetch: fakeFetch({ status: 200, body: PRESENT }, calls) })
    expect(none.ok).toBe(false)
    const insecure = await spokePresence({ credential: async () => ({ ...CRED, server: "http://hub.lan" }), fetch: fakeFetch({ status: 200, body: PRESENT }, calls) })
    expect(insecure.ok).toBe(false)
    expect(calls).toHaveLength(0)
    for (const status of [401, 302, 500]) {
      const r = await spokePresence({ credential: async () => CRED, fetch: fakeFetch({ status }) })
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain("mt_secret")
    }
    const loopback = await spokePresence({ credential: async () => ({ ...CRED, server: "http://127.0.0.1:4096" }), fetch: fakeFetch({ status: 200, body: PRESENT }) })
    expect(loopback.ok).toBe(true)
  })

  test("a malformed answer is not connected", async () => {
    const r = await spokePresence({ credential: async () => CRED, fetch: fakeFetch({ status: 200, body: { spokes: "x" } }) })
    expect(r.ok).toBe(false)
  })
})

describe("adapter probes", () => {
  const options = { credential: async () => CRED, fetch: fakeFetch({ status: 200, body: PRESENT }) }

  test("OpenCode: connected when an opencode spoke is", async () => {
    expect((await opencodeSpokeProbe(options).connected({ harness: "opencode", context: ctx })).ok).toBe(true)
    const none = opencodeSpokeProbe({ ...options, fetch: fakeFetch({ status: 200, body: { machineID: "m", spokes: [] } }) })
    const r = await none.connected({ harness: "opencode", context: ctx })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("OpenCode")
  })

  test("Claude Code: connected and conformant only as a hooks spoke", async () => {
    const probes = claudeSpokeProbes(options)
    expect(await probes.spoke()).toMatchObject({ connected: true, harness: "claude-code", evidence: "hooks" })
    expect((await probes.conformance()).ok).toBe(true)
    const wrong = claudeSpokeProbes({ ...options, fetch: fakeFetch({ status: 200, body: { machineID: "m", spokes: [{ harness: "claude-code", evidence: "screen", features: [] }] } }) })
    expect((await wrong.conformance()).ok).toBe(false)
  })

  test("Codex: connected when a codex spoke is", async () => {
    expect((await codexSpokeStatus(options).codex()).connected).toBe(false)
    const cx = codexSpokeStatus({ ...options, fetch: fakeFetch({ status: 200, body: { machineID: "m", spokes: [{ harness: "codex", evidence: "rpc", features: [] }] } }) })
    expect((await cx.codex()).connected).toBe(true)
  })
})
