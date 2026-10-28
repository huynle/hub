// `machine status`: configured / verified / revoked / offline / unconfigured from the stored credential and a real
// check against a local fake hub; the output (envelope and text) never carries a credential.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BOOTSTRAP_EXIT, findSecrets, validateEnrollmentStatus, validateEnvelope } from "../src/bootstrap/contracts/index.ts"
import { checkServerURL, ConfigCredentialStore, machineStatus, renderMachineResult } from "../src/bootstrap/enrollment/index.ts"
import { fakeHub, tempConfig, testToken, type FakeHub } from "./bootstrap-enrollment-fake.ts"

const hubs: FakeHub[] = []
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop()
})
const hub = (...args: Parameters<typeof fakeHub>) => {
  const h = fakeHub(...args)
  hubs.push(h)
  return h
}

const NOW = 1_800_000_000_000
async function enrolled(server: string, token: string) {
  const file = tempConfig()
  const store = new ConfigCredentialStore(file)
  await store.write({ server, machineID: "mach_01", machineName: "dev-mac", token })
  return store
}

/** Everything a caller could print: the JSON envelope and the text rendering. */
function expectSecretFree(result: Awaited<ReturnType<typeof machineStatus>>, ...secrets: string[]) {
  const out = JSON.stringify(result.envelope) + renderMachineResult(result.envelope)
  for (const s of secrets) expect(out).not.toContain(s)
  expect(findSecrets(result.envelope)).toEqual([])
  expect(validateEnvelope(result.envelope).ok).toBe(true)
  if (result.envelope.data !== undefined) expect(validateEnrollmentStatus(result.envelope.data).ok).toBe(true)
}

