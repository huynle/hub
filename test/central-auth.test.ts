import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Auth, Limiter, RateLimitError } from "../src/central/auth"
import { Store } from "../src/central/store"

let now = 1_000_000
let store: Store
let auth: Auth

beforeEach(() => {
  now = 1_000_000
  store = Store.open(mkdtempSync(path.join(tmpdir(), "voice-auth-")), () => now)
  auth = new Auth({ store, publicURL: "https://voice.example.com", now: () => now })
})

describe("Limiter", () => {
  test("allows max hits per sliding window", () => {
    const limiter = new Limiter(2, 1000, () => now)
    expect(limiter.tryHit()).toBe(true)
    expect(limiter.tryHit()).toBe(true)
    expect(limiter.tryHit()).toBe(false)
    now += 1001
    expect(limiter.tryHit()).toBe(true)
  })
})

describe("machine enrollment", () => {
  test("start returns a user code, device code and approve URL", () => {
    const start = auth.startEnrollment("laptop")
    expect(start.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(start.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.approveURL).toBe(`https://voice.example.com/approve?code=${start.userCode}`)
    expect(start.intervalMs).toBe(2000)
    expect(start.expiresAt).toBe(now + 10 * 60_000)
    expect(auth.pendingEnrollments()).toEqual([
      { userCode: start.userCode, machineName: "laptop", created: now, expiresAt: start.expiresAt },
    ])
  })

  test("rejects an empty or oversized machine name", () => {
    expect(() => auth.startEnrollment("")).toThrow(/machine name/i)
    expect(() => auth.startEnrollment("x".repeat(65))).toThrow(/machine name/i)
  })

  test("happy path: pending → approved, token returned exactly once", () => {
    const start = auth.startEnrollment("laptop")
    expect(auth.pollEnrollment(start.deviceCode)).toEqual({ status: "pending" })
    expect(auth.approveEnrollment(start.userCode.toLowerCase().replace("-", ""))).toBe(true)
    const poll = auth.pollEnrollment(start.deviceCode)
    expect(poll.status).toBe("approved")
    if (poll.status !== "approved") throw new Error("unreachable")
    expect(store.findMachine(poll.machineToken)?.id).toBe(poll.machineID)
    expect(store.findMachine(poll.machineToken)?.name).toBe("laptop")
    expect(auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(auth.pendingEnrollments()).toEqual([])
  })

  test("deny", () => {
    const start = auth.startEnrollment("laptop")
    expect(auth.denyEnrollment(start.userCode)).toBe(true)
    expect(auth.pollEnrollment(start.deviceCode)).toEqual({ status: "denied" })
    expect(auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(store.machines()).toHaveLength(0)
  })

  test("expiry", () => {
    const start = auth.startEnrollment("laptop")
    now += 10 * 60_000 + 1
    expect(auth.approveEnrollment(start.userCode)).toBe(false)
    expect(auth.pollEnrollment(start.deviceCode)).toEqual({ status: "expired" })
    expect(auth.pendingEnrollments()).toEqual([])
  })

  test("unknown codes", () => {
    expect(auth.pollEnrollment("nope")).toEqual({ status: "expired" })
    expect(auth.approveEnrollment("BBBB-BBBB")).toBe(false)
    expect(auth.denyEnrollment("BBBB-BBBB")).toBe(false)
  })

  test("start is rate limited to 5 per minute", () => {
    for (let i = 0; i < 5; i++) auth.startEnrollment(`m${i}`)
    expect(() => auth.startEnrollment("m6")).toThrow(RateLimitError)
    now += 60_001
    expect(auth.startEnrollment("m7").userCode).toBeTruthy()
  })
})

describe("device pairing", () => {
  test("6-digit code, single use, creates a device", () => {
    const { code, expiresAt } = auth.issuePairCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(now + 5 * 60_000)
    const paired = auth.pair(code, "phone")
    expect(paired && store.findDevice(paired.token)?.name).toBe("phone")
    expect(auth.pair(code, "phone2")).toBeUndefined()
    expect(store.devices()).toHaveLength(1)
  })

  test("expired codes fail", () => {
    const { code } = auth.issuePairCode()
    now += 5 * 60_000 + 1
    expect(auth.pair(code, "phone")).toBeUndefined()
  })

  test("defaults and trims the device name", () => {
    const paired = auth.pair(auth.issuePairCode().code, "  ")
    expect(paired?.device.name).toBe("Device")
  })

  test("failed attempts are rate limited globally, even for a valid code", () => {
    const { code } = auth.issuePairCode()
    const wrong = code === "000000" ? "000001" : "000000"
    for (let i = 0; i < 10; i++) expect(auth.pair(wrong, "x")).toBeUndefined()
    expect(() => auth.pair(code, "phone")).toThrow(RateLimitError)
    now += 60_001
    expect(auth.pair(code, "phone")).toBeDefined()
  })

  test("bootstrap code only while no devices exist", () => {
    const boot = auth.bootstrapCode()
    expect(boot?.code).toMatch(/^\d{6}$/)
    auth.pair(boot!.code, "first")
    expect(auth.bootstrapCode()).toBeUndefined()
  })
})

describe("login links", () => {
  test("32-byte code, 2 minutes, single use", () => {
    const { code, expiresAt } = auth.issueLoginCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt).toBe(now + 2 * 60_000)
    expect(auth.redeemLoginCode(code)).toBe(true)
    expect(auth.redeemLoginCode(code)).toBe(false)
  })

  test("expired login codes fail", () => {
    const { code } = auth.issueLoginCode()
    now += 2 * 60_000 + 1
    expect(auth.redeemLoginCode(code)).toBe(false)
    expect(auth.redeemLoginCode("")).toBe(false)
  })
})
