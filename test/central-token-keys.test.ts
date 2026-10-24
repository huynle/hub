import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TOKEN_KEYS_FILE, TokenKeys } from "../src/central/token-keys"

const tmp = () => mkdtempSync(path.join(tmpdir(), "hub-token-keys-"))
const fileOf = (dir: string) => path.join(dir, TOKEN_KEYS_FILE)
const readFile = (dir: string) => JSON.parse(readFileSync(fileOf(dir), "utf8"))

describe("TokenKeys", () => {
  test("creates the key file on first use only, mode 0600, 32-byte base64 secret", () => {
    const dir = tmp()
    const keys = TokenKeys.open(dir, { now: () => 1000 })
    expect(existsSync(fileOf(dir))).toBe(false)
    const active = keys.active()
    expect(active.secret.length).toBe(32)
    expect(existsSync(fileOf(dir))).toBe(true)
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600)
    const raw = readFile(dir)
    expect(raw.active).toBe(active.kid)
    expect(raw.keys).toHaveLength(1)
    expect(raw.keys[0]).toEqual({ kid: active.kid, secret: active.secret.toString("base64"), created: 1000 })
    expect(Buffer.from(raw.keys[0].secret, "base64").length).toBe(32)
    // A second call reuses the key.
    expect(keys.active().kid).toBe(active.kid)
  })

  test("rotate adds a new active kid and keeps the previous ones for verification", () => {
    const dir = tmp()
    const keys = TokenKeys.open(dir)
    const first = keys.active()
    const kid = keys.rotate()
    expect(kid).not.toBe(first.kid)
    expect(keys.active().kid).toBe(kid)
    expect(keys.key(first.kid)?.equals(first.secret)).toBe(true)
    expect(keys.key(kid)?.equals(first.secret)).toBe(false)
    expect(keys.kids()).toEqual([first.kid, kid])
    expect(keys.key("nope")).toBeUndefined()
    expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600)
  })

  test("rotate on a fresh directory creates the file with one key", () => {
    const dir = tmp()
    const kid = TokenKeys.open(dir).rotate()
    expect(readFile(dir)).toMatchObject({ active: kid, keys: [{ kid }] })
  })

  test("reload keeps every key and the active kid", () => {
    const dir = tmp()
    const keys = TokenKeys.open(dir)
    const first = keys.active()
    const second = keys.rotate()
    const again = TokenKeys.open(dir)
    expect(again.active().kid).toBe(second)
    expect(again.kids()).toEqual([first.kid, second])
    expect(again.key(first.kid)?.equals(first.secret)).toBe(true)
  })

  test("returned secrets are copies", () => {
    const keys = TokenKeys.open(tmp())
    const active = keys.active()
    active.secret.fill(0)
    expect(keys.active().secret.equals(active.secret)).toBe(false)
  })

  test("a corrupt or invalid file fails with a message that never includes the content", () => {
    const secret = Buffer.alloc(32, 7).toString("base64")
    for (const content of [
      `{"active": "a", "keys": [{"kid": "a", "secret": "${secret}"`,
      JSON.stringify({ active: "b", keys: [{ kid: "a", secret, created: 1 }] }),
      JSON.stringify({ active: "a", keys: [{ kid: "a", secret: "c2hvcnQ=", created: 1 }] }),
      JSON.stringify({ active: "a", keys: "x" }),
    ]) {
      const dir = tmp()
      writeFileSync(fileOf(dir), content, { mode: 0o600 })
      let message = ""
      try {
        TokenKeys.open(dir).active()
      } catch (cause) {
        message = String(cause)
      }
      expect(message).toContain(TOKEN_KEYS_FILE)
      expect(message).not.toContain(secret)
    }
  })

  test("serialising the object never shows secrets", () => {
    const keys = TokenKeys.open(tmp())
    const { secret } = keys.active()
    const b64 = secret.toString("base64")
    expect(JSON.stringify(keys)).not.toContain(b64)
    expect(String(keys)).not.toContain(b64)
    expect(Bun.inspect(keys)).not.toContain(b64)
  })

  test("HUB_TOKEN_KEYS override: keys from the env, no file written, rotate refused", () => {
    const dir = tmp()
    const secret = Buffer.alloc(32, 1).toString("base64")
    const env = { HUB_TOKEN_KEYS: JSON.stringify({ active: "env1", keys: [{ kid: "env1", secret, created: 5 }] }) }
    const keys = TokenKeys.open(dir, { env })
    expect(keys.active().kid).toBe("env1")
    expect(keys.active().secret.toString("base64")).toBe(secret)
    expect(() => keys.rotate()).toThrow(/HUB_TOKEN_KEYS/)
    expect(existsSync(fileOf(dir))).toBe(false)
    let message = ""
    try {
      TokenKeys.open(dir, { env: { HUB_TOKEN_KEYS: `{"active":"x","keys":[{"kid":"y","secret":"${secret}"}]}` } }).active()
    } catch (cause) {
      message = String(cause)
    }
    expect(message).toContain("HUB_TOKEN_KEYS")
    expect(message).not.toContain(secret)
  })
})
