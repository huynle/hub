// `hub-server migrate` + `hub-server import` against a real Postgres (HUB_IT_CLUSTER=1, docker; test/cluster-it.ts),
// then a cluster pod (startCentral building its own Postgres + Valkey backends) accepts the imported device and
// machine tokens: nothing re-enrols. A second import changes nothing (jsonb reorders keys: still "same").
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { SQL } from "bun"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { runImport, runMigrate } from "../src/central/main"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { webDir } from "./central-harness"
import { DEVICE_TOKEN, fixtureStateDir, MACHINE_TOKEN, TOKEN_KEYS } from "./import-fixture"

const enabled = itClusterEnabled() && (await dockerAvailable())
const cluster = enabled ? new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) }) : undefined
if (cluster) await Promise.all([cluster.postgres(), cluster.valkey()])
afterAll(async () => {
  await cluster?.stop()
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function lines() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, push: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }
}

async function rows(url: string): Promise<unknown[]> {
  const sql = new SQL(url, { max: 1 })
  try {
    return [...(await sql`SELECT user_id, collection, key, value::text AS value, version FROM hub_state ORDER BY user_id, collection, key`)]
  } finally {
    await sql.close()
  }
}

describe.skipIf(!enabled)("migrate + import into Postgres (HUB_IT_CLUSTER=1)", () => {
  test("migrate is idempotent; import twice is identical; a pod authenticates the imported device and machine", async () => {
    const db = await cluster!.freshDatabase()
    const valkey = await cluster!.freshValkey()
    const dir = await fixtureStateDir()
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const env = { HUB_DATABASE_URL: db }

    // Import before migrate: one clear line that says what to do.
    const early = lines()
    expect(await runImport({ stateDir: dir, dryRun: true, force: false, printTokenKeys: false }, { env, home: "/nonexistent", ...early.push })).toBe(1)
    expect(early.err.join("\n")).toContain("hub-server migrate")

    const first = lines()
    expect(await runMigrate({ env, home: "/nonexistent", ...first.push })).toBe(0)
    expect(first.out.join("\n")).toMatch(/applied 1; schema now at version 1/)
    const again = lines()
    expect(await runMigrate({ env, home: "/nonexistent", ...again.push })).toBe(0)
    expect(again.out.join("\n")).toMatch(/up to date at version 1/)

    const dry = lines()
    expect(await runImport({ stateDir: dir, dryRun: true, force: false, printTokenKeys: false }, { env, home: "/nonexistent", ...dry.push })).toBe(0)
    expect(await rows(db)).toEqual([])

    const imported = lines()
    expect(await runImport({ stateDir: dir, dryRun: false, force: false, printTokenKeys: true }, { env, home: "/nonexistent", ...imported.push })).toBe(0)
    expect(imported.err.join("\n")).toMatch(/users\s+3\s+3\s+0/)
    expect(JSON.parse(imported.out[0]!)).toEqual(TOKEN_KEYS)
    for (const text of [...imported.out, ...imported.err, ...first.out, ...dry.out]) expect(text).not.toContain(new URL(db).password || "\u0001")
    const after = await rows(db)
    expect(after.length).toBeGreaterThan(10)

    const second = lines()
    expect(await runImport({ stateDir: dir, dryRun: false, force: false, printTokenKeys: false }, { env, home: "/nonexistent", ...second.push })).toBe(0)
    expect(second.out.join("\n")).not.toMatch(/Conflicts/)
    expect(second.out.join("\n")).toMatch(/total\s+(\d+)\s+0\s+\1\s+0\s+0\s+0/)
    expect(await rows(db)).toEqual(after)

    // A cluster pod on that database, with the signing keys printed above.
    const config = centralConfig(
      {
        HUB_AUTH: "oidc",
        HUB_OIDC_CLIENT_ID: "cid",
        HUB_OIDC_CLIENT_SECRET: "csecret",
        HUB_OIDC_ALLOWED: "@example.com",
        HUB_ADMIN_EMAILS: "alice@example.com",
        HUB_DATABASE_URL: db,
        HUB_VALKEY_URL: valkey,
        HUB_TOKEN_KEYS: imported.out[0]!,
        HUB_POD_ID: "pod-a",
        HUB_PORT: "0",
        HUB_STATE_DIR: dir,
      },
      "/home/me",
    )
    const pod: Central = startCentral({ config, webDir: webDir() })
    cleanups.push(() => pod.stop())
    await pod.store.ready()
    const me = await fetch(`${pod.url}/api/me`, { headers: { cookie: `voice_device=${DEVICE_TOKEN}` } })
    expect(me.status).toBe(200)
    expect((await fetch(`${pod.url}/api/me`, { headers: { cookie: "voice_device=not-a-token" } })).status).toBe(401)
    const spoke = (token: string) => fetch(`${pod.url}/spoke/ws`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status)
    // Accepted (426: a plain request, not an upgrade) versus refused.
    expect(await spoke(MACHINE_TOKEN)).toBe(426)
    expect(await spoke("not-a-token")).toBe(401)
  }, 60_000)
})
