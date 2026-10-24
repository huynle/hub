// Hub-minted session tokens (src/central/agent/session-tokens.ts): format, minting rules and the verifier's
// checks (signature, kid, aud, expiry, epochs, machine, liveness, tenant). The clock is fake; the store is real.
import { beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SESSION_TOKEN_LIFETIME_MS, SessionTokens, type SessionLiveness } from "../src/central/agent/session-tokens"
import { Store } from "../src/central/store"
import { TokenKeys } from "../src/central/token-keys"

const PUBLIC = "http://hub.test"
let clock: number
let store: Store
let keys: TokenKeys
let machineID: string
let tokens: SessionTokens
/** Sessions each machine reports, and the tenant of each session (as the registry would answer). */
let reported: Map<string, Set<string>>
let tenants: Map<string, string>

const liveness: SessionLiveness = {
  sessionTenant: (sessionID) => tenants.get(sessionID),
  machineReports: (machine, sessionID) => reported.get(machine)?.has(sessionID) === true,
}
const make = (publicURL = PUBLIC) => new SessionTokens({ keys, store, sessions: liveness, publicURL, now: () => clock })
const report = (machine: string, sessionID: string, tenant = "local") => {
  if (!reported.has(machine)) reported.set(machine, new Set())
  reported.get(machine)!.add(sessionID)
  tenants.set(sessionID, tenant)
}

const b64 = (text: string) => Buffer.from(text).toString("base64url")
const parts = (token: string) => {
  const [prefix, payload, sig] = token.split(".")
  return { prefix, payload: payload!, sig: sig!, claims: JSON.parse(Buffer.from(payload!, "base64url").toString()) }
}
/** Signs arbitrary claims the way the hub does (to forge tokens a correct verifier must still refuse). */
const forge = (claims: Record<string, unknown>, secret: Buffer = keys.active().secret) => {
  const payload = b64(JSON.stringify(claims))
  const sig = createHmac("sha256", secret).update(`hst1.${payload}`).digest("base64url")
  return `hst1.${payload}.${sig}`
}

beforeEach(() => {
  clock = 1_800_000_000_000
  const dir = mkdtempSync(path.join(tmpdir(), "hub-session-tokens-"))
  store = Store.open(dir, () => clock)
  keys = TokenKeys.open(dir, { env: {}, now: () => clock })
  machineID = store.addMachine("laptop").machine.id
  reported = new Map()
  tenants = new Map()
  report(machineID, "ses_1")
  tokens = make()
})

