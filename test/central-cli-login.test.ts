// `hub login` without --token: the CLI login device code (src/central/auth.ts). A terminal asks with a name and
// the scopes it wants; a signed-in user approves it in the console as themselves, choosing the scopes; the next poll
// gets the decision once. Codes are single-use and expire.
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Auth, CLI_LOGIN_TTL_MS, RateLimitError, ValidationError } from "../src/central/auth"
import { DEFAULT_CLI_LOGIN_SCOPES } from "../src/central/agent/app-tokens"
import { Store } from "../src/central/store"

let now = 1_000_000
let store: Store
let auth: Auth

beforeEach(() => {
  now = 1_000_000
  store = Store.open(mkdtempSync(path.join(tmpdir(), "hub-cli-login-")), () => now)
  auth = new Auth({ store, publicURL: "https://hub.example.com", now: () => now })
})

describe("CLI login codes", () => {
  test("start: a user code, a device code and the approval link; read+message scopes by default", async () => {
    const start = await auth.startCliLogin("laptop", undefined)
    expect(start.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(start.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.approveURL).toBe(`https://hub.example.com/approve?code=${start.userCode}`)
    expect(start.expiresAt).toBe(now + CLI_LOGIN_TTL_MS)
    expect(start.scopes).toEqual([...DEFAULT_CLI_LOGIN_SCOPES])
    expect(DEFAULT_CLI_LOGIN_SCOPES).toEqual(["sessions:read", "messages:send", "messages:read"])
    expect(await auth.cliLogin(start.userCode.toLowerCase())).toEqual({ userCode: start.userCode, clientName: "laptop", scopes: [...DEFAULT_CLI_LOGIN_SCOPES], created: now, expiresAt: start.expiresAt })
  })

  test("requested scopes join the defaults; unknown scopes and bad names are refused", async () => {
    expect((await auth.startCliLogin("laptop", ["sessions:launch"])).scopes).toEqual([...DEFAULT_CLI_LOGIN_SCOPES, "sessions:launch"])
    await expect(auth.startCliLogin("laptop", ["root"])).rejects.toBeInstanceOf(ValidationError)
    await expect(auth.startCliLogin("laptop", "sessions:launch")).rejects.toBeInstanceOf(ValidationError)
    await expect(auth.startCliLogin("", undefined)).rejects.toBeInstanceOf(ValidationError)
    await expect(auth.startCliLogin("x".repeat(65), undefined)).rejects.toBeInstanceOf(ValidationError)
  })

  test("approve as a user with the scopes they chose: delivered once, then the code reads as expired", async () => {
    const start = await auth.startCliLogin("laptop", ["sessions:launch"])
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "pending" })
    expect(await auth.decideCliLogin(start.userCode, "approved", "u1", ["sessions:read", "sessions:launch"])).toBe("laptop")
    // The first decision wins.
    expect(await auth.decideCliLogin(start.userCode, "denied", "u2")).toBeUndefined()
    expect(await auth.cliLogin(start.userCode)).toBeUndefined()
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "approved", ownerID: "u1", clientName: "laptop", scopes: ["sessions:read", "sessions:launch"] })
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "expired" })
  })

  test("approval needs at least one known scope", async () => {
    const start = await auth.startCliLogin("laptop", undefined)
    await expect(auth.decideCliLogin(start.userCode, "approved", "u1", [])).rejects.toBeInstanceOf(ValidationError)
    await expect(auth.decideCliLogin(start.userCode, "approved", "u1", ["admin"])).rejects.toBeInstanceOf(ValidationError)
    await expect(auth.decideCliLogin(start.userCode, "approved", "u1")).rejects.toBeInstanceOf(ValidationError)
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "pending" })
  })

  test("deny: delivered once, nothing approved", async () => {
    const start = await auth.startCliLogin("laptop", undefined)
    expect(await auth.decideCliLogin(start.userCode, "denied", "u1")).toBe("laptop")
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "denied" })
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "expired" })
  })

  test("expiry: an old code can neither be approved nor polled", async () => {
    const start = await auth.startCliLogin("laptop", undefined)
    now += CLI_LOGIN_TTL_MS + 1
    expect(await auth.cliLogin(start.userCode)).toBeUndefined()
    expect(await auth.decideCliLogin(start.userCode, "approved", "u1", ["sessions:read"])).toBeUndefined()
    expect(await auth.pollCliLogin(start.deviceCode)).toEqual({ status: "expired" })
  })

  test("unknown codes; a machine enrollment code is not a CLI login and the other way round", async () => {
    expect(await auth.pollCliLogin("nope")).toEqual({ status: "expired" })
    expect(await auth.pollCliLogin(undefined)).toEqual({ status: "expired" })
    expect(await auth.decideCliLogin("BBBB-BBBB", "approved", "u1", ["sessions:read"])).toBeUndefined()
    const enroll = await auth.startEnrollment("m")
    expect(await auth.cliLogin(enroll.userCode)).toBeUndefined()
    expect(await auth.decideCliLogin(enroll.userCode, "approved", "u1", ["sessions:read"])).toBeUndefined()
    const login = await auth.startCliLogin("laptop", undefined)
    expect(await auth.decide(login.userCode, "approved", "u1")).toBeUndefined()
    expect(await auth.pollEnrollment(login.deviceCode)).toEqual({ status: "expired" })
  })

  test("start is rate limited", async () => {
    for (let i = 0; i < 5; i++) await auth.startCliLogin(`m${i}`, undefined)
    await expect(auth.startCliLogin("m", undefined)).rejects.toBeInstanceOf(RateLimitError)
  })
})
