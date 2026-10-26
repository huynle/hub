// Which hub and token the CLI uses: HUB_URL + HUB_SESSION_TOKEN (a session's identity, set by the spoke in its
// shells) win; else the login file written by `hub login` ($XDG_CONFIG_HOME or ~/.config, then hub/cli.json,
// mode 0600) with an app token.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Fetch } from "../../sdk/src/index.ts"

export type Env = Record<string, string | undefined>

export interface Credentials {
  readonly url: string
  readonly token: string
  /** env: HUB_URL + HUB_SESSION_TOKEN; login: the login file; http: the caller of the hub's POST /mcp. */
  readonly source: "env" | "login" | "http"
  /** How to reach the hub (default: the global fetch); POST /mcp dispatches in process. */
  readonly fetch?: Fetch
}

export interface Login {
  readonly url: string
  readonly token: string
}

export const loginFile = (env: Env, home: string): string => path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "hub", "cli.json")

export function readLogin(file: string): Login | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(raw) as Partial<Login>
    if (typeof value.url === "string" && value.url && typeof value.token === "string" && value.token) return { url: value.url, token: value.token }
  } catch {
    // unreadable: treated as logged out
  }
  return undefined
}

/** Writes the login file, owner-only (0600; its directory 0700 when created). */
export function writeLogin(file: string, login: Login): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify({ url: login.url, token: login.token }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Deletes the login file; true when there was one. */
export function removeLogin(file: string): boolean {
  try {
    readFileSync(file)
  } catch {
    return false
  }
  rmSync(file, { force: true })
  return true
}

export function resolveCredentials(env: Env, home: string): Credentials | undefined {
  if (env.HUB_URL && env.HUB_SESSION_TOKEN) return { url: env.HUB_URL, token: env.HUB_SESSION_TOKEN, source: "env" }
  const login = readLogin(loginFile(env, home))
  return login ? { ...login, source: "login" } : undefined
}