describe("mint", () => {
  test("hst1.<payload>.<signature> with the documented claims, valid for SESSION_TOKEN_LIFETIME_MS", () => {
    const minted = tokens.mint(machineID, "ses_1")!
    expect(minted.token).toMatch(/^hst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(minted.exp).toBe(clock + SESSION_TOKEN_LIFETIME_MS)
    expect(SESSION_TOKEN_LIFETIME_MS).toBe(24 * 60 * 60 * 1000)
    const { claims, sig } = parts(minted.token)
    expect(claims).toEqual({ typ: "session", uid: "local", mid: machineID, sid: "ses_1", exp: minted.exp, kid: keys.active().kid, ue: 0, me: 0, aud: PUBLIC })
    expect(Buffer.from(sig, "base64url").length).toBe(32)
  })

  test("carries the current user and machine epochs", () => {
    store.bumpUserEpoch("local")
    store.bumpMachineEpoch(machineID)
    store.bumpMachineEpoch(machineID)
    const { claims } = parts(tokens.mint(machineID, "ses_1")!.token)
    expect([claims.ue, claims.me]).toEqual([1, 2])
  })

  test("nothing for a session another tenant owns, an unknown session, or a revoked or unknown machine", () => {
    report(machineID, "ses_bob", "bob")
    expect(tokens.mint(machineID, "ses_bob")).toBeUndefined()
    expect(tokens.mint(machineID, "ses_nobody")).toBeUndefined()
    expect(tokens.mint("mch_unknown", "ses_1")).toBeUndefined()
    store.revokeMachine(machineID)
    expect(tokens.mint(machineID, "ses_1")).toBeUndefined()
  })

  test("nothing for a disabled owner", () => {
    const bob = store.upsertUser({ email: "bob@example.com", role: "user" })
    const bobs = store.addMachine("bob laptop", bob.id).machine.id
    report(bobs, "ses_b", bob.id)
    expect(tokens.mint(bobs, "ses_b")).toBeDefined()
    store.setUser(bob.id, { disabled: true })
    expect(tokens.mint(bobs, "ses_b")).toBeUndefined()
  })
})

describe("verify", () => {
  test("round trip: the session actor of the machine's owner", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    expect(tokens.verify(token)).toEqual({ kind: "session", userID: "local", machineID, sessionID: "ses_1" })
    expect(tokens.verifier.kind).toBe("session")
    expect(tokens.verifier.verify(token)).toEqual({ kind: "session", userID: "local", machineID, sessionID: "ses_1" })
  })

  test("expired at exp, valid just before", () => {
    const { token, exp } = tokens.mint(machineID, "ses_1")!
    clock = exp - 1
    expect(tokens.verify(token)).toMatchObject({ kind: "session" })
    clock = exp
    expect(tokens.verify(token)).toBe("expired")
  })

  test("an unknown kid is refused, even when signed with a real secret", () => {
    const { claims } = parts(tokens.mint(machineID, "ses_1")!.token)
    expect(tokens.verify(forge({ ...claims, kid: "k_unknown" }))).toBeUndefined()
  })

  test("a token signed by an older key still verifies after rotation", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    keys.rotate()
    expect(tokens.verify(token)).toMatchObject({ kind: "session" })
    expect(parts(tokens.mint(machineID, "ses_1")!.token).claims.kid).toBe(keys.active().kid)
  })

  test("tampered payload or signature is refused", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    report(machineID, "ses_2")
    const { payload, sig, claims } = parts(token)
    const otherPayload = b64(JSON.stringify({ ...claims, sid: "ses_2" }))
    expect(tokens.verify(`hst1.${otherPayload}.${sig}`)).toBeUndefined()
    const flipped = Buffer.from(sig, "base64url")
    flipped[0] = flipped[0]! ^ 1
    expect(tokens.verify(`hst1.${payload}.${flipped.toString("base64url")}`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}.${sig.slice(0, -2)}`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}.${sig}AA`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}`)).toBeUndefined()
    expect(tokens.verify(`${token}.x`)).toBeUndefined()
  })

  test("only the hst1 prefix and strict encodings", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    const { payload, sig } = parts(token)
    expect(tokens.verify(`hst2.${payload}.${sig}`)).toBeUndefined()
    expect(tokens.verify(`HST1.${payload}.${sig}`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}=.${sig}`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}+.${sig}`)).toBeUndefined()
    expect(tokens.verify(`hst1.${payload}.${sig}/`)).toBeUndefined()
    expect(tokens.verify(` ${token}`)).toBeUndefined()
    expect(tokens.verify("")).toBeUndefined()
    expect(tokens.verify("hst_fake")).toBeUndefined()
    expect(tokens.verify(`hst1.${"A".repeat(5000)}.${sig}`)).toBeUndefined()
  })

  test("forged claims with a valid signature are still parsed strictly", () => {
    const { claims } = parts(tokens.mint(machineID, "ses_1")!.token)
    expect(tokens.verify(forge(claims))).toMatchObject({ kind: "session" })
    expect(tokens.verify(forge({ ...claims, typ: "app" }))).toBeUndefined()
    expect(tokens.verify(forge({ ...claims, extra: 1 }))).toBeUndefined()
    expect(tokens.verify(forge({ ...claims, exp: String(claims.exp) }))).toBeUndefined()
    expect(tokens.verify(forge({ ...claims, ue: -1 }))).toBeUndefined()
    expect(tokens.verify(forge({ ...claims, me: 1.5 }))).toBeUndefined()
    expect(tokens.verify(forge({ ...claims, sid: "" }))).toBeUndefined()
    const { uid: _uid, ...noUser } = claims
    expect(tokens.verify(forge(noUser))).toBeUndefined()
    expect(tokens.verify(forge([claims] as unknown as Record<string, unknown>))).toBeUndefined()
  })

  test("another hub's audience is refused", () => {
    const { token } = make("http://other.test").mint(machineID, "ses_1")!
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("a user epoch bump invalidates the user's tokens", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    store.bumpUserEpoch("local")
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("a machine epoch bump invalidates the machine's tokens", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    store.bumpMachineEpoch(machineID)
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("a revoked machine's tokens are refused", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    store.revokeMachine(machineID)
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("a session the machine no longer reports is refused", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    reported.get(machineID)!.delete("ses_1")
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("reported only by another machine of the same user: refused", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    const other = store.addMachine("desktop").machine.id
    reported.get(machineID)!.delete("ses_1")
    report(other, "ses_1")
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("a session now owned by another tenant is refused", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    tenants.set("ses_1", "bob")
    expect(tokens.verify(token)).toBeUndefined()
  })

  test("the machine moved to another owner: refused", () => {
    const bob = store.upsertUser({ email: "bob@example.com", role: "user" })
    const { claims } = parts(tokens.mint(machineID, "ses_1")!.token)
    expect(tokens.verify(forge({ ...claims, uid: bob.id }))).toBeUndefined()
  })

  test("an unknown user is refused", () => {
    const { claims } = parts(tokens.mint(machineID, "ses_1")!.token)
    tenants.set("ses_1", "ghost")
    expect(tokens.verify(forge({ ...claims, uid: "ghost" }))).toBeUndefined()
  })

  test("tokens never show in JSON or inspect output of the minter", () => {
    const { token } = tokens.mint(machineID, "ses_1")!
    expect(JSON.stringify(tokens)).not.toContain(token)
    expect(Bun.inspect(tokens)).not.toContain(keys.active().secret.toString("base64"))
  })
})
