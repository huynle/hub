// Postgres schema for cluster mode (decision vkxkqiuf §3, design §10). Migrations are ordered, recorded in
// hub_schema and applied by `hub-server migrate` (a Job) under a session advisory lock, so concurrent runs apply
// each one exactly once; each runs in its own transaction. A database newer than the code is left alone: every
// schema must keep working with the previous release. Nothing here names the database URL.
import type { SQL } from "bun"

export interface Migration {
  /** 1, 2, 3… in order. */
  readonly version: number
  readonly name: string
  /** SQL statements, run in one transaction. */
  readonly up: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "state-and-claims",
    up: `
      CREATE TABLE hub_state (
        user_id text COLLATE "C" NOT NULL,
        collection text COLLATE "C" NOT NULL,
        key text COLLATE "C" NOT NULL,
        value jsonb NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, collection, key)
      );
      CREATE TABLE hub_claims (
        namespace text COLLATE "C" NOT NULL,
        key text COLLATE "C" NOT NULL,
        owner text NOT NULL,
        at bigint NOT NULL,
        PRIMARY KEY (namespace, key)
      );
    `,
  },
]

/** The schema version this code needs. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0

/** pg_advisory_lock key of the migrations ("hubsch" in ASCII). */
export const MIGRATION_LOCK_KEY = 0x6875_6273_6368

const SCHEMA_TABLE = `
  CREATE TABLE IF NOT EXISTS hub_schema (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`

/** The database's schema version: the latest applied migration (0 before the first). */
export async function schemaVersion(sql: SQL): Promise<number> {
  const [exists] = (await sql`SELECT to_regclass('public.hub_schema') IS NOT NULL AS ok`) as { ok: boolean }[]
  if (!exists?.ok) return 0
  const [row] = (await sql`SELECT coalesce(max(version), 0)::int AS version FROM hub_schema`) as { version: number }[]
  return row?.version ?? 0
}

export interface MigrateResult {
  /** The versions this run applied (empty when another run or an earlier one did). */
  readonly applied: number[]
  /** The schema version afterwards. */
  readonly version: number
}

/** Applies the pending migrations under the advisory lock; idempotent and safe to run concurrently. */
export async function migrate(sql: SQL, options: { readonly migrations?: readonly Migration[] } = {}): Promise<MigrateResult> {
  const migrations = options.migrations ?? MIGRATIONS
  const conn = await sql.reserve()
  try {
    await conn`SELECT pg_advisory_lock(${String(MIGRATION_LOCK_KEY)}::bigint)`
    try {
      await conn.unsafe(SCHEMA_TABLE)
      const done = new Set(((await conn`SELECT version FROM hub_schema`) as { version: number }[]).map((r) => r.version))
      const applied: number[] = []
      for (const migration of migrations) {
        if (done.has(migration.version)) continue
        // BEGIN/COMMIT by hand: Bun 1.3.5's reserved-connection begin() also leaves the failure unhandled.
        await conn.unsafe("BEGIN")
        try {
          await conn.unsafe(migration.up)
          await conn`INSERT INTO hub_schema (version, name) VALUES (${migration.version}, ${migration.name})`
          await conn.unsafe("COMMIT")
        } catch (error) {
          await conn.unsafe("ROLLBACK").catch(() => {})
          throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`, { cause: error })
        }
        applied.push(migration.version)
      }
      return { applied, version: await schemaVersion(conn) }
    } finally {
      await conn`SELECT pg_advisory_unlock(${String(MIGRATION_LOCK_KEY)}::bigint)`
    }
  } finally {
    conn.release()
  }
}
