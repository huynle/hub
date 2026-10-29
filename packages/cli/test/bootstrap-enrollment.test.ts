// `machine enroll` against a local fake hub: approved, denied, expired, cancelled, redeem-once, recovery when the
// credential cannot be saved, the URL/redirect/approval-link policy, lossless persistence, and a secret scan of
// everything the command outputs or shows.
import { afterEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BOOTSTRAP_EXIT, findSecrets, validateEnrollmentStatus, validateEnvelope, type MachineCredential } from "../src/bootstrap/contracts/index.ts"
import { ConfigCredentialStore, defaultMachineName, machineEnroll, renderMachineResult, type EnrollPrompt, type MachineEnrollOptions, type MachineEnrollResult } from "../src/bootstrap/enrollment/index.ts"
import { DEVICE_CODE, fakeHub, tempConfig, testToken, type FakeHub, type FakeHubOptions } from "./bootstrap-enrollment-fake.ts"

const hubs: FakeHub[] = []
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop()
})
const hub = (options?: FakeHubOptions) => {
  const h = fakeHub(options)
  hubs.push(h)
  return h
}

interface Run {
  result: MachineEnrollResult
  prompts: EnrollPrompt[]
  store: ConfigCredentialStore
}

async function enroll(h: { url: string }, options: Partial<MachineEnrollOptions> = {}): Promise<Run> {
  const prompts: EnrollPrompt[] = []
  const store = (options.store as ConfigCredentialStore | undefined) ?? new ConfigCredentialStore(tempConfig())
  const result = await machineEnroll({ server: h.url, machineName: "dev-mac", store, minIntervalMs: 0, persistDelayMs: 0, onPrompt: (p) => prompts.push(p), ...options })
  return { result, prompts, store }
}

/** The envelope, its text rendering and every prompt: nothing may carry a credential or the device code. */
function expectSecretFree(run: Run, ...secrets: string[]) {
  const shown = JSON.stringify(run.result.envelope) + renderMachineResult(run.result.envelope) + JSON.stringify(run.prompts)
  for (const s of [DEVICE_CODE, ...secrets]) expect(shown).not.toContain(s)
  expect(findSecrets(run.result.envelope)).toEqual([])
  expect(findSecrets(run.prompts)).toEqual([])
  expect(validateEnvelope(run.result.envelope).ok).toBe(true)
  if (run.result.envelope.data !== undefined) expect(validateEnrollmentStatus(run.result.envelope.data).ok).toBe(true)
}

const enrollRequests = (h: FakeHub) => h.requests.filter((r) => r.path.startsWith("/spoke/enroll"))

