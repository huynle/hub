// Postgres schema migrations (decision vkxkqiuf §3, design §10): ordered, recorded in hub_schema, applied under a
// session advisory lock so concurrent `hub-server migrate` runs (or pods) apply each migration exactly once.
// The list checks always run; the database checks need HUB_IT_CLUSTER=1 and docker (test/cluster-it.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { MIGRATION_LOCK_KEY, MIGRATIONS, migrate, SCHEMA_VERSION, schemaVersion, type Migration } from "../src/central/backend/postgres-migrate"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

describe("postgres migrations list", () => {
  test("versions run 1..n without gaps, names are unique, SCHEMA_VERSION is the last", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1))
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length)
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.at(-1)!.version)
    expect(Number.isSafeInteger(MIGRATION_LOCK_KEY)).toBe(true)
  })
})

const enabled = itClusterEnabled() && (await dockerAvailable())
const cluster = enabled ? new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) }) : undefined
const clients: Bun.SQL[] = []
afterAll(async () => {
  await Promise.all(clients.splice(0).map((sql) => sql.close().catch(() => {})))
  await cluster?.stop()
})

/** A client on a fresh database (closed after the file). */
async function freshClient(url?: string): Promise<{ sql: Bun.SQL; url: string }> {
  url ??= await cluster!.freshDatabase()
  const sql = new Bun.SQL(url, { max: 2 })
  clients.push(sql)
  return { sql, url }
}

const tables = async (sql: Bun.SQL) =>
  ((await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`) as { tablename: string }[]).map((r) => r.tablename)

const advisoryLocks = async (sql: Bun.SQL) => ((await sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`) as { n: number }[])[0]!.n

describe.skipIf(!enabled)("postgres migrate (HUB_IT_CLUSTER=1)", () => {
  test("an empty database is at schema version 0", async () => {
    const { sql } = await freshClient()
    expect(await schemaVersion(sql)).toBe(0)
  })

  test("migrate applies every migration once, records them and releases the lock", async () => {
    const { sql } = await freshClient()
    expect(await migrate(sql)).toEqual({ applied: MIGRATIONS.map((m) => m.version), version: SCHEMA_VERSION })
    expect(await schemaVersion(sql)).toBe(SCHEMA_VERSION)
    expect(await tables(sql)).toEqual(["hub_claims", "hub_schema", "hub_state"])
    expect(await advisoryLocks(sql)).toBe(0)
    expect(await migrate(sql)).toEqual({ applied: [], version: SCHEMA_VERSION })
  })

  test("concurrent migrations from separate clients apply each version exactly once", async () => {
    const { url } = await freshClient()
    const runners = await Promise.all([1, 2, 3, 4].map(() => freshClient(url)))
    const results = await Promise.all(runners.map(({ sql }) => migrate(sql)))
    expect(results.flatMap((r) => r.applied).sort((a, b) => a - b)).toEqual(MIGRATIONS.map((m) => m.version))
    for (const r of results) expect(r.version).toBe(SCHEMA_VERSION)
    const rows = (await runners[0]!.sql`SELECT version FROM hub_schema ORDER BY version`) as { version: number }[]
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version))
  })

  test("a failing migration rolls back alone, keeps earlier ones and releases the lock", async () => {
    const { sql } = await freshClient()
    const migrations: Migration[] = [
      { version: 1, name: "one", up: "CREATE TABLE one (a int)" },
      { version: 2, name: "broken", up: "CREATE TABLE two (a int); SELECT no_such_function()" },
    ]
    await expect(migrate(sql, { migrations })).rejects.toThrow(/migration 2 \(broken\) failed/)
    expect(await schemaVersion(sql)).toBe(1)
    expect(await tables(sql)).toEqual(["hub_schema", "one"])
    expect(await advisoryLocks(sql)).toBe(0)
    const fixed: Migration[] = [migrations[0]!, { version: 2, name: "broken", up: "CREATE TABLE two (a int)" }]
    expect(await migrate(sql, { migrations: fixed })).toEqual({ applied: [2], version: 2 })
  })

  test("a database newer than the code is left alone (the previous release keeps running)", async () => {
    const { sql } = await freshClient()
    await migrate(sql)
    expect(await migrate(sql, { migrations: MIGRATIONS.slice(0, 1) })).toEqual({ applied: [], version: SCHEMA_VERSION })
  })
})
