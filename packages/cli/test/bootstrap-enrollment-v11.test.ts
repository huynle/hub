// Contract amendment v1.1 in machine enrollment: specific error codes for a denied, expired or cancelled enrollment
// (with the exits they always had), and the insecure state: a credential already stored for a plain-http hub that is
// not on loopback is reported with a warning instead of an error, and is never sent anywhere. A new enrollment over
// plain http to such a hub stays refused.
import { afterEach, describe, expect, test } from "bun:test"
import { BOOTSTRAP_EXIT, findSecrets, validateEnrollmentStatus, validateEnvelope } from "../src/bootstrap/contracts/index.ts"
import { ConfigCredentialStore, machineEnroll, machineStatus, renderMachineResult, type MachineEnrollOptions } from "../src/bootstrap/enrollment/index.ts"
import { fakeHub, tempConfig, testToken, type FakeHub, type FakeHubOptions } from "./bootstrap-enrollment-fake.ts"

const hubs: FakeHub[] = []
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop()
})
const hub = (options?: FakeHubOptions) => {
  const h = fakeHub(options)
  hubs.push(h)
  return h
}
const enroll = (h: { url: string }, options: Partial<MachineEnrollOptions> = {}) =>
  machineEnroll({ server: h.url, machineName: "dev-mac", store: new ConfigCredentialStore(tempConfig()), minIntervalMs: 0, persistDelayMs: 0, ...options })

describe("v1.1 enrollment error codes", () => {
  test("denied → enrollment_denied (exit 5, as before)", async () => {
    const r = await enroll(hub({ polls: [{ status: "denied" }] }))
    expect(r.envelope.error?.code).toBe("enrollment_denied")
    expect(r.exit).toBe(BOOTSTRAP_EXIT.forbidden)
  })

  test("expired, by the hub or the client's own deadline → enrollment_expired (exit 4, as before)", async () => {
    const byHub = await enroll(hub({ polls: [{ status: "expired" }] }))
    expect(byHub.envelope.error?.code).toBe("enrollment_expired")
    expect(byHub.exit).toBe(BOOTSTRAP_EXIT.needsUser)
    const byClient = await enroll(hub({ polls: [{ status: "pending" }], start: { expiresAt: Date.now() + 86_400_000 } }), { maxWaitMs: 60 })
    expect(byClient.envelope.error?.code).toBe("enrollment_expired")
  })

  test("cancelled → cancelled (exit 4, as before), before or while waiting", async () => {
    const early = new AbortController()
    early.abort()
    const before = await enroll(hub(), { signal: early.signal })
    expect(before.envelope.error?.code).toBe("cancelled")
    expect(before.exit).toBe(BOOTSTRAP_EXIT.needsUser)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 40)
    const during = await enroll(hub({ polls: [{ status: "pending" }] }), { signal: abort.signal, minIntervalMs: 5 })
    expect(during.envelope.error?.code).toBe("cancelled")
  })
})

describe("v1.1 insecure stored credentials", () => {
  const LAN = "http://192.168.1.10:4097"

  test("machine status reports insecure with a warning, checks nothing and leaks nothing", async () => {
    const token = testToken("lan")
    const store = new ConfigCredentialStore(tempConfig())
    await store.write({ server: LAN, machineID: "mach_01", machineName: "dev-mac", token })
    let called = 0
    const r = await machineStatus({ store, fetch: (async () => (called++, new Response(null, { status: 426 }))) as unknown as typeof fetch })
    expect(called).toBe(0)
    expect(r.exit).toBe(0)
    expect(r.envelope).toMatchObject({ ok: true, data: { state: "insecure", server: LAN, machineID: "mach_01", machineName: "dev-mac" } })
    expect(validateEnrollmentStatus(r.envelope.data).ok).toBe(true)
    expect(validateEnvelope(r.envelope).ok).toBe(true)
    expect(r.envelope.warnings?.join(" ")).toContain("plain http")
    const shown = JSON.stringify(r.envelope) + renderMachineResult(r.envelope)
    expect(shown).not.toContain(token)
    expect(findSecrets(r.envelope)).toEqual([])
  })

  test("a new enrollment over plain http to a non-loopback hub stays refused", async () => {
    const r = await machineEnroll({ server: LAN, machineName: "dev-mac", store: new ConfigCredentialStore(tempConfig()) })
    expect(r.envelope.error?.code).toBe("usage")
  })
})
