// Types for web/view-core.js (plain ES module used by the PWA without a build step).
import type { Blocker, BrowserSession, SessionState } from "./browser-core.js"

export type PrefList = "hiddenSessions" | "hiddenWorkspaces" | "pinnedSessions" | "pinnedWorkspaces"
export type ViewPrefs = Record<PrefList, string[]>

export const PREF_LISTS: PrefList[]
export function normalizePrefs(raw: unknown): ViewPrefs
export function setPref(prefs: ViewPrefs, list: PrefList, key: string, on: boolean): { prefs: ViewPrefs; patch?: Partial<ViewPrefs> }
export function migratePins(rawSessions: string | null | undefined, rawWorkspaces: string | null | undefined, prefs: ViewPrefs): { clear: boolean; patch?: Partial<ViewPrefs> }

export interface TerminalInfo {
  readonly source: "herdr" | "tui"
  readonly workspaceID?: string
  readonly workspace?: string
  readonly title?: string
  readonly status?: "idle" | "working" | "blocked" | "done" | "unknown"
}
export interface HerdrWorkspace {
  readonly id: string
  readonly label: string
  readonly directories: readonly string[]
}
export interface ViewSession extends BrowserSession {
  readonly open?: boolean
  readonly terminal?: TerminalInfo
}
export interface ViewMachine {
  id: string
  name: string
  online?: boolean
  lastSeen?: number
  processes: Array<{ id: string; kind: string; directory: string; pid: number; sessions: ViewSession[] }>
  terminals?: { herdr?: { workspaces: HerdrWorkspace[] } }
}

export interface ViewRow extends ViewSession {
  readonly title: string
  readonly updated: number
  readonly state: SessionState
  readonly blockers: Blocker[]
  readonly exposed: boolean
  readonly pinned: boolean
  readonly nowText?: string
  /** Project name plus the path inside it ("api-server › .worktrees/feat-auth"). */
  readonly where: string
  /** Herdr workspace label, else project name. */
  readonly workspace: string
  readonly machineID: string
}
export interface OpenGroup {
  readonly key: string
  readonly kind: "herdr" | "folder"
  readonly name: string
  readonly workspaceID?: string
  /** Default folder for a new session in this group. */
  readonly directory: string
  readonly order: number
  readonly rows: ViewRow[]
  readonly state: SessionState
  readonly updated: number
  readonly pinned: boolean
}
export interface MachineHome {
  readonly id: string
  readonly name: string
  readonly online: boolean
  readonly lastSeen?: number
  readonly herdr: boolean
  readonly open: { readonly groups: OpenGroup[]; readonly background: ViewRow[] }
}
export interface HomeView {
  readonly now: number
  readonly needs: ViewRow[]
  readonly counts: { readonly open: number; readonly recent: number; readonly hidden: number }
  readonly machines: MachineHome[]
}
export interface HiddenView {
  readonly workspaces: Array<{ readonly key: string; readonly name: string; readonly count: number }>
  readonly sessions: ViewRow[]
  /** Hidden session IDs no machine reports right now. */
  readonly unknown: number
}

export function dotState(s: ViewSession): SessionState
export function folderKey(s: ViewSession): string
export function groupKey(s: ViewSession): string
export function homeView(machines: ViewMachine[], prefs: ViewPrefs, options?: { now?: number }): HomeView
export function recentMachine<M extends ViewMachine>(machine: M, prefs: ViewPrefs): M
export function hiddenView(machines: ViewMachine[], prefs: ViewPrefs): HiddenView

export interface NewSessionTarget {
  readonly kind: "herdr" | "folder"
  /** Same as the Open tab's group key (`herdr:<id>` or the folder). */
  readonly key: string
  readonly workspaceID?: string
  readonly label: string
  readonly directories: string[]
}
export function newSessionTargets(machine: ViewMachine): { herdr: boolean; targets: NewSessionTarget[] }
export function createBody(options: { target?: NewSessionTarget; directory: string; title?: string; openInHerdr?: boolean }): {
  directory: string
  title?: string
  herdrWorkspace?: string
}
