import { createHmac, timingSafeEqual } from "node:crypto"
import type { DirectoryEntry } from "./directory"
import { AgentError } from "./errors"

const PREFIX = "hai1_"
const DOMAIN = "hub-archive-inactive/v1"
const TTL_MS = 5 * 60_000
const invalid = () => new AgentError("invalid", "This inactive-archive preview is invalid or expired; preview again")

interface Payload { readonly userID: string; readonly at: number; readonly inactiveForMs: number; readonly candidates: readonly string[] }
export interface ArchiveSets { readonly pinned: ReadonlySet<string>; readonly archived: ReadonlySet<string> }
export type SkipReason = "active" | "pinned" | "open" | "archived" | "not_found"

export class ArchiveInactive {
  constructor(private readonly options: { readonly secret: Buffer; readonly now?: () => number }) {}
  private now() { return (this.options.now ?? Date.now)() }

  preview(userID: string, sessions: readonly DirectoryEntry[], options: ArchiveSets & { readonly inactiveForMs: number; readonly limit: number }) {
    const candidates = sessions
      .filter((s) => !s.online && typeof s.lastSeen === "number" && this.now() - s.lastSeen >= options.inactiveForMs && !options.pinned.has(s.sessionID) && !options.archived.has(s.sessionID))
      .map((s) => s.sessionID).slice(0, options.limit)
    const payload: Payload = { userID, at: this.now(), inactiveForMs: options.inactiveForMs, candidates }
    return { candidates, previewToken: this.encode(payload), expiresAt: payload.at + TTL_MS }
  }

  decode(userID: string, token: string): Payload {
    if (!token.startsWith(PREFIX) || token.length > 10_000) throw invalid()
    const [body, tag, ...rest] = token.slice(PREFIX.length).split(".")
    if (rest.length || !body || !tag) throw invalid()
    const expected = createHmac("sha256", this.options.secret).update(`${DOMAIN}\n${body}`).digest().subarray(0, 16)
    const given = Buffer.from(tag, "base64url")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid()
    let payload: Payload
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload } catch { throw invalid() }
    if (payload.userID !== userID || !Array.isArray(payload.candidates) || this.now() - payload.at > TTL_MS) throw invalid()
    return payload
  }

  revalidate(userID: string, token: string, sessions: readonly DirectoryEntry[], options: ArchiveSets & { readonly open: ReadonlySet<string>; readonly active: ReadonlySet<string> }) {
    const payload = this.decode(userID, token)
    const byID = new Map(sessions.map((s) => [s.sessionID, s]))
    const candidates: string[] = []
    const skipped: Array<{ sessionID: string; reason: SkipReason }> = []
    for (const sessionID of payload.candidates) {
      const s = byID.get(sessionID)
      const reason: SkipReason | undefined = !s ? "not_found" : options.archived.has(sessionID) ? "archived" : options.pinned.has(sessionID) ? "pinned" : options.open.has(sessionID) ? "open" : options.active.has(sessionID) || s.online ? "active" : undefined
      if (reason) skipped.push({ sessionID, reason }); else candidates.push(sessionID)
    }
    return { candidates, skipped }
  }

  private encode(payload: Payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const tag = createHmac("sha256", this.options.secret).update(`${DOMAIN}\n${body}`).digest().subarray(0, 16).toString("base64url")
    return `${PREFIX}${body}.${tag}`
  }
}

export function parseInactiveFor(value: unknown): number {
  if (typeof value !== "string") throw new AgentError("invalid", "inactiveFor must be a duration such as 7d")
  const m = /^(\d+)(h|d)$/.exec(value)
  if (!m) throw new AgentError("invalid", "inactiveFor must be a duration such as 7d")
  const ms = Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)
  if (ms < 3_600_000 || ms > 365 * 86_400_000) throw new AgentError("invalid", "inactiveFor must be from 1h to 365d")
  return ms
}
