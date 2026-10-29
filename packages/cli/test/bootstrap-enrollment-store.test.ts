// The machine credential store (CredentialStore over the spoke's config.json): atomic private writes, lossless
// merges (I4), refusal of symlinked or hand-broken configs, and one identity that the spoke and `hub node` both read.
import { describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readSpokeCredentials } from "../../node/src/index.ts"
import { readConfig } from "../../../src/config.ts"
import { findSecrets } from "../src/bootstrap/contracts/index.ts"
import { ConfigCredentialStore, CredentialStoreError } from "../src/bootstrap/enrollment/index.ts"

// A test-only value; not a real credential. Built at run time so no token-shaped literal sits in the repository.
const TOKEN = ["mt", "test", "only", "value"].join("_")
const CRED = { server: "https://hub.example", machineID: "mach_01", machineName: "dev-mac", token: TOKEN }

const home = () => mkdtempSync(path.join(tmpdir(), "hbs04-store-"))
const fileIn = (dir: string) => path.join(dir, "hub", "config.json")
const raw = (file: string) => JSON.parse(readFileSync(file, "utf8"))

describe("ConfigCredentialStore", () => {
  test("write then read round-trips, with mode 0600 in a 0700 directory and no temp file left", async () => {
    const file = fileIn(home())
    const store = new ConfigCredentialStore(file)
    expect(store.location).toBe(file)
    expect(await store.read()).toBeUndefined()
    await store.write(CRED)
    expect(await store.read()).toEqual(CRED)
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"])
  })

  test("preserves unknown keys and the spoke's own settings", async () => {
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ mode: "always", sessions: ["ses_a"], futureKey: { deep: [1, { x: true }] }, list: { days: 7, max: 9 } }))
    const store = new ConfigCredentialStore(file)
    await store.write(CRED)
    const after = raw(file)
    expect(after.futureKey).toEqual({ deep: [1, { x: true }] })
    expect(after).toMatchObject({ mode: "always", sessions: ["ses_a"], list: { days: 7, max: 9 }, server: CRED.server, machineID: CRED.machineID })
    await store.clear()
    const cleared = raw(file)
    expect(cleared.token).toBeUndefined()
    expect(cleared.machineID).toBeUndefined()
    expect(cleared).toMatchObject({ futureKey: { deep: [1, { x: true }] }, mode: "always", server: CRED.server })
    expect(await store.read()).toBeUndefined()
  })

  test("one identity: the spoke and `hub node` read the credential the store wrote", async () => {
    const dir = home()
    const file = fileIn(dir)
    await new ConfigCredentialStore(file).write(CRED)
    expect(readConfig(file, "other")).toMatchObject({ server: CRED.server, machineID: CRED.machineID, token: TOKEN })
    expect(readSpokeCredentials({ HUB_SPOKE_CONFIG: file }, dir)).toEqual({ server: CRED.server, machineID: CRED.machineID, token: TOKEN })
  })

  test("a token without a machine ID is incomplete, not a credential", async () => {
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ server: "https://hub.example", token: TOKEN }))
    const store = new ConfigCredentialStore(file)
    expect(await store.read()).toBeUndefined()
    expect(store.inspect()).toEqual({ state: "incomplete" })
  })

  test("refuses a symlinked config file or directory, leaving the target untouched", async () => {
    const dir = home()
    const target = path.join(dir, "dotfiles-config.json")
    writeFileSync(target, "{}")
    const file = fileIn(dir)
    mkdirSync(path.dirname(file), { recursive: true })
    symlinkSync(target, file)
    const store = new ConfigCredentialStore(file)
    await expect(store.preflight()).rejects.toMatchObject({ reason: "symlink" })
    await expect(store.write(CRED)).rejects.toBeInstanceOf(CredentialStoreError)
    expect(readFileSync(target, "utf8")).toBe("{}")

    const realDir = path.join(dir, "dotfiles-hub")
    mkdirSync(realDir)
    const linkedDir = path.join(dir, "linked")
    symlinkSync(realDir, linkedDir)
    await expect(new ConfigCredentialStore(path.join(linkedDir, "config.json")).preflight()).rejects.toMatchObject({ reason: "symlink" })
    expect(readdirSync(realDir)).toEqual([])
  })

  test("refuses a config that is not a JSON object instead of replacing it", async () => {
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{ hand edited")
    const store = new ConfigCredentialStore(file)
    await expect(store.preflight()).rejects.toMatchObject({ reason: "not_object" })
    await expect(store.write(CRED)).rejects.toMatchObject({ reason: "not_object" })
    expect(readFileSync(file, "utf8")).toBe("{ hand edited")
  })

  test("preflight and write report an unwritable directory without touching the file or leaking the token", async () => {
    if (process.getuid?.() === 0) return
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ keep: 1 }))
    chmodSync(path.dirname(file), 0o500)
    const store = new ConfigCredentialStore(file)
    try {
      await expect(store.preflight()).rejects.toMatchObject({ reason: "io" })
      const failure = await store.write(CRED).then(() => undefined, (e: unknown) => e)
      expect(failure).toBeInstanceOf(CredentialStoreError)
      expect(findSecrets({ message: (failure as Error).message, stack: (failure as Error).stack ?? "" })).toEqual([])
      expect(String((failure as Error).message)).not.toContain(TOKEN)
    } finally {
      chmodSync(path.dirname(file), 0o700)
    }
    expect(raw(file)).toEqual({ keep: 1 })
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"])
  })

  test("preflight passes for a fresh location and creates nothing but the private directory", async () => {
    const file = fileIn(home())
    await new ConfigCredentialStore(file).preflight()
    expect(readdirSync(path.dirname(file))).toEqual([])
    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })
})

// HBS-12 acceptance (E1): the OpenCode spoke connects only when config.json's `mode` is not "off", and the spoke's
// default is "off". An enrollment that stores a credential without a mode left the spoke disconnected for good.
describe("ConfigCredentialStore sharing mode", () => {
  test("a fresh enrollment turns sharing on (mode always), so the spoke connects", async () => {
    const file = fileIn(home())
    const store = new ConfigCredentialStore(file)
    expect(store.sharingMode()).toBe("unset")
    await store.write(CRED)
    expect(raw(file).mode).toBe("always")
    expect(readConfig(file, "x").mode).toBe("always")
    expect(store.sharingMode()).toBe("always")
  })

  test("an explicit mode is never overridden, including off", async () => {
    for (const mode of ["off", "session", "always"] as const) {
      const file = fileIn(home())
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ mode, futureKey: 1 }))
      const store = new ConfigCredentialStore(file)
      await store.write(CRED)
      expect(raw(file)).toMatchObject({ mode, futureKey: 1 })
      expect(store.sharingMode()).toBe(mode)
    }
  })

  test("enableSharing sets mode always only when absent, keeping every other key", async () => {
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ server: CRED.server, machineID: CRED.machineID, token: TOKEN, futureKey: [1] }))
    const store = new ConfigCredentialStore(file)
    expect(store.enableSharing()).toBe(true)
    expect(raw(file)).toMatchObject({ mode: "always", futureKey: [1], token: TOKEN })
    expect(store.enableSharing()).toBe(false)
    writeFileSync(file, JSON.stringify({ mode: "off", token: TOKEN }))
    expect(store.enableSharing()).toBe(false)
    expect(raw(file).mode).toBe("off")
  })

  test("a mode the spoke does not understand reads as off (the spoke's own fallback)", async () => {
    const file = fileIn(home())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ mode: "sometimes" }))
    expect(new ConfigCredentialStore(file).sharingMode()).toBe("off")
  })
})
