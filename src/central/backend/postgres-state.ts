// StateStore in Postgres (cluster mode; decision vkxkqiuf §3). Entries live in one jsonb table, hub_state
// (user_id, collection, key, value, version); unique claims in hub_claims with the primary key as the unique
// constraint. Versions change in single statements, so concurrent pods never lose a write:
// - put without ifVersion: an upsert that bumps the version
// - put with ifVersion 0: INSERT … ON CONFLICT DO NOTHING
// - put with ifVersion n: UPDATE … WHERE version = n (a concurrent writer re-checks the row it waited for)
// and a refused write reports the version read right after. The client connects on first use (the hub builds its
// backends synchronously) and first checks the schema (see ./postgres-migrate), or applies it with `migrate`.
// The URL holds credentials: it stays in a private field and is never put in a message.
import { SQL } from "bun"
import { migrate, SCHEMA_VERSION, schemaVersion } from "./postgres-migrate"
import type { Claim, ClaimResult, Clock, Data, Entry, StateStore, Versioned, WriteOptions, WriteResult } from "./types"

export interface PostgresStateStoreOptions {
  /** postgres:// or postgresql:// (with credentials). */
  readonly url: string
  readonly now?: Clock
  /** Apply pending migrations on first use (default false: they must have run, `hub-server migrate`). */
  readonly migrate?: boolean
  /** Pool size (default 10). */
  readonly max?: number
  /** Seconds to wait for a connection (default Bun's). */
  readonly connectionTimeoutSeconds?: number
}

/** The database is behind the schema this hub needs. The message names no URL. */
export class SchemaOutdatedError extends Error {
  constructor(readonly found: number, readonly needed: number) {
    super(`The Postgres schema is at version ${found}, this hub needs ${needed}: run \`hub-server migrate\``)
    this.name = "SchemaOutdatedError"
  }
}

/** Attempts of a conditional write whose row changed between the write and the version read. */
const RACE_RETRIES = 8

interface Row {
  value: string
  version: number
}

interface ClaimRow {
  owner: string
  at: number
}

export class PostgresStateStore implements StateStore {
  readonly #url: string
  readonly #options: Omit<PostgresStateStoreOptions, "url">
  readonly #now: Clock
  #sql?: SQL
  #ready?: Promise<void>

  constructor(options: PostgresStateStoreOptions) {
    const { url, ...rest } = options
    this.#url = url
    this.#options = rest
    this.#now = options.now ?? Date.now
  }

  async get<T = Data>(userID: string, collection: string, key: string): Promise<Versioned<T> | undefined> {
    const sql = await this.#client()
    const [row] = (await sql`
      SELECT value::text AS value, version FROM hub_state
      WHERE user_id = ${userID} AND collection = ${collection} AND key = ${key}`) as Row[]
    return row && { value: JSON.parse(row.value) as T, version: row.version }
  }

  async put<T = Data>(userID: string, collection: string, key: string, value: T, options: WriteOptions = {}): Promise<WriteResult> {
    const sql = await this.#client()
    const json = JSON.stringify(value ?? null)
    const expected = options.ifVersion
    if (expected === undefined) {
      const [row] = (await sql`
        INSERT INTO hub_state (user_id, collection, key, value, version)
        VALUES (${userID}, ${collection}, ${key}, (${json}::text)::jsonb, 1)
        ON CONFLICT (user_id, collection, key)
        DO UPDATE SET value = EXCLUDED.value, version = hub_state.version + 1, updated_at = now()
        RETURNING version`) as { version: number }[]
      return { ok: true, version: row!.version }
    }
    for (let attempt = 0; ; attempt++) {
      const rows = (expected === 0
        ? await sql`
            INSERT INTO hub_state (user_id, collection, key, value, version)
            VALUES (${userID}, ${collection}, ${key}, (${json}::text)::jsonb, 1)
            ON CONFLICT (user_id, collection, key) DO NOTHING
            RETURNING version`
        : await sql`
            UPDATE hub_state SET value = (${json}::text)::jsonb, version = version + 1, updated_at = now()
            WHERE user_id = ${userID} AND collection = ${collection} AND key = ${key} AND version = ${expected}
            RETURNING version`) as { version: number }[]
      if (rows[0]) return { ok: true, version: rows[0].version }
      const current = await this.#version(sql, userID, collection, key)
      // The row changed back to the expected version in between (deleted and recreated): try again.
      if (current !== expected || attempt >= RACE_RETRIES) return { ok: false, version: current }
    }
  }

