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