describe("machine status", () => {
  test("unconfigured: no credential, exit 0", async () => {
    const r = await machineStatus({ store: new ConfigCredentialStore(tempConfig()), now: () => NOW })
    expect(r.exit).toBe(0)
    expect(r.envelope).toMatchObject({ command: "machine status", ok: true, data: { state: "unconfigured" } })
    expectSecretFree(r)
  })

  test("a token without a machine ID reads as unconfigured with a hint to enroll again", async () => {
    const file = tempConfig()
    mkdirSync(path.dirname(file), { recursive: true })
    const token = testToken("orphan")
    writeFileSync(file, JSON.stringify({ server: "https://hub.example", token }))
    const r = await machineStatus({ store: new ConfigCredentialStore(file), now: () => NOW })
    expectSecretFree(r, token)
    expect(r.envelope.data).toMatchObject({ state: "unconfigured" })
    expect(String(r.envelope.data?.detail)).toContain("machine enroll")
  })

  test("verified: the hub accepts the credential", async () => {
    const h = hub()
    const r = await machineStatus({ store: await enrolled(h.url, h.token), now: () => NOW })
    expect(r.exit).toBe(0)
    expect(r.envelope).toMatchObject({ ok: true, data: { state: "verified", server: h.url, machineID: "mach_01", machineName: "dev-mac", checkedAt: NOW } })
    expect(h.requests).toEqual([{ method: "GET", path: "/spoke/ws", authorized: true }])
    expectSecretFree(r, h.token)
  })

  test("configured: --no-verify does not contact the hub", async () => {
    const h = hub()
    const r = await machineStatus({ store: await enrolled(h.url, h.token), verify: false, now: () => NOW })
    expect(r.envelope).toMatchObject({ ok: true, data: { state: "configured" } })
    expect(r.envelope.data).not.toHaveProperty("checkedAt")
    expect(h.requests).toHaveLength(0)
  })

  test("revoked: the hub rejects the credential (exit 9, status still reported)", async () => {
    const h = hub()
    h.revoke()
    const r = await machineStatus({ store: await enrolled(h.url, h.token), now: () => NOW })
    expect(r.exit).toBe(BOOTSTRAP_EXIT.unauthorized)
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "revoked" }, data: { state: "revoked", checkedAt: NOW } })
    expectSecretFree(r, h.token)
  })

  test("offline: nothing answers, or the hub fails (exit 7)", async () => {
    const token = testToken("offline")
    const down = await machineStatus({ store: await enrolled("http://127.0.0.1:1", token), now: () => NOW })
    expect(down.exit).toBe(BOOTSTRAP_EXIT.unavailable)
    expect(down.envelope).toMatchObject({ ok: false, error: { code: "offline" }, data: { state: "offline", checkedAt: NOW } })
    expectSecretFree(down, token)

    const h = hub({ routes: { "/spoke/ws": () => new Response("draining", { status: 503 }) } })
    const failing = await machineStatus({ store: await enrolled(h.url, h.token), now: () => NOW })
    expect(failing.envelope.data).toMatchObject({ state: "offline" })
    expect(String(failing.envelope.data?.detail)).toContain("503")
  })

  test("a redirecting hub is not followed and the credential is not sent on", async () => {
    const target = hub()
    const h = hub({ routes: { "/spoke/ws": () => new Response(null, { status: 307, headers: { location: `${target.url}/spoke/ws` } }) } })
    const r = await machineStatus({ store: await enrolled(h.url, h.token), now: () => NOW })
    expect(r.envelope.data).toMatchObject({ state: "offline" })
    expect(target.requests).toHaveLength(0)
  })

  test("never sends the credential to a plain-http, non-loopback hub; reports it as invalid", async () => {
    let called = 0
    const token = testToken("lan")
    const r = await machineStatus({
      store: await enrolled("http://192.168.1.10:4097", token),
      now: () => NOW,
      fetch: (async () => {
        called++
        return new Response(null, { status: 426 })
      }) as unknown as typeof fetch,
    })
    expect(called).toBe(0)
    expectSecretFree(r, token)
    // The status contract only carries https (or loopback http) hub URLs, so this is an error without a status.
    expect(r.exit).toBe(BOOTSTRAP_EXIT.usage)
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "invalid" } })
    expect(r.envelope.data).toBeUndefined()
    expect(r.envelope.error?.message).toContain("https")
  })

  test("a broken config.json is reported as a conflict without its contents", async () => {
    const file = tempConfig()
    mkdirSync(path.dirname(file), { recursive: true })
    const token = testToken("broken")
    writeFileSync(file, `{ "token": "${token}", oops`)
    const r = await machineStatus({ store: new ConfigCredentialStore(file), now: () => NOW })
    expect(r.exit).toBe(BOOTSTRAP_EXIT.conflict)
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "conflict" } })
    expectSecretFree(r, token)
  })

  test("an aborted check is reported as offline, not verified", async () => {
    const h = hub({ routes: { "/spoke/ws": async () => (await Bun.sleep(200), new Response(null, { status: 426 })) } })
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 20)
    const r = await machineStatus({ store: await enrolled(h.url, h.token), signal: abort.signal, now: () => NOW })
    expect(r.envelope.data).toMatchObject({ state: "offline" })
  })
})

describe("server URL policy", () => {
  test("https anywhere, http only for loopback, no credentials, no query or fragment", () => {
    expect(checkServerURL("https://hub.example/")).toBe("https://hub.example")
    expect(checkServerURL("https://hub.example/base/")).toBe("https://hub.example/base")
    expect(checkServerURL("http://127.0.0.1:4097")).toBe("http://127.0.0.1:4097")
    expect(checkServerURL("http://localhost:4097")).toBe("http://localhost:4097")
    expect(checkServerURL("http://[::1]:4097")).toBe("http://[::1]:4097")
    for (const bad of ["http://hub.example", "http://192.168.1.10", "ftp://hub.example", "https://user:pw@hub.example", "https://hub.example/?x=1", "https://hub.example/#f", "hub.example", "", "https://hub example"]) {
      expect(checkServerURL(bad)).toBeUndefined()
    }
  })
})
