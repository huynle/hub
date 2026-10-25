// Launch-bound tokens (src/central/agent/launch-tokens.ts): the hlt1 credential a sandboxed harness uses to
// connect back to /spoke/ws for exactly one launch. Format, minting rules and the verifier's checks (signature,
// kid, aud, expiry, epochs, machine, user, launch state and binding). The clock is fake; the store is real; the
// launch lookup is a map (the engine's store implements it in production).
import { beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { inspect } from "node:util"
import { LAUNCH_TOKEN_LIFETIME_MS, LaunchTokens, type LaunchLookup, type LaunchView } from "../src/central/agent/launch-tokens"
import { Store } from "../src/central/store"
import { TokenKeys } from "../src/central/token-keys"

const PUBLIC = "http://hub.test"
let clock: number
let store: Store
let keys: TokenKeys
let machineID: string
let tokens: LaunchTokens
/** Launches by `${userID}/${launchID}`. */
let launches: Map<string, LaunchView>

const lookup: LaunchLookup = { launch: async (userID, launchID) => launches.get(`${userID}/${launchID}`) }
const make = (publicURL = PUBLIC) => new LaunchTokens({ keys, store, launches: lookup, publicURL, now: () => clock })
const setLaunch = (launchID: string, view: LaunchView, userID = "local") => launches.set(`${userID}/${launchID}`, view)

const b64 = (text: string) => Buffer.from(text).toString("base64url")
const parts = (token: string) => {
  const [prefix, payload, sig] = token.split(".")
  return { prefix, payload: payload!, sig: sig!, claims: JSON.parse(Buffer.from(payload!, "base64url").toString()) }
}
/** Signs arbitrary claims the way the hub does (to forge tokens a correct verifier must still refuse). */
const forge = (claims: Record<string, unknown>, secret: Buffer = keys.active().secret, prefix = "hlt1") => {
  const payload = b64(JSON.stringify(claims))
  const sig = createHmac("sha256", secret).update(`${prefix}.${payload}`).digest("base64url")
  return `${prefix}.${payload}.${sig}`
}

beforeEach(() => {
  clock = 1_800_000_000_000
  const dir = mkdtempSync(path.join(tmpdir(), "hub-launch-tokens-"))
  store = Store.open(dir, () => clock)
  keys = TokenKeys.open(dir, { env: {}, now: () => clock })
  machineID = store.addMachine("laptop").machine.id
  launches = new Map()
  setLaunch("lch_1", { state: "provisioning", machineID })
  tokens = make()
})

describe("mint", () => {
  test("hlt1.<payload>.<signature> with the documented claims, valid for LAUNCH_TOKEN_LIFETIME_MS", async () => {
    const minted = (await tokens.mint(machineID, "lch_1"))!
    expect(minted.token).toMatch(/^hlt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(minted.exp).toBe(clock + LAUNCH_TOKEN_LIFETIME_MS)
    expect(LAUNCH_TOKEN_LIFETIME_MS).toBe(24 * 60 * 60 * 1000)
    const { claims, sig } = parts(minted.token)
    expect(claims).toEqual({ uid: "local", mid: machineID, lid: "lch_1", exp: minted.exp, kid: keys.active().kid, ue: 0, me: 0, aud: PUBLIC })
    expect(Buffer.from(sig, "base64url").length).toBe(32)
  })

  test("carries the current user and machine epochs", async () => {
    store.bumpUserEpoch("local")
    store.bumpMachineEpoch(machineID)
    store.bumpMachineEpoch(machineID)
    const { claims } = parts((await tokens.mint(machineID, "lch_1"))!.token)
    expect([claims.ue, claims.me]).toEqual([1, 2])
  })

  test("also for a running launch", async () => {
    setLaunch("lch_1", { state: "running", machineID })
    expect(await tokens.mint(machineID, "lch_1")).toBeDefined()
  })

  test("nothing for a launch that is not provisioning or running", async () => {
    for (const state of ["queued", "placing", "ended"] as const) {
      setLaunch("lch_1", { state, machineID })
      expect(await tokens.mint(machineID, "lch_1")).toBeUndefined()
    }
  })

  test("nothing for an unknown launch, another tenant's launch, or a launch placed on another machine", async () => {
    expect(await tokens.mint(machineID, "lch_nobody")).toBeUndefined()
    setLaunch("lch_bob", { state: "running", machineID }, "bob")
    expect(await tokens.mint(machineID, "lch_bob")).toBeUndefined()
    const other = store.addMachine("desktop").machine.id
    expect(await tokens.mint(other, "lch_1")).toBeUndefined()
    setLaunch("lch_2", { state: "provisioning" })
    expect(await tokens.mint(machineID, "lch_2")).toBeUndefined()
  })

  test("nothing for a revoked or unknown machine, or a disabled owner", async () => {
    expect(await tokens.mint("mch_unknown", "lch_1")).toBeUndefined()
    store.setUser("local", { disabled: true })
    expect(await tokens.mint(machineID, "lch_1")).toBeUndefined()
    store.setUser("local", { disabled: false })
    store.revokeMachine(machineID)
    expect(await tokens.mint(machineID, "lch_1")).toBeUndefined()
  })
})

describe("verify", () => {
  const mint = async () => (await tokens.mint(machineID, "lch_1"))!.token

  test("a fresh token resolves to its user, machine, launch and expiry", async () => {
    const minted = (await tokens.mint(machineID, "lch_1"))!
    expect(await tokens.verify(minted.token)).toEqual({ userID: "local", machineID, launchID: "lch_1", exp: minted.exp })
  })

  test("valid while the launch moves from provisioning to running", async () => {
    const token = await mint()
    setLaunch("lch_1", { state: "running", machineID })
    expect(await tokens.verify(token)).toMatchObject({ launchID: "lch_1" })
  })

  test("expired once the clock reaches exp (genuine token)", async () => {
    const minted = (await tokens.mint(machineID, "lch_1"))!
    clock = minted.exp - 1
    expect(await tokens.verify(minted.token)).toBeDefined()
    clock = minted.exp
    expect(await tokens.verify(minted.token)).toBe("expired")
  })

  test("refused once the launch ends, disappears or is placed elsewhere", async () => {
    const token = await mint()
    setLaunch("lch_1", { state: "ended", machineID })
    expect(await tokens.verify(token)).toBeUndefined()
    launches.clear()
    expect(await tokens.verify(token)).toBeUndefined()
    setLaunch("lch_1", { state: "running", machineID: "mch_other" })
    expect(await tokens.verify(token)).toBeUndefined()
  })

  test("looks the launch up for the token's user", async () => {
    const token = await mint()
    launches.clear()
    setLaunch("lch_1", { state: "running", machineID }, "bob")
    expect(await tokens.verify(token)).toBeUndefined()
  })

  test("refused after a user or machine epoch bump", async () => {
    const token = await mint()
    store.bumpUserEpoch("local")
    expect(await tokens.verify(token)).toBeUndefined()
    const again = await mint()
    store.bumpMachineEpoch(machineID)
    expect(await tokens.verify(again)).toBeUndefined()
  })

  test("refused for a revoked machine or a disabled user (valid again once re-enabled)", async () => {
    const token = await mint()
    store.setUser("local", { disabled: true })
    expect(await tokens.verify(token)).toBeUndefined()
    store.setUser("local", { disabled: false })
    expect(await tokens.verify(token)).toBeDefined()
    store.revokeMachine(machineID)
    expect(await tokens.verify(token)).toBeUndefined()
  })

  test("refused for another audience", async () => {
    const token = await mint()
    expect(await make("http://elsewhere.test").verify(token)).toBeUndefined()
  })

  test("refused for an unknown kid, a tampered payload or signature, or a bad signature length", async () => {
    const token = await mint()
    const { payload, sig, claims } = parts(token)
    expect(await tokens.verify(forge({ ...claims, kid: "k_unknown" }))).toBeUndefined()
    const tampered = b64(JSON.stringify({ ...claims, lid: "lch_2" }))
    setLaunch("lch_2", { state: "running", machineID })
    expect(await tokens.verify(`hlt1.${tampered}.${sig}`)).toBeUndefined()
    const flipped = Buffer.from(sig, "base64url")
    flipped[0] = flipped[0]! ^ 1
    expect(await tokens.verify(`hlt1.${payload}.${flipped.toString("base64url")}`)).toBeUndefined()
    expect(await tokens.verify(`hlt1.${payload}.${sig.slice(0, 20)}`)).toBeUndefined()
  })

  test("still valid under an older key after rotation", async () => {
    const token = await mint()
    keys.rotate()
    expect(await tokens.verify(token)).toBeDefined()
  })

  test("only the hlt1 form: other prefixes, part counts, non-canonical base64url and extra or missing claims fail", async () => {
    const token = await mint()
    const { payload, sig, claims } = parts(token)
    expect(await tokens.verify(`hst1.${payload}.${sig}`)).toBeUndefined()
    expect(await tokens.verify(forge(claims, keys.active().secret, "hst1"))).toBeUndefined()
    expect(await tokens.verify(`${token}.x`)).toBeUndefined()
    expect(await tokens.verify(`hlt1.${payload}=.${sig}`)).toBeUndefined()
    expect(await tokens.verify(forge({ ...claims, extra: 1 }))).toBeUndefined()
    const { aud: _aud, ...missing } = claims
    expect(await tokens.verify(forge(missing))).toBeUndefined()
    expect(await tokens.verify(forge({ ...claims, exp: "never" }))).toBeUndefined()
    expect(await tokens.verify(forge({ ...claims, lid: "" }))).toBeUndefined()
    expect(await tokens.verify(forge({ ...claims, me: -1 }))).toBeUndefined()
    expect(await tokens.verify(forge([claims] as unknown as Record<string, unknown>))).toBeUndefined()
    expect(await tokens.verify(`hlt1.${b64("not json")}.${sig}`)).toBeUndefined()
    expect(await tokens.verify("")).toBeUndefined()
    expect(await tokens.verify("x".repeat(5000))).toBeUndefined()
    expect(await tokens.verify(undefined as unknown as string)).toBeUndefined()
  })

  test("a session token (hst1) signed with the same keys is not a launch token", async () => {
    const hst1 = forge({ typ: "session", uid: "local", mid: machineID, sid: "ses_1", exp: clock + 1000, kid: keys.active().kid, ue: 0, me: 0, aud: PUBLIC }, keys.active().secret, "hst1")
    expect(await tokens.verify(hst1)).toBeUndefined()
  })

  test("a launch the lookup throws on is refused, not thrown", async () => {
    const token = await mint()
    const failing = new LaunchTokens({ keys, store, publicURL: PUBLIC, now: () => clock, launches: { launch: async () => { throw new Error("state down") } } })
    expect(await failing.verify(token)).toBeUndefined()
  })
})

describe("never serialised", () => {
  test("JSON and inspect show no secrets or tokens", async () => {
    const token = (await tokens.mint(machineID, "lch_1"))!.token
    const shown = JSON.stringify(tokens) + inspect(tokens, { showHidden: true, depth: 5 })
    expect(shown).not.toContain(token.split(".")[2]!)
    expect(shown).not.toContain(keys.active().secret.toString("base64"))
    expect(JSON.parse(JSON.stringify(tokens))).toEqual({ audience: PUBLIC, lifetimeMs: LAUNCH_TOKEN_LIFETIME_MS })
    expect(inspect(tokens)).toBe(`LaunchTokens(${PUBLIC})`)
  })
})
