// Catalog in process memory (a cluster uses one Redis hash per user). Each connection's report of a session is
// kept apart, keyed by (sessionID, connID), and merged when read, so every process writes only its own reports.
// Reports with a ttl expire lazily against the clock.
import type { Catalog, CatalogEntry, CatalogSession, CatalogValue, Clock } from "./types"

/** Combines a session's reports (oldest first) into one value. */
export type CatalogMerge = (entries: CatalogEntry[]) => CatalogValue

/** Default merge: a shallow merge in report order, so the newest report wins per field. */
export const mergeNewestWins: CatalogMerge = (entries) => Object.assign({}, ...entries.map((entry) => entry.value))

interface Report extends CatalogEntry {
  readonly expiresAt?: number
}

const reportKey = (sessionID: string, connID: string) => `${sessionID}\u0000${connID}`

export class MemoryCatalog implements Catalog {
  private readonly now: Clock
  private readonly merge: CatalogMerge
  /** userID → reportKey → report, in report order (a new report moves to the end). */
  private readonly users = new Map<string, Map<string, Report>>()

  constructor(options: { now?: Clock; merge?: CatalogMerge } = {}) {
    this.now = options.now ?? Date.now
    this.merge = options.merge ?? mergeNewestWins
  }

  async set(userID: string, sessionID: string, connID: string, value: CatalogValue, options: { readonly ttlMs?: number } = {}): Promise<void> {
    let reports = this.users.get(userID)
    if (!reports) this.users.set(userID, (reports = new Map()))
    const at = this.now()
    const key = reportKey(sessionID, connID)
    reports.delete(key)
    reports.set(key, { sessionID, connID, value: structuredClone(value), at, ...(options.ttlMs !== undefined ? { expiresAt: at + options.ttlMs } : {}) })
  }

  async delete(userID: string, sessionID: string, connID?: string): Promise<void> {
    this.remove(userID, (report) => report.sessionID === sessionID && (connID === undefined || report.connID === connID))
  }

  async deleteConn(userID: string, connID: string): Promise<void> {
    this.remove(userID, (report) => report.connID === connID)
  }

  async get(userID: string, sessionID: string): Promise<CatalogSession | undefined> {
    const reports = this.live(userID).filter((report) => report.sessionID === sessionID)
    return reports.length ? this.session(sessionID, reports) : undefined
  }

  async list(userID: string): Promise<CatalogSession[]> {
    const bySession = new Map<string, CatalogEntry[]>()
    for (const report of this.live(userID)) {
      const reports = bySession.get(report.sessionID)
      if (reports) reports.push(report)
      else bySession.set(report.sessionID, [report])
    }
    return [...bySession.keys()].sort().map((sessionID) => this.session(sessionID, bySession.get(sessionID)!))
  }

  async entries(userID: string): Promise<CatalogEntry[]> {
    return this.live(userID).map(({ sessionID, connID, value, at }) => ({ sessionID, connID, value: structuredClone(value), at }))
  }

  /** The user's unexpired reports in report order (expired ones are dropped). */
  private live(userID: string): Report[] {
    const reports = this.users.get(userID)
    if (!reports) return []
    const t = this.now()
    for (const [key, report] of reports) if (report.expiresAt !== undefined && report.expiresAt <= t) reports.delete(key)
    if (!reports.size) this.users.delete(userID)
    return [...reports.values()]
  }

  private session(sessionID: string, reports: CatalogEntry[]): CatalogSession {
    return {
      sessionID,
      value: structuredClone(this.merge(reports)),
      connIDs: reports.map((report) => report.connID),
      at: Math.max(...reports.map((report) => report.at)),
    }
  }

  private remove(userID: string, match: (report: Report) => boolean): void {
    const reports = this.users.get(userID)
    if (!reports) return
    for (const [key, report] of reports) if (match(report)) reports.delete(key)
    if (!reports.size) this.users.delete(userID)
  }
}
