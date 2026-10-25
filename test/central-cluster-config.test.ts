// Cluster mode configuration (design §9, decision vkxkqiuf #2): HUB_DATABASE_URL + HUB_VALKEY_URL (both or
// neither) over hub.json `cluster {database, valkey}`, HUB_POD_ID (default the hostname). Cluster mode needs
// HUB_TOKEN_KEYS and OIDC sign-in (pairing mode is single-process). The URLs carry credentials: they never
// appear in errors, warnings, JSON or inspect output.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { centralConfig, readHubFile } from "../src/central/config"

const HOME = "/home/me"
const DB = "postgres://hub:s3cretDBpass@db.internal:5432/hub"
const VK = "redis://:s3cretVKpass@valkey.internal:6379/0"
const KEYS = JSON.stringify({ active: "k1", keys: [{ kid: "k1", secret: Buffer.alloc(32, 1).toString("base64"), created: 0 }] })
const OIDC = {
  HUB_AUTH: "oidc",
  HUB_OIDC_CLIENT_ID: "cid",
  HUB_OIDC_CLIENT_SECRET: "csecret",
  HUB_OIDC_ALLOWED: "@example.com",
  HUB_ADMIN_EMAILS: "admin@example.com",
}
const CLUSTER = { ...OIDC, HUB_DATABASE_URL: DB, HUB_VALKEY_URL: VK, HUB_TOKEN_KEYS: KEYS }

function file(content: unknown, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-cluster-cfg-"))
  const p = path.join(dir, "hub.json")
  writeFileSync(p, JSON.stringify(content))
  chmodSync(p, mode)
  return p
}

/** The error centralConfig throws for `env`, checked to carry no secret. */
function failure(env: Record<string, string>, hub = {}): string {
  let message = ""
  try {
    centralConfig(env, HOME, hub)
  } catch (cause) {
    message = (cause as Error).message
  }
  expect(message).not.toBe("")
  for (const secret of ["s3cretDBpass", "s3cretVKpass", "db.internal", "valkey.internal"]) expect(message).not.toContain(secret)
  return message
}