  async delete(userID: string, collection: string, key: string, options: WriteOptions = {}): Promise<WriteResult> {
    const sql = await this.#client()
    const expected = options.ifVersion
    if (expected === undefined) {
      await sql`DELETE FROM hub_state WHERE user_id = ${userID} AND collection = ${collection} AND key = ${key}`
      return { ok: true, version: 0 }
    }
    for (let attempt = 0; ; attempt++) {
      if (expected !== 0) {
        const rows = await sql`
          DELETE FROM hub_state
          WHERE user_id = ${userID} AND collection = ${collection} AND key = ${key} AND version = ${expected}
          RETURNING version`
        if (rows.length) return { ok: true, version: 0 }
      }
      const current = await this.#version(sql, userID, collection, key)
      if (expected === 0 && current === 0) return { ok: true, version: 0 }
      if (current !== expected || attempt >= RACE_RETRIES) return { ok: false, version: current }
    }
  }

  async list<T = Data>(userID: string, collection: string): Promise<Entry<T>[]> {
    const sql = await this.#client()
    const rows = (await sql`
      SELECT key, value::text AS value, version FROM hub_state
      WHERE user_id = ${userID} AND collection = ${collection}`) as (Row & { key: string })[]
    // Sorted here, by UTF-16 code units like the other stores (not by a database collation).
    return rows
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T, version: row.version }))
  }

  async claim(namespace: string, key: string, owner: string): Promise<ClaimResult> {
    const sql = await this.#client()
    for (let attempt = 0; ; attempt++) {
      const [inserted] = (await sql`
        INSERT INTO hub_claims (namespace, key, owner, at) VALUES (${namespace}, ${key}, ${owner}, ${this.#now()})
        ON CONFLICT (namespace, key) DO NOTHING
        RETURNING owner, at::float8 AS at`) as ClaimRow[]
      if (inserted) return { ok: true, claim: { namespace, key, owner: inserted.owner, at: inserted.at } }
      const held = await this.claimOf(namespace, key)
      if (held) return held.owner === owner ? { ok: true, claim: held } : { ok: false, conflict: held }
      // Released in between: claim again.
      if (attempt >= RACE_RETRIES) throw new Error(`claim ${namespace}/${key} kept changing; try again`)
    }
  }

  async release(namespace: string, key: string, owner: string): Promise<boolean> {
    const sql = await this.#client()
    const rows = await sql`DELETE FROM hub_claims WHERE namespace = ${namespace} AND key = ${key} AND owner = ${owner} RETURNING owner`
    return rows.length > 0
  }

  async claimOf(namespace: string, key: string): Promise<Claim | undefined> {
    const sql = await this.#client()
    const [row] = (await sql`SELECT owner, at::float8 AS at FROM hub_claims WHERE namespace = ${namespace} AND key = ${key}`) as ClaimRow[]
    return row && { namespace, key, owner: row.owner, at: row.at }
  }

  /** Closes the connection pool (a later call opens a new one). */
  async close(): Promise<void> {
    const sql = this.#sql
    this.#sql = undefined
    this.#ready = undefined
    await sql?.close()
  }

  async #version(sql: SQL, userID: string, collection: string, key: string): Promise<number> {
    const [row] = (await sql`
      SELECT version FROM hub_state WHERE user_id = ${userID} AND collection = ${collection} AND key = ${key}`) as { version: number }[]
    return row?.version ?? 0
  }

  /** The pool, created on first use, once the schema is current; a failed check is retried by the next call. */
  async #client(): Promise<SQL> {
    const sql = (this.#sql ??= new SQL(this.#url, {
      max: this.#options.max ?? 10,
      ...(this.#options.connectionTimeoutSeconds !== undefined ? { connectionTimeout: this.#options.connectionTimeoutSeconds } : {}),
    }))
    this.#ready ??= this.#checkSchema(sql).catch((error: unknown) => {
      this.#ready = undefined
      throw error
    })
    await this.#ready
    return sql
  }

  async #checkSchema(sql: SQL): Promise<void> {
    const version = this.#options.migrate ? (await migrate(sql)).version : await schemaVersion(sql)
    if (version < SCHEMA_VERSION) throw new SchemaOutdatedError(version, SCHEMA_VERSION)
  }
}