describe("machine enroll", () => {
  test("approved: shows the code, stores one machine identity (0600) and verifies it with the hub", async () => {
    const h = hub()
    const run = await enroll(h)
    expect(run.result.exit).toBe(0)
    expect(run.result.envelope).toMatchObject({ command: "machine enroll", ok: true, data: { state: "verified", server: h.url, machineID: "mach_01", machineName: "dev-mac" } })
    expect(run.prompts).toHaveLength(1)
    expect(run.prompts[0]).toMatchObject({ userCode: "ABCD-EFGH", approveURL: `${h.url}/approve?code=ABCD-EFGH` })
    expect(await run.store.read()).toEqual({ server: h.url, machineID: "mach_01", machineName: "dev-mac", token: h.token })
    expect(lstatSync(run.store.location).mode & 0o777).toBe(0o600)
    expect(h.polls).toBe(1)
    expect(run.result.retryPersist).toBeUndefined()
    expectSecretFree(run, h.token)
  })

  test("keeps every other key of an existing config.json", async () => {
    const h = hub()
    const file = tempConfig()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ mode: "always", sessions: ["ses_a"], someoneElse: { keep: [1, 2] } }))
    await enroll(h, { store: new ConfigCredentialStore(file) })
    const raw = JSON.parse(readFileSync(file, "utf8"))
    expect(raw).toMatchObject({ mode: "always", sessions: ["ses_a"], someoneElse: { keep: [1, 2] }, machineID: "mach_01", server: h.url })
  })

  test("pending polls continue until approval; --no-verify stops at configured", async () => {
    const h = hub({ polls: [{ status: "pending" }, { status: "pending" }, { status: "approved", machineID: "mach_02", machineToken: testToken("second") }] })
    const run = await enroll(h, { verify: false })
    expect(run.result.envelope).toMatchObject({ ok: true, data: { state: "configured", machineID: "mach_02" } })
    expect(h.polls).toBe(3)
    expect(h.requests.some((r) => r.path === "/spoke/ws")).toBe(false)
  })

  test("denied: exit 5, nothing stored", async () => {
    const h = hub({ polls: [{ status: "denied" }] })
    const run = await enroll(h)
    expect(run.result.exit).toBe(BOOTSTRAP_EXIT.forbidden)
    expect(run.result.envelope).toMatchObject({ ok: false, error: { code: "enrollment_denied" } })
    expect(await run.store.read()).toBeUndefined()
    expectSecretFree(run)
  })

  test("expired: by the hub, or by the client's own deadline", async () => {
    const byHub = await enroll(hub({ polls: [{ status: "expired" }] }))
    expect(byHub.result.exit).toBe(BOOTSTRAP_EXIT.needsUser)
    expect(byHub.result.envelope.error?.message).toContain("expired")

    const pending = hub({ polls: [{ status: "pending" }], start: { expiresAt: Date.now() + 86_400_000 } })
    const byClient = await enroll(pending, { maxWaitMs: 60 })
    expect(byClient.result.envelope).toMatchObject({ ok: false, error: { code: "enrollment_expired" } })
    expect(byClient.result.envelope.error?.message).toContain("expired")
    expect(await byClient.store.read()).toBeUndefined()
    expectSecretFree(byClient)
  })

  test("cancelled: an abort while waiting stops polling and stores nothing", async () => {
    const h = hub({ polls: [{ status: "pending" }] })
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 40)
    const run = await enroll(h, { signal: abort.signal, minIntervalMs: 5 })
    expect(run.result.envelope).toMatchObject({ ok: false, error: { code: "cancelled" } })
    expect(run.result.envelope.error?.message).toContain("cancelled")
    expect(await run.store.read()).toBeUndefined()

    const early = new AbortController()
    early.abort()
    const h2 = hub()
    const none = await enroll(h2, { signal: early.signal })
    expect(none.result.envelope.error?.message).toContain("cancelled")
    expect(h2.requests).toHaveLength(0)
  })

  test("redeem-once: an abort during the approving poll still saves the credential, and nothing polls again", async () => {
    const h = hub({ pollDelayMs: 80 })
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    const run = await enroll(h, { signal: abort.signal, verify: false })
    expect(run.result.envelope).toMatchObject({ ok: true, data: { state: "configured", machineID: "mach_01" } })
    expect((await run.store.read())?.token).toBe(h.token)
    expect(h.polls).toBe(1)
  })

  test("a transient write failure after redemption is retried without polling again", async () => {
    const h = hub()
    const inner = new ConfigCredentialStore(tempConfig())
    let failures = 1
    const store = Object.assign(Object.create(inner) as ConfigCredentialStore, {
      write: async (c: MachineCredential) => {
        if (failures-- > 0) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
        return inner.write(c)
      },
    })
    const run = await enroll(h, { store, verify: false })
    expect(run.result.envelope.ok).toBe(true)
    expect((await inner.read())?.machineID).toBe("mach_01")
    expect(h.polls).toBe(1)
  })

  test("a persistent write failure keeps the credential in memory only and offers a retry", async () => {
    const h = hub()
    const inner = new ConfigCredentialStore(tempConfig())
    let broken = true
    const store = Object.assign(Object.create(inner) as ConfigCredentialStore, {
      write: async (c: MachineCredential) => {
        if (broken) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
        return inner.write(c)
      },
    })
    const run = await enroll(h, { store, verify: false, persistAttempts: 2 })
    expect(run.result.exit).toBe(BOOTSTRAP_EXIT.other)
    expect(run.result.envelope).toMatchObject({ ok: false, error: { code: "internal" } })
    expect(run.result.envelope.error?.message).toContain("mach_01")
    expect(run.result.envelope.error?.hint).toContain("revoke")
    expect(await inner.read()).toBeUndefined()
    expectSecretFree(run, h.token)
    expect(JSON.stringify(run.result)).not.toContain(h.token)

    broken = false
    const retried = await run.result.retryPersist!()
    expect(retried.envelope).toMatchObject({ ok: true, data: { state: "configured", machineID: "mach_01" } })
    expect((await inner.read())?.token).toBe(h.token)
    expect(h.polls).toBe(1)
  })

  test("the store is checked before any code is redeemed: a symlinked config fails first, with no hub request", async () => {
    const h = hub()
    const file = tempConfig()
    mkdirSync(path.dirname(file), { recursive: true })
    const target = path.join(path.dirname(path.dirname(file)), "dotfiles.json")
    writeFileSync(target, "{}")
    symlinkSync(target, file)
    const run = await enroll(h, { store: new ConfigCredentialStore(file) })
    expect(run.result.exit).toBe(BOOTSTRAP_EXIT.conflict)
    expect(h.requests).toHaveLength(0)
    expect(readFileSync(target, "utf8")).toBe("{}")
  })

  test("usage errors: a non-https hub URL or an invalid machine name contact nothing", async () => {
    const h = hub()
    for (const server of ["http://hub.example", "https://user:pw@hub.example", "ftp://hub.example", "nope"]) {
      const run = await enroll({ url: server })
      expect(run.result.exit).toBe(BOOTSTRAP_EXIT.usage)
      expect(run.result.envelope.error?.code).toBe("usage")
    }
    const badName = await enroll(h, { machineName: "bad/name\n" })
    expect(badName.result.envelope.error?.code).toBe("usage")
    expect(h.requests).toHaveLength(0)
  })

  test("already enrolled: the same hub is a no-op, another hub needs --reenroll, which replaces the identity", async () => {
    const h = hub()
    const first = await enroll(h, { verify: false })
    const again = await enroll(h, { store: first.store, verify: false })
    expect(again.result.envelope).toMatchObject({ ok: true, data: { state: "configured", machineID: "mach_01" } })
    expect(again.result.envelope.warnings?.join(" ")).toContain("--reenroll")
    expect(enrollRequests(h)).toHaveLength(2)

    const other = hub({ polls: [{ status: "approved", machineID: "mach_09", machineToken: testToken("other") }] })
    const refused = await enroll(other, { store: first.store })
    expect(refused.result.exit).toBe(BOOTSTRAP_EXIT.needsUser)
    expect(other.requests).toHaveLength(0)
    expect((await first.store.read())?.machineID).toBe("mach_01")

    const replaced = await enroll(other, { store: first.store, reenroll: true, verify: false })
    expect(replaced.result.envelope.ok).toBe(true)
    expect(await first.store.read()).toMatchObject({ server: other.url, machineID: "mach_09" })
  })

  test("redirects are refused, never followed", async () => {
    const target = hub()
    const h = hub({ routes: { "/spoke/enroll": () => new Response(null, { status: 307, headers: { location: `${target.url}/spoke/enroll` } }) } })
    const run = await enroll(h)
    expect(run.result.envelope.ok).toBe(false)
    expect(run.result.envelope.error?.message).toContain("redirect")
    expect(target.requests).toHaveLength(0)
  })

  test("an approval link on another origin is replaced by one on the hub URL, with a warning", async () => {
    const h = hub({ start: { approveURL: "https://phish.example/approve?code=ABCD-EFGH" } })
    const run = await enroll(h, { verify: false })
    expect(run.prompts[0]?.approveURL).toBe(`${h.url}/approve?code=ABCD-EFGH`)
    expect(run.prompts[0]?.warning).toContain("origin")
    expect(run.result.envelope.warnings?.join(" ")).toContain("origin")
    expect(JSON.stringify(run)).not.toContain("phish.example")
  })

  test("a malformed start reply is refused and nothing is polled", async () => {
    const h = hub({ start: { userCode: "<script>" } })
    const run = await enroll(h)
    expect(run.result.envelope).toMatchObject({ ok: false, error: { code: "internal" } })
    expect(h.polls).toBe(0)
  })

  test("an unreachable hub is offline (exit 7)", async () => {
    const run = await enroll({ url: "http://127.0.0.1:1" })
    expect(run.result.exit).toBe(BOOTSTRAP_EXIT.unavailable)
    expect(run.result.envelope.error?.code).toBe("offline")
  })

  test("defaultMachineName turns a hostname into a valid machine name", () => {
    expect(defaultMachineName("dev-mac.local")).toBe("dev-mac")
    expect(defaultMachineName("Dana's MacBook Pro")).toBe("Dana-s MacBook Pro")
    expect(defaultMachineName("")).toBe("machine")
    expect(defaultMachineName("x".repeat(100))).toHaveLength(64)
  })
  // HBS-12 acceptance (E1): the OpenCode spoke connects only when config.json's mode is not "off" (its default).
  test("sharing: a fresh enrollment turns it on; an explicit off is kept, with a warning", async () => {
    const h = hub()
    const run = await enroll(h, { verify: false })
    expect(JSON.parse(readFileSync(run.store.location, "utf8")).mode).toBe("always")
    expect(run.result.envelope.warnings ?? []).toEqual([])

    const file = tempConfig()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ mode: "off" }))
    const off = await enroll(hub(), { store: new ConfigCredentialStore(file), verify: false })
    expect(off.result.envelope.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).mode).toBe("off")
    expect(off.result.envelope.warnings?.join(" ")).toContain('mode is "off"')
    expectSecretFree(off)
  })

  test("sharing: enrolling again repairs a credential stored without a mode (an older hubctl), never an explicit one", async () => {
    const h = hub()
    const first = await enroll(h, { verify: false })
    const { mode: _mode, ...rest } = JSON.parse(readFileSync(first.store.location, "utf8"))
    writeFileSync(first.store.location, JSON.stringify(rest))
    const again = await enroll(h, { store: first.store, verify: false })
    expect(again.result.envelope.ok).toBe(true)
    expect(JSON.parse(readFileSync(first.store.location, "utf8")).mode).toBe("always")
    expect(again.result.envelope.warnings?.join(" ")).toContain("sharing")

    writeFileSync(first.store.location, JSON.stringify({ ...rest, mode: "off" }))
    const kept = await enroll(h, { store: first.store, verify: false })
    expect(JSON.parse(readFileSync(first.store.location, "utf8")).mode).toBe("off")
    expect(kept.result.envelope.warnings?.join(" ")).toContain('mode is "off"')
  })
})