describe("cluster config", () => {
  test("default (no cluster keys): no cluster section at all", () => {
    expect("cluster" in centralConfig({}, HOME)).toBe(false)
    expect("cluster" in centralConfig(OIDC, HOME)).toBe(false)
  })

  test("both URLs, token keys and oidc: cluster mode with the pod id from HUB_POD_ID", () => {
    const config = centralConfig({ ...CLUSTER, HUB_POD_ID: "hub-7d9f-abc" }, HOME)
    expect(config.cluster?.podID).toBe("hub-7d9f-abc")
    expect(config.cluster?.databaseURL).toBe(DB)
    expect(config.cluster?.valkeyURL).toBe(VK)
  })

  test("the pod id defaults to the hostname", () => {
    expect(centralConfig(CLUSTER, HOME).cluster?.podID).toBe(hostname())
  })

  test("the URLs never show in JSON or inspect output", () => {
    const config = centralConfig(CLUSTER, HOME)
    for (const text of [JSON.stringify(config), Bun.inspect(config), JSON.stringify(config.cluster), Bun.inspect(config.cluster)]) {
      expect(text).not.toContain("s3cretDBpass")
      expect(text).not.toContain("s3cretVKpass")
    }
  })

  test("hub.json cluster.database / cluster.valkey, under the env", () => {
    const fromFile = centralConfig({ ...OIDC, HUB_TOKEN_KEYS: KEYS }, HOME, { cluster: { database: DB, valkey: VK } })
    expect(fromFile.cluster?.databaseURL).toBe(DB)
    expect(fromFile.cluster?.valkeyURL).toBe(VK)
    const other = "postgresql://other:pw@db2/hub"
    const mixed = centralConfig({ ...CLUSTER, HUB_DATABASE_URL: other }, HOME, { cluster: { database: DB, valkey: "rediss://x@vk2:6380" } })
    expect(mixed.cluster?.databaseURL).toBe(other)
    expect(mixed.cluster?.valkeyURL).toBe(VK)
  })

  test("one URL without the other is refused, naming both keys", () => {
    const { HUB_VALKEY_URL: _v, ...dbOnly } = CLUSTER
    expect(failure(dbOnly)).toMatch(/HUB_DATABASE_URL.*HUB_VALKEY_URL.*together/)
    const { HUB_DATABASE_URL: _d, ...vkOnly } = CLUSTER
    expect(failure(vkOnly)).toMatch(/HUB_DATABASE_URL.*HUB_VALKEY_URL.*together/)
    expect(failure({ ...OIDC, HUB_TOKEN_KEYS: KEYS }, { cluster: { valkey: VK } })).toMatch(/together/)
  })

  test("URLs must be postgres(ql):// and redis(s):// URLs; the error names the key, never the value", () => {
    expect(failure({ ...CLUSTER, HUB_DATABASE_URL: "mysql://u:s3cretDBpass@db.internal/hub" })).toMatch(/HUB_DATABASE_URL.*postgres/)
    expect(failure({ ...CLUSTER, HUB_DATABASE_URL: "s3cretDBpass not a url" })).toMatch(/HUB_DATABASE_URL/)
    expect(failure({ ...CLUSTER, HUB_VALKEY_URL: "http://:s3cretVKpass@valkey.internal" })).toMatch(/HUB_VALKEY_URL.*redis/)
    expect(centralConfig({ ...CLUSTER, HUB_DATABASE_URL: "postgresql://h/db", HUB_VALKEY_URL: "rediss://h:6380" }, HOME).cluster).toBeDefined()
  })

  test("HUB_VALKEY_URL may also be valkey:// or valkeys:// (Bun.RedisClient takes both)", () => {
    for (const url of ["valkey://h:6379", "valkeys://:pw@h:6380/1"]) {
      expect(centralConfig({ ...CLUSTER, HUB_VALKEY_URL: url }, HOME).cluster?.valkeyURL).toBe(url)
    }
    expect(failure({ ...CLUSTER, HUB_VALKEY_URL: "http://:s3cretVKpass@valkey.internal" })).toMatch(/redis:\/\/ or rediss:\/\/ or valkey:\/\/ or valkeys:\/\//)
  })

  test("cluster mode requires HUB_TOKEN_KEYS", () => {
    const { HUB_TOKEN_KEYS: _k, ...noKeys } = CLUSTER
    expect(failure(noKeys)).toMatch(/HUB_TOKEN_KEYS/)
    expect(failure({ ...CLUSTER, HUB_TOKEN_KEYS: "  " })).toMatch(/HUB_TOKEN_KEYS/)
  })

  test("cluster mode refuses pairing mode", () => {
    const { HUB_AUTH: _a, ...pairing } = CLUSTER
    expect(failure(pairing)).toMatch(/pairing/)
    expect(failure({ ...CLUSTER, HUB_AUTH: "pairing" })).toMatch(/HUB_AUTH=oidc/)
  })

  test("an invalid HUB_POD_ID is refused", () => {
    for (const id of ["has space", "a/b", "-lead", "x".repeat(129)]) {
      expect(failure({ ...CLUSTER, HUB_POD_ID: id })).toMatch(/HUB_POD_ID/)
    }
    for (const unset of ["", " "]) expect(centralConfig({ ...CLUSTER, HUB_POD_ID: unset }, HOME).cluster?.podID).toBe(hostname())
  })
})

describe("hub.json cluster", () => {
  test("reads cluster.database and cluster.valkey; unknown keys warn", () => {
    const p = file({ cluster: { database: DB, valkey: VK, extra: 1 } })
    const { file: hub, warnings } = readHubFile(p, HOME)
    expect(hub?.cluster).toEqual({ database: DB, valkey: VK })
    expect(warnings).toEqual([`${p}: unknown key "cluster.extra" ignored`])
  })

  test("invalid shapes throw without echoing values", () => {
    for (const cluster of ["s3cretDBpass", { database: 5 }, { valkey: "" }]) {
      let message = ""
      try {
        readHubFile(file({ cluster }), HOME)
      } catch (cause) {
        message = (cause as Error).message
      }
      expect(message).toMatch(/cluster/)
      expect(message).not.toContain("s3cretDBpass")
    }
  })

  test("URLs with a password are ignored, with a warning, when the file is readable by others", () => {
    const p = file({ cluster: { database: DB, valkey: "redis://valkey.internal:6379" } }, 0o644)
    const { file: hub, warnings } = readHubFile(p, HOME)
    expect(hub?.cluster).toEqual({ valkey: "redis://valkey.internal:6379" })
    expect(warnings).toEqual([`${p} is readable by other users, so its cluster.database is ignored (it holds a password). Fix it with: chmod 600 ${p}`])
    expect(warnings.join(" ")).not.toContain("s3cretDBpass")
  })
})
