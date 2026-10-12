// TUI presence on the spoke: which sessions an OpenCode TUI shows (its route and open tabs), reported over
// RPC voice.presence on change and every 15 s. A session is open while some TUI reported it within the
// window. Each TUI's report replaces its previous one, so a closed tab stops counting at once.
export const TUI_PRESENCE_WINDOW_MS = 45_000
/** Sessions taken from one report, and TUIs remembered. */
const REPORT_MAX = 200
const REPORTERS_MAX = 100
const SESSION_ID = /^ses[A-Za-z0-9_-]{1,200}$/

export class PresenceBook {
  /** reporter → its sessions and when it reported them. Anonymous reports keep a time per session. */
  private readonly byReporter = new Map<string, { at: number; sessions: Set<string> }>()
  private readonly anonymous = new Map<string, number>()

  report(sessionIDs: readonly string[], now: number, reporter?: string): void {
    const ids = [...new Set(sessionIDs.filter((id) => typeof id === "string" && SESSION_ID.test(id)))].slice(0, REPORT_MAX)
    if (!reporter) {
      for (const id of ids) this.anonymous.set(id, now)
      this.prune(now)
      return
    }
    this.byReporter.delete(reporter)
    this.byReporter.set(reporter, { at: now, sessions: new Set(ids) })
    this.prune(now)
  }

  /** Sessions some TUI reported within the window. */
  open(now: number): Set<string> {
    const out = new Set<string>()
    for (const { at, sessions } of this.byReporter.values()) if (now - at < TUI_PRESENCE_WINDOW_MS) for (const id of sessions) out.add(id)
    for (const [id, at] of this.anonymous) if (now - at < TUI_PRESENCE_WINDOW_MS) out.add(id)
    return out
  }

  reporters(): number {
    return this.byReporter.size
  }

  private prune(now: number): void {
    for (const [key, entry] of this.byReporter) if (now - entry.at >= TUI_PRESENCE_WINDOW_MS) this.byReporter.delete(key)
    while (this.byReporter.size > REPORTERS_MAX) this.byReporter.delete(this.byReporter.keys().next().value!)
    for (const [id, at] of this.anonymous) if (now - at >= TUI_PRESENCE_WINDOW_MS) this.anonymous.delete(id)
    while (this.anonymous.size > REPORT_MAX) this.anonymous.delete(this.anonymous.keys().next().value!)
  }
}
