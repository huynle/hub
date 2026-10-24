// HMAC signing keys for hub-minted session tokens, kept apart from state.json in `<stateDir>/token-keys.json`
// (mode 0600, written atomically): {active: kid, keys: [{kid, secret (base64 of 32 random bytes), created}]}.
// The file is created on first use. rotate() adds a new active key and keeps the older ones so tokens they
// signed still verify. HUB_TOKEN_KEYS (same JSON shape) overrides the file, e.g. a Kubernetes secret shared by
// several pods; the file is then never written and rotation happens where the secret is managed.
// Secrets never appear in errors, logs, JSON or inspect output.
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export const TOKEN_KEYS_FILE = "token-keys.json"
export const TOKEN_KEYS_ENV = "HUB_TOKEN_KEYS"
/** Bytes of a signing secret. */
export const TOKEN_KEY_BYTES = 32

export interface StoredTokenKey {
  kid: string
  /** Base64 of TOKEN_KEY_BYTES random bytes. */
  secret: string
  created: number
}

export interface TokenKeyFile {
  active: string
  keys: StoredTokenKey[]
}

export interface TokenKeysOptions {
  readonly now?: () => number
  /** Environment for the HUB_TOKEN_KEYS override (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

interface Key {
  kid: string
  secret: Buffer
  created: number
}

const newKid = (): string => `k_${randomBytes(6).toString("base64url")}`

/** Parsed and validated key data; `source` names the origin in errors (never the content). */
function parseKeys(text: string, source: string): { active: string; keys: Key[] } {
  const fail = (why: string): never => {
    throw new Error(`Invalid ${source}: ${why}. Fix or move it away.`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail("not valid JSON")
  }
  if (typeof raw !== "object" || raw === null) return fail("not an object")
  const { active, keys } = raw as Record<string, unknown>
  if (typeof active !== "string" || !Array.isArray(keys)) return fail("expected {active, keys: [...]}")
  const out: Key[] = []
  for (const entry of keys as unknown[]) {
    const { kid, secret, created } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>
    if (typeof kid !== "string" || !kid) return fail("a key has no kid")
    if (out.some((key) => key.kid === kid)) return fail(`duplicate kid ${kid}`)
    const bytes = typeof secret === "string" ? Buffer.from(secret, "base64") : Buffer.alloc(0)
    if (typeof secret !== "string" || bytes.toString("base64") !== secret || bytes.length < TOKEN_KEY_BYTES) {
      return fail(`key ${kid} needs a base64 secret of at least ${TOKEN_KEY_BYTES} bytes`)
    }
    out.push({ kid, secret: bytes, created: typeof created === "number" ? created : 0 })
  }
  if (!out.some((key) => key.kid === active)) return fail("the active kid is not among the keys")
  return { active, keys: out }
}

export class TokenKeys {
  #active = ""
  #keys: Key[] = []
  #loaded = false

  private constructor(
    private readonly file: string,
    private readonly now: () => number,
    private readonly override: string | undefined,
  ) {}

  /** Nothing is read or written until a key is needed. */
  static open(dir: string, options: TokenKeysOptions = {}): TokenKeys {
    const env = options.env ?? process.env
    const override = env[TOKEN_KEYS_ENV]?.trim() || undefined
    return new TokenKeys(path.join(dir, TOKEN_KEYS_FILE), options.now ?? Date.now, override)
  }

  /** The key new tokens are signed with (created on first use). */
  active(): { kid: string; secret: Buffer } {
    this.load()
    const key = this.#keys.find((k) => k.kid === this.#active)!
    return { kid: key.kid, secret: Buffer.from(key.secret) }
  }

  /** The secret for a kid, to verify a token; undefined when unknown. */
  key(kid: string): Buffer | undefined {
    this.load()
    const key = this.#keys.find((k) => k.kid === kid)
    return key ? Buffer.from(key.secret) : undefined
  }

  /** Every kid, oldest first. */
  kids(): string[] {
    this.load()
    return this.#keys.map((k) => k.kid)
  }

  /** Adds a new active key, keeping the previous ones for verification. Returns its kid. */
  rotate(): string {
    if (this.override) throw new Error(`Signing keys come from ${TOKEN_KEYS_ENV}; rotate them where that is managed`)
    this.load(false)
    let kid = newKid()
    while (this.#keys.some((k) => k.kid === kid)) kid = newKid()
    this.#keys.push({ kid, secret: randomBytes(TOKEN_KEY_BYTES), created: this.now() })
    this.#active = kid
    this.save()
    return kid
  }

  toJSON(): { file: string; active: string; kids: string[] } {
    return { file: this.file, active: this.#active, kids: this.#keys.map((k) => k.kid) }
  }

  toString(): string {
    return `TokenKeys(${this.override ? TOKEN_KEYS_ENV : this.file})`
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString()
  }

  /** Reads the keys once; with `create`, a missing file gets its first key. */
  private load(create = true): void {
    if (this.#loaded) return
    if (this.override) {
      this.set(parseKeys(this.override, TOKEN_KEYS_ENV))
      return
    }
    if (existsSync(this.file)) {
      this.set(parseKeys(readFileSync(this.file, "utf8"), this.file))
      return
    }
    this.#loaded = true
    if (create) this.rotate()
  }

  private set(data: { active: string; keys: Key[] }): void {
    this.#active = data.active
    this.#keys = data.keys
    this.#loaded = true
  }

  private save(): void {
    const data: TokenKeyFile = {
      active: this.#active,
      keys: this.#keys.map((k) => ({ kid: k.kid, secret: k.secret.toString("base64"), created: k.created })),
    }
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
