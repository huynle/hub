// Types for web/browser-core.js (plain ES module used by the PWA without a build step).

export type SessionState = "blocked" | "working" | "error" | "idle"
export type FilterID = "all" | "active" | "needs" | "today" | "voice" | "enabled"

export const UNTITLED: "Untitled"
export const FILTERS: Array<[FilterID, string]>

export interface Blocker {
  readonly id: string
  readonly kind: string
  readonly summary: string
  readonly sessionID?: string
  readonly sessionTitle?: string
}

/** Catalog session as sent by the hub (fields the browser reads; anything else passes through). */
export interface BrowserSession {
  readonly id: string
  readonly title?: string
  readonly directory: string
  readonly parentID?: string
  readonly updated?: number
  readonly exposed?: boolean
  readonly project?: string
  readonly projectName?: string
  readonly now?: { readonly kind: "tool" | "thinking" | string; readonly tool?: string; readonly summary?: string }
  readonly state?: string
  readonly blockers?: readonly Blocker[]
  readonly status?: ReadonlyArray<{ readonly id: string; readonly title?: string; readonly state: string; readonly blockers?: readonly Blocker[] }>
  readonly busy?: boolean
  readonly conversation?: boolean
  readonly [key: string]: unknown
}

export interface Row extends BrowserSession {
  readonly title: string
  readonly updated: number
  readonly state: SessionState
  readonly blockers: Blocker[]
  readonly exposed: boolean
  readonly pinned: boolean
  readonly nowText?: string
}

export interface NestedGroup {
  readonly key: string
  readonly dir: string
  /** Path relative to the workspace root, or the full directory when outside it. */
  readonly rel: string
  readonly rows: Row[]
  readonly count: number
  readonly state: SessionState
  readonly updated: number
  readonly pinned: boolean
}

export interface WorkspaceGroup {
  readonly key: string
  readonly root: string
  readonly name: string
  /** Sessions in the root directory itself. */
  readonly rows: Row[]
  readonly nested: NestedGroup[]
  readonly count: number
  readonly state: SessionState
  readonly updated: number
  readonly pinned: boolean
}

export interface MachineView {
  readonly id: string
  readonly name: string
  readonly online: boolean
  readonly lastSeen?: number
  readonly hasService: boolean
  /** Root sessions on the machine (deduped). */
  readonly total: number
  /** Of those, how many pass the query and filter. */
  readonly shown: number
  readonly pinned: Row[]
  readonly needs: Row[]
  readonly active: Row[]
  readonly workspaces: WorkspaceGroup[]
  readonly standalone: Array<{ readonly id: string; readonly pid: number; readonly directory: string; readonly rows: Row[] }>
}

export interface Pins {
  readonly sessions: ReadonlySet<string>
  readonly workspaces: ReadonlySet<string>
}

export function sessionState(s: BrowserSession): SessionState
export function blockersOf(s: BrowserSession): Blocker[]
export function aggregateState(states: Iterable<string>): SessionState
export function nowLabel(now: BrowserSession["now"]): string | undefined
export function fold(text: unknown): string
export function matches(s: BrowserSession, query: string): boolean
export function highlight(text: string, query: string): Array<{ text: string; hit: boolean }>
export function passesFilter(s: BrowserSession, filter: FilterID | string, now?: number): boolean
export function parseSet(raw: string | null | undefined): Set<string>
export function toggleIn(set: ReadonlySet<string>, id: string): Set<string>
export function relativeDir(dir: string, root: string): string
export function machineView(
  machine: { id: string; name: string; online?: boolean; lastSeen?: number; processes: Array<{ id: string; kind: string; directory: string; pid: number; sessions: BrowserSession[] }> },
  options?: { query?: string; filter?: FilterID | string; pins?: Pins; now?: number },
): MachineView
export function page<T>(rows: T[], limit: number): { rows: T[]; more: number }
export function parseChoices(raw: string | null | undefined): Map<string, boolean>
export function groupOpen(
  group: { key: string; state: string; updated?: number; pinned?: boolean },
  choices: ReadonlyMap<string, boolean> | undefined,
  options?: { query?: string; now?: number },
): boolean
