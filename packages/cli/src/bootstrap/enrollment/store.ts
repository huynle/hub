// The machine credential store: the spoke's config.json (src/config.ts), the one file every spoke and `hub node` on
// this machine read their identity from. Writes merge into the raw JSON (every key the file holds survives, I4),
// atomically (private temp file + rename) with mode 0600 in a 0700 directory. A symlinked config.json or config
// directory is refused: a machine token must never be written into a dotfiles repository (T23).
import { randomBytes } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"
import { configPath, normalize, prepareConfigPath, readRawConfig, updateRawConfig, type Mode } from "../../../../../src/config.ts"
import type { CredentialStore, MachineCredential } from "../contracts/index.ts"

export type CredentialStoreFailure = "symlink" | "not_object" | "invalid" | "io"

/** Why the store refused or failed. The message names the file and the reason, never a credential. */
export class CredentialStoreError extends Error {
  override readonly name = "CredentialStoreError"
  constructor(
    readonly reason: CredentialStoreFailure,
    message: string,
    /** The errno code of an I/O failure (EACCES, ENOSPC, …). */
    readonly errno?: string,
  ) {
    super(message)
  }
}

/**
 * The spoke's sharing mode in config.json: `unset` when the file has no `mode` key (the spoke then treats it as
 * "off"), else what the spoke reads (a value it does not understand reads as "off").
 */
export type SharingMode = Mode | "unset"

/** The mode an enrollment turns on when the user never chose one: the OpenCode spoke connects only when it is not "off". */
export const DEFAULT_SHARING: Mode = "always"

/** What the file holds, without the credential: `incomplete` is a token without a machine ID (enroll again). */
export type StoreContents = { readonly state: "empty" | "credential" | "incomplete" }

const errnoOf = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code

function ioError(file: string, doing: string, cause: unknown): CredentialStoreError {
  if (cause instanceof CredentialStoreError) return cause
  const errno = errnoOf(cause)
  return new CredentialStoreError("io", `Cannot ${doing} ${file}${errno ? ` (${errno})` : ""}`, errno)
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export class ConfigCredentialStore implements CredentialStore {
  readonly location: string

  constructor(file: string) {
    this.location = file
  }

  /** The raw config object ({} when there is none); throws a CredentialStoreError when it is not a JSON object. */
  private raw(): Record<string, unknown> {
    try {
      return readRawConfig(this.location) ?? {}
    } catch (cause) {
      if (errnoOf(cause)) throw ioError(this.location, "read", cause)
      throw new CredentialStoreError("not_object", `${this.location} is not a JSON object; fix or remove it first`)
    }
  }

  private refuseLinks(): void {
    for (const p of [path.dirname(this.location), this.location]) {
      if (isLink(p)) throw new CredentialStoreError("symlink", `${p} is a symlink; hubctl never writes a machine credential through one (keep config.json out of dotfiles)`)
    }
  }

  /**
   * Checks, before a one-time enrollment code is redeemed, that write() can succeed: no symlink, a JSON object (or
   * no file), and a writable private directory (created 0700 if missing). Leaves no file behind.
   */
  async preflight(): Promise<void> {
    this.refuseLinks()
    this.raw()
    const dir = path.dirname(this.location)
    const probe = path.join(dir, `.${path.basename(this.location)}.${process.pid}.${randomBytes(6).toString("hex")}.probe`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      closeSync(openSync(probe, "wx", 0o600))
    } catch (cause) {
      throw ioError(dir, "write to", cause)
    } finally {
      rmSync(probe, { force: true })
    }
    this.refuseLinks()
  }

  inspect(): StoreContents {
    const config = normalize(this.raw(), hostname())
    if (!config.token) return { state: "empty" }
    return { state: config.machineID ? "credential" : "incomplete" }
  }

  sharingMode(): SharingMode {
    const raw = this.raw()
    return "mode" in raw ? normalize({ mode: raw.mode }, "x").mode : "unset"
  }

  /**
   * Turns sharing on (`mode: "always"`) when config.json has no `mode` at all, so an enrolled machine's spoke
   * connects. An explicit value, "off" included, is the user's and is never changed. True when it wrote.
   */
  enableSharing(): boolean {
    this.refuseLinks()
    if ("mode" in this.raw()) return false
    try {
      updateRawConfig(this.location, (raw) => ("mode" in raw ? raw : { ...raw, mode: DEFAULT_SHARING }))
    } catch (cause) {
      throw ioError(this.location, "write", cause)
    }
    return true
  }

  async read(): Promise<MachineCredential | undefined> {
    const raw = this.raw()
    const config = normalize(raw, hostname())
    if (!config.token || !config.machineID) return undefined
    const machineName = typeof raw.machineName === "string" && raw.machineName ? raw.machineName : undefined
    return { server: config.server, machineID: config.machineID, ...(machineName ? { machineName } : {}), token: config.token }
  }

  async write(credential: MachineCredential): Promise<void> {
    const server = credential.server.replace(/\/+$/, "")
    // normalize() falls back to the default server for a URL it cannot keep; the token must never end up paired with it.
    if (normalize({ server }, "x").server !== server) throw new CredentialStoreError("invalid", `Refusing to store a credential for an unusable server URL`)
    if (!credential.token || !credential.machineID) throw new CredentialStoreError("invalid", "Refusing to store an incomplete credential")
    this.refuseLinks()
    this.raw()
    try {
      updateRawConfig(this.location, (raw) => ({
        ...raw,
        server,
        machineID: credential.machineID,
        ...(credential.machineName ? { machineName: credential.machineName } : {}),
        token: credential.token,
        // An enrolled machine shares by default (the /hub dialog asks; hubctl cannot): only when the user never chose.
        ...("mode" in raw ? {} : { mode: DEFAULT_SHARING }),
      }))
    } catch (cause) {
      throw ioError(this.location, "write", cause)
    }
  }

  async clear(): Promise<void> {
    this.refuseLinks()
    const raw = this.raw()
    if (!("token" in raw) && !("machineID" in raw)) return
    try {
      updateRawConfig(this.location, ({ token: _token, machineID: _machineID, ...rest }) => rest)
    } catch (cause) {
      throw ioError(this.location, "write", cause)
    }
  }
}

/**
 * The machine's credential store: $HUB_SPOKE_CONFIG, else ~/.config/hub/config.json (the file the spoke and
 * `hub node` read). With `migrate` (for enroll), a legacy config is copied to the default location first, as the
 * spoke does; status reads without side effects.
 */
export function credentialStoreFor(env: Readonly<Record<string, string | undefined>>, home: string, options: { migrate?: boolean } = {}): ConfigCredentialStore {
  return new ConfigCredentialStore(options.migrate ? prepareConfigPath(env, home) : configPath(env, home))
}
