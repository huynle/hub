import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { centralConfig, emailAllowed, readHubFile } from "../src/central/config"

const HOME = "/home/user"
const OIDC = {
  VOICE_AUTH: "oidc",
  VOICE_OIDC_CLIENT_ID: "client-123",
  VOICE_OIDC_CLIENT_SECRET: "s3cret-value",
  VOICE_OIDC_ALLOWED: "Alice@Example.com, @example.org",
  VOICE_ADMIN_EMAILS: "admin@example.com",
}

function hubFile(content: unknown, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-hub-auth-"))
  const file = path.join(dir, "hub.json")
  writeFileSync(file, JSON.stringify(content))
  chmodSync(file, mode)
  return file
}

describe("auth config", () => {
  test("pairing is the default", () => {
    expect(centralConfig({}, HOME).auth).toEqual({ mode: "pairing" })
    expect(centralConfig({ VOICE_AUTH: "pairing" }, HOME).auth).toEqual({ mode: "pairing" })
  })

  test("unknown mode is refused", () => {
    expect(() => centralConfig({ VOICE_AUTH: "ldap" }, HOME)).toThrow(/VOICE_AUTH/)
  })

  test("oidc from env: defaults to Google, lowercases lists, admins are allowed", () => {
    const auth = centralConfig(OIDC, HOME).auth
    expect(auth).toMatchObject({
      mode: "oidc",
      issuer: "https://accounts.google.com",
      clientId: "client-123",
      allowed: ["alice@example.com", "@example.org"],
      admins: ["admin@example.com"],
    })
    if (auth.mode !== "oidc") throw new Error("expected oidc")
    expect(auth.clientSecret).toBe("s3cret-value")
  })

  test("the client secret never shows up when the config is serialized or inspected", () => {
    const config = centralConfig(OIDC, HOME)
    expect(JSON.stringify(config)).not.toContain("s3cret-value")
    expect(Bun.inspect(config)).not.toContain("s3cret-value")
  })

  test("oidc requires client ID, secret, allow-list and at least one admin", () => {
    for (const key of ["VOICE_OIDC_CLIENT_ID", "VOICE_OIDC_CLIENT_SECRET", "VOICE_OIDC_ALLOWED", "VOICE_ADMIN_EMAILS"]) {
      const env: Record<string, string> = { ...OIDC }
      delete env[key]
      expect(() => centralConfig(env, HOME)).toThrow(new RegExp(key))
    }
    expect(() => centralConfig({ ...OIDC, VOICE_ADMIN_EMAILS: " , " }, HOME)).toThrow(/VOICE_ADMIN_EMAILS/)
  })

  test("errors never contain the secret", () => {
    try {
      centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "http://idp.example.com" }, HOME)
      throw new Error("expected a throw")
    } catch (cause) {
      expect(String(cause)).not.toContain("s3cret-value")
    }
  })

  test("allow-list entries must be emails or @domain", () => {
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ALLOWED: "alice" }, HOME)).toThrow(/VOICE_OIDC_ALLOWED/)
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ALLOWED: "@" }, HOME)).toThrow(/VOICE_OIDC_ALLOWED/)
    expect(() => centralConfig({ ...OIDC, VOICE_ADMIN_EMAILS: "@example.com" }, HOME)).toThrow(/VOICE_ADMIN_EMAILS/)
  })

  test("issuer must be https; loopback http only with the dev flag", () => {
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "http://idp.example.com" }, HOME)).toThrow(/https/)
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "http://127.0.0.1:5555" }, HOME)).toThrow(/https/)
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "http://idp.example.com", VOICE_OIDC_INSECURE_ISSUER: "1" }, HOME)).toThrow(/loopback/)
    const auth = centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "http://127.0.0.1:5555/", VOICE_OIDC_INSECURE_ISSUER: "1" }, HOME).auth
    expect(auth).toMatchObject({ issuer: "http://127.0.0.1:5555", insecureIssuer: true })
    expect(centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "https://idp.example.com/realms/x/" }, HOME).auth).toMatchObject({
      issuer: "https://idp.example.com/realms/x",
    })
    expect(() => centralConfig({ ...OIDC, VOICE_OIDC_ISSUER: "https://idp.example.com/?q=1" }, HOME)).toThrow(/VOICE_OIDC_ISSUER/)
  })

  test("hub.json auth object; env wins per field", () => {
    const file = hubFile({
      auth: { mode: "oidc", clientId: "file-client", clientSecret: "file-secret", allowed: ["bob@example.com"], admins: "admin@example.com" },
    })
    const { file: hub, warnings } = readHubFile(file, HOME)
    expect(warnings).toEqual([])
    const auth = centralConfig({}, HOME, hub).auth
    expect(auth).toMatchObject({ mode: "oidc", clientId: "file-client", allowed: ["bob@example.com"], admins: ["admin@example.com"] })
    expect(centralConfig({ VOICE_OIDC_CLIENT_ID: "env-client" }, HOME, hub).auth).toMatchObject({ clientId: "env-client" })
    expect(centralConfig({ VOICE_AUTH: "pairing" }, HOME, hub).auth).toEqual({ mode: "pairing" })
  })

  test("hub.json: invalid auth values throw; the secret is ignored in a shared file", () => {
    expect(() => readHubFile(hubFile({ auth: "oidc" }), HOME)).toThrow(/auth/)
    expect(() => readHubFile(hubFile({ auth: { mode: 3 } }), HOME)).toThrow(/auth.mode/)
    expect(() => readHubFile(hubFile({ auth: { allowed: [1] } }), HOME)).toThrow(/auth.allowed/)
    const shared = hubFile({ auth: { mode: "oidc", clientId: "c", clientSecret: "leaky", allowed: "a@example.com", admins: "a@example.com" } }, 0o644)
    const { file: hub, warnings } = readHubFile(shared, HOME)
    expect(warnings.join("\n")).toMatch(/clientSecret/)
    expect(warnings.join("\n")).not.toContain("leaky")
    expect(() => centralConfig({}, HOME, hub)).toThrow(/VOICE_OIDC_CLIENT_SECRET/)
    const { warnings: unknown } = readHubFile(hubFile({ auth: { mode: "pairing", foo: 1 } }), HOME)
    expect(unknown.join("\n")).toMatch(/auth.foo/)
  })
})

describe("emailAllowed", () => {
  const auth = { allowed: ["alice@example.com", "@example.org"], admins: ["admin@example.com"] }
  test("exact emails, @domain entries and admins; case-insensitive", () => {
    expect(emailAllowed(auth, "alice@example.com")).toBe(true)
    expect(emailAllowed(auth, "ALICE@example.com")).toBe(true)
    expect(emailAllowed(auth, "carol@example.org")).toBe(true)
    expect(emailAllowed(auth, "admin@example.com")).toBe(true)
  })
  test("no subdomain, suffix or lookalike matches", () => {
    expect(emailAllowed(auth, "bob@example.com")).toBe(false)
    expect(emailAllowed(auth, "carol@sub.example.org")).toBe(false)
    expect(emailAllowed(auth, "carol@badexample.org")).toBe(false)
    expect(emailAllowed(auth, "alice@example.com.evil.test")).toBe(false)
    expect(emailAllowed(auth, "x@example.org@evil.test")).toBe(false)
    expect(emailAllowed(auth, "")).toBe(false)
  })
})
