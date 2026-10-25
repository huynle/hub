import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Auth, LINK_TTL_MS, RateLimitError, ValidationError } from "../src/central/auth"
import { MemoryCounters } from "../src/central/backend/memory-counters"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { Store } from "../src/central/store"

let now = 1_000_000
let store: Store
let auth: Auth

beforeEach(() => {
  now = 1_000_000
  store = Store.open(mkdtempSync(path.join(tmpdir(), "voice-auth-")), () => now)
  auth = new Auth({ store, publicURL: "https://voice.example.com", now: () => now })
})

describe("machine enrollment", () => {
  test("start returns a user code, device code and approve URL", async () => {
    const start = await auth.startEnrollment("laptop")
    expect(start.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(start.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.approveURL).toBe(`https://voice.example.com/approve?code=${start.userCode}`)
    expect(start.intervalMs).toBe(2000)
    expect(start.expiresAt).toBe(now + 10 * 60_000)
    expect(await auth.pendingEnrollments()).toEqual([
      { userCode: start.userCode, machineName: "laptop", created: now, expiresAt: start.expiresAt },
    ])
  })

  test("rejects an empty or oversized machine name", async () => {
    await expect(auth.startEnrollment("")).rejects.toThrow(/machine name/i)
    await expect(auth.startEnrollment("x".repeat(65))).rejects.toThrow(/machine name/i)
  })

  test("happy path: pending → approved, token returned exactly once", async () => {
    const start = await auth.startEnrollment("laptop")
    expect(await auth.pollEnrollment(start.deviceCode)).toEqual({ status: "pending" })
    expect(await auth.approveEnrollment(start.userCode.toLowerCase().replace("-", ""))).toBe(true)
    const poll = await auth.pollEnrollment(start.deviceCode)
    expect(poll.status).toBe("approved")
    if (poll.status !== "approved") throw new Error("unreachable")
    expect((await store.findMachine(poll.machineToken))?.id).toBe(poll.machineID)
    expect((await store.findMachine(poll.machineToken))?.name).toBe("laptop")
    expect(await auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(await auth.pendingEnrollments()).toEqual([])
  })

  test("deny", async () => {
    const start = await auth.startEnrollment("laptop")
    expect(await auth.denyEnrollment(start.userCode)).toBe(true)
    expect(await auth.pollEnrollment(start.deviceCode)).toEqual({ status: "denied" })
    expect(await auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(store.machines()).toHaveLength(0)
  })

  test("expiry", async () => {
    const start = await auth.startEnrollment("laptop")
    now += 10 * 60_000 + 1
    expect(await auth.approveEnrollment(start.userCode)).toBe(false)
    expect(await auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(await auth.pendingEnrollments()).toEqual([])
  })

  test("unknown codes", async () => {
    expect(await auth.pollEnrollment("nope")).toEqual({ status: "expired" })
    expect(await auth.approveEnrollment("BBBB-BBBB")).toBe(false)
    expect(await auth.denyEnrollment("BBBB-BBBB")).toBe(false)
  })

  test("start is rate limited to 5 per minute", async () => {
    for (let i = 0; i < 5; i++) await auth.startEnrollment(`m${i}`)
    await expect(auth.startEnrollment("m6")).rejects.toThrow(RateLimitError)
    now += 60_001
    expect((await auth.startEnrollment("m7")).userCode).toBeTruthy()
  })
})

describe("device pairing", () => {
  test("6-digit code, single use, creates a device", async () => {
    const { code, expiresAt } = auth.issuePairCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(now + 5 * 60_000)
    const paired = await auth.pair(code, "phone")
    expect(paired && (await store.findDevice(paired.token))?.name).toBe("phone")
    expect(await auth.pair(code, "phone2")).toBeUndefined()
    expect(store.devices()).toHaveLength(1)
  })

  test("expired codes fail", async () => {
    const { code } = auth.issuePairCode()
    now += 5 * 60_000 + 1
    expect(await auth.pair(code, "phone")).toBeUndefined()
  })

  test("defaults and trims the device name", async () => {
    const paired = await auth.pair(auth.issuePairCode().code, "  ")
    expect(paired?.device.name).toBe("Device")
  })

  test("failed attempts are rate limited globally, even for a valid code", async () => {
    const { code } = auth.issuePairCode()
    const wrong = code === "000000" ? "000001" : "000000"
    for (let i = 0; i < 10; i++) expect(await auth.pair(wrong, "x")).toBeUndefined()
    await expect(auth.pair(code, "phone")).rejects.toThrow(RateLimitError)
    now += 60_001
    expect(await auth.pair(code, "phone")).toBeDefined()
  })

  test("bootstrap code only while no devices exist", async () => {
    const boot = auth.bootstrapCode()
    expect(boot?.code).toMatch(/^\d{6}$/)
    await auth.pair(boot!.code, "first")
    expect(auth.bootstrapCode()).toBeUndefined()
  })
})

describe("login links", () => {
  test("32-byte code, 2 minutes, single use", async () => {
    const { code, expiresAt } = auth.issueLoginCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt).toBe(now + 2 * 60_000)
    expect(await auth.redeemLoginCode(code)).toBe(true)
    expect(await auth.redeemLoginCode(code)).toBe(false)
  })

  test("expired login codes fail", async () => {
    const { code } = auth.issueLoginCode()
    now += 2 * 60_000 + 1
    expect(await auth.redeemLoginCode(code)).toBe(false)
    expect(await auth.redeemLoginCode("")).toBe(false)
  })
})

describe("app link codes", () => {
  const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(88)

  test("256-bit base64url code, 5 minutes, single use, creates a device with a token", async () => {
    const { code, expiresAt } = auth.issueLinkCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(LINK_TTL_MS).toBe(5 * 60_000)
    expect(expiresAt).toBe(now + LINK_TTL_MS)
    const linked = await auth.redeemLink(code, "Android (Pixel 9)")
    expect(linked && (await store.findDevice(linked.token))?.id).toBe(linked!.device.id)
    expect(linked?.device.name).toBe("Android (Pixel 9)")
    expect(await auth.redeemLink(code, "again")).toBeUndefined()
    expect(store.devices()).toHaveLength(1)
  })

  test("codes are unique", () => {
    expect(auth.issueLinkCode().code).not.toBe(auth.issueLinkCode().code)
  })

  test("expired link codes fail", async () => {
    const { code } = auth.issueLinkCode()
    now += LINK_TTL_MS + 1
    expect(await auth.redeemLink(code, "phone")).toBeUndefined()
    expect(store.devices()).toHaveLength(0)
  })

  test("still valid right at expiry", async () => {
    const { code } = auth.issueLinkCode()
    now += LINK_TTL_MS
    expect(await auth.redeemLink(code, "phone")).toBeDefined()
  })

  test("the device belongs to the issuing user", async () => {
    const user = await store.upsertUser({ email: "a@example.com", role: "user" })
    const linked = await auth.redeemLink(auth.issueLinkCode(user.id).code, "phone")
    expect(linked?.device.ownerID).toBe(user.id)
  })

  test("a disabled (or missing) owner cannot redeem, and the code is spent", async () => {
    const user = await store.upsertUser({ email: "a@example.com", role: "user" })
    const { code } = auth.issueLinkCode(user.id)
    await store.setUser(user.id, { disabled: true })
    expect(await auth.redeemLink(code, "phone")).toBeUndefined()
    await store.setUser(user.id, { disabled: false })
    expect(await auth.redeemLink(code, "phone")).toBeUndefined()
    expect(await auth.redeemLink(auth.issueLinkCode("usr_gone").code, "phone")).toBeUndefined()
    expect(store.devices()).toHaveLength(0)
  })

  test("sanitises the device name: default, whitespace, control characters, 64 characters", async () => {
    expect((await auth.redeemLink(auth.issueLinkCode().code, undefined))?.device.name).toBe("App")
    expect((await auth.redeemLink(auth.issueLinkCode().code, "   "))?.device.name).toBe("App")
    expect((await auth.redeemLink(auth.issueLinkCode().code, 42))?.device.name).toBe("App")
    expect((await auth.redeemLink(auth.issueLinkCode().code, "  My\n\tPhone\u0000 \u202e "))?.device.name).toBe("My Phone")
    const long = (await auth.redeemLink(auth.issueLinkCode().code, "x".repeat(200)))?.device.name
    expect(long).toBe("x".repeat(64))
  })

  test("stores an optional public key; rejects malformed or oversized ones without spending the code", async () => {
    const linked = await auth.redeemLink(auth.issueLinkCode().code, "phone", KEY)
    expect(linked?.device.publicKey).toBe(KEY)
    const pem = `-----BEGIN PUBLIC KEY-----\n${KEY.slice(0, 64)}\n${KEY.slice(64)}\n-----END PUBLIC KEY-----\n`
    expect((await auth.redeemLink(auth.issueLinkCode().code, "phone", pem))?.device.publicKey).toBe(pem.trim())
    expect((await auth.redeemLink(auth.issueLinkCode().code, "phone"))?.device.publicKey).toBeUndefined()
    expect((await auth.redeemLink(auth.issueLinkCode().code, "phone", ""))?.device.publicKey).toBeUndefined()
    const { code } = auth.issueLinkCode()
    await expect(auth.redeemLink(code, "phone", "not a key!")).rejects.toThrow(ValidationError)
    await expect(auth.redeemLink(code, "phone", "A".repeat(4097))).rejects.toThrow(ValidationError)
    await expect(auth.redeemLink(code, "phone", 7)).rejects.toThrow(ValidationError)
    await expect(auth.redeemLink(code, "phone", "abc")).rejects.toThrow(ValidationError)
    expect(await auth.redeemLink(code, "phone")).toBeDefined()
  })

  test("link codes are purpose-bound: not pairing codes or login codes, and vice versa", async () => {
    const link = auth.issueLinkCode().code
    expect(await auth.pair(link, "phone")).toBeUndefined()
    expect(await auth.redeemLogin(link)).toBeUndefined()
    expect(await auth.redeemLink(link, "phone")).toBeDefined()
    expect(await auth.redeemLink(auth.issueLoginCode().code, "phone")).toBeUndefined()
    expect(await auth.redeemLink(auth.issuePairCode().code, "phone")).toBeUndefined()
    expect(await auth.redeemLink(undefined, "phone")).toBeUndefined()
    expect(store.devices()).toHaveLength(1)
  })

  test("failed redeems do not touch the pairing rate limiter", async () => {
    for (let i = 0; i < 50; i++) expect(await auth.redeemLink(`bad${i}`, "x")).toBeUndefined()
    expect(await auth.pair(auth.issuePairCode().code, "phone")).toBeDefined()
  })
})

// Cluster mode (P6-T8): pending codes, enrollments and the limiters live in the shared Kv / Counters, so a code
// issued by one pod is redeemed on another. Two Auth instances on one Kv + Counters stand for two pods.
describe("on shared Kv and Counters (two pods)", () => {
  let a: Auth
  let b: Auth
  beforeEach(() => {
    const kv = new MemoryKv({ now: () => now })
    const counters = new MemoryCounters({ now: () => now })
    a = new Auth({ store, publicURL: "https://voice.example.com", now: () => now, kv, counters })
    b = new Auth({ store, publicURL: "https://voice.example.com", now: () => now, kv, counters })
  })

  test("an enrollment started on A is listed, approved and polled on B; the token is delivered once", async () => {
    const start = await a.startEnrollment("laptop")
    expect(await b.pendingEnrollments()).toEqual([{ userCode: start.userCode, machineName: "laptop", created: now, expiresAt: start.expiresAt }])
    expect(await b.pollEnrollment(start.deviceCode)).toEqual({ status: "pending" })
    expect(await b.approveEnrollment(start.userCode)).toBe(true)
    expect(await a.approveEnrollment(start.userCode)).toBe(false)
    const poll = await b.pollEnrollment(start.deviceCode)
    expect(poll.status).toBe("approved")
    expect(await a.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(await a.pendingEnrollments()).toEqual([])
    expect(store.machines()).toHaveLength(1)
  })

  test("a denial on A reaches the poll on B", async () => {
    const start = await b.startEnrollment("laptop")
    expect(await a.denyEnrollment(start.userCode)).toBe(true)
    expect(await b.pollEnrollment(start.deviceCode)).toEqual({ status: "denied" })
    expect(await a.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
  })

  test("the enrollment limit counts both pods", async () => {
    for (let i = 0; i < 3; i++) await a.startEnrollment(`a${i}`)
    for (let i = 0; i < 2; i++) await b.startEnrollment(`b${i}`)
    await expect(a.startEnrollment("a3")).rejects.toThrow(RateLimitError)
    await expect(b.startEnrollment("b2")).rejects.toThrow(RateLimitError)
    expect((await a.pendingEnrollments()).map((e) => e.machineName)).toEqual(["a0", "a1", "a2", "b0", "b1"])
  })

  test("pairing, login and link codes issued on A are redeemed once on B", async () => {
    const pair = a.issuePairCode()
    expect(await b.pair(pair.code, "phone")).toBeDefined()
    expect(await a.pair(pair.code, "phone")).toBeUndefined()
    const login = a.issueLoginCode()
    expect(await b.redeemLogin(login.code)).toBe("local")
    expect(await a.redeemLogin(login.code)).toBeUndefined()
    const link = a.issueLinkCode()
    expect(await b.redeemLink(link.code, "app")).toBeDefined()
    expect(await a.redeemLink(link.code, "app")).toBeUndefined()
    // Purpose-bound across pods too.
    expect(await b.redeemLogin(a.issueLinkCode().code)).toBeUndefined()
  })

  test("failed pairing attempts on both pods share one limit", async () => {
    for (let i = 0; i < 5; i++) await a.pair("bad", "x")
    for (let i = 0; i < 5; i++) await b.pair("bad", "x")
    await expect(a.pair(b.issuePairCode().code, "phone")).rejects.toThrow(RateLimitError)
  })
})
