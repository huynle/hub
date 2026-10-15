// Environments for new sessions (the signed-in user's machines, Claude Code style), the remembered
// environment + folder, folder search for /new, and the session rail's collapsible cards. Pure logic (bun
// tests in test/web-environment-core.test.ts); storage is passed in.
import { fold } from "./browser-core"
import type { NewSessionTarget, ViewMachine } from "./view-core"

/** A catalog machine (processes may carry the OpenCode version the spoke reported). */
export type EnvMachine = ViewMachine

export interface Environment {
  readonly id: string
  readonly name: string
  readonly online: boolean
  /** Offline machines are listed but cannot be picked. */
  readonly disabled: boolean
  /** "background service · OpenCode 2.0.26", or "offline". */
  readonly detail: string
  /** The machine reports Herdr ("Open in Herdr tab"). */
  readonly herdr: boolean
  /** A background service is connected: only it creates sessions. */
  readonly canCreate: boolean
}

const KIND_LABEL: Record<string, string> = { service: "background service", standalone: "standalone" }

/** Online machines first (by name), then offline ones (disabled). */
export function environments(machines: readonly EnvMachine[] | undefined): Environment[] {
  const list = (machines ?? []).map((m): Environment => {
    const online = !!m.online
    const main = m.processes.find((p) => p.kind === "service") ?? m.processes[0]
    const detail = !online
      ? "offline"
      : main
        ? [KIND_LABEL[main.kind] ?? main.kind, main.opencodeVersion ? `OpenCode ${main.opencodeVersion}` : ""].filter(Boolean).join(" · ")
        : "online"
    return {
      id: m.id,
      name: m.name,
      online,
      disabled: !online,
      detail,
      herdr: online && !!m.terminals?.herdr,
      canCreate: online && m.processes.some((p) => p.kind === "service"),
    }
  })
  return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
}

/** The machine to preselect: the link's (sidebar "+"), else the remembered one, else the first that can create sessions. */
export function pickEnvironment(list: readonly Environment[], linked: string | undefined, remembered: string | undefined): string | undefined {
  const usable = (id: string | undefined) => (id ? list.find((e) => e.id === id && e.online) : undefined)
  return (usable(linked) ?? usable(remembered) ?? list.find((e) => e.canCreate) ?? list.find((e) => e.online))?.id
}

export interface NewSessionChoice {
  readonly machine: string
  readonly key: string
  readonly dir: string
}

/** The folder to preselect on the chosen machine: the link's, else the remembered one, else the first. */
export function pickTarget(
  targets: readonly NewSessionTarget[],
  linked: { key?: string; dir?: string },
  remembered: NewSessionChoice | undefined,
): { key: string; dir: string } | undefined {
  const within = (key: string | undefined, dir: string | undefined) => {
    const target = key ? targets.find((t) => t.key === key) : undefined
    if (!target) return undefined
    return { key: target.key, dir: dir && target.directories.includes(dir) ? dir : (target.directories[0] ?? dir ?? "") }
  }
  const first = targets[0]
  return (
    within(linked.key, linked.dir) ??
    within(remembered?.key, remembered?.dir) ??
    (first ? { key: first.key, dir: first.directories[0] ?? "" } : undefined)
  )
}

/** Folder search: every word appears in the label or one of its folders (case- and accent-insensitive). */
export function filterTargets(targets: readonly NewSessionTarget[], query: string): NewSessionTarget[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...targets]
  return targets.filter((t) => {
    const fields = [t.label, ...t.directories].map(fold)
    return words.every((w) => fields.some((f) => f.includes(w)))
  })
}

export const NEW_SESSION_KEY = "hub.newSession"

export function loadNewSessionChoice(storage: Storage): NewSessionChoice | undefined {
  try {
    const raw = JSON.parse(storage.getItem(NEW_SESSION_KEY) ?? "null")
    if (raw && typeof raw.machine === "string" && typeof raw.key === "string" && typeof raw.dir === "string") {
      return { machine: raw.machine, key: raw.key, dir: raw.dir }
    }
  } catch {
    // ignore a broken value
  }
  return undefined
}

export function saveNewSessionChoice(storage: Storage, choice: NewSessionChoice): void {
  try {
    storage.setItem(NEW_SESSION_KEY, JSON.stringify({ machine: choice.machine, key: choice.key, dir: choice.dir }))
  } catch {
    // storage full or disabled
  }
}

export const RAIL_COLLAPSED_KEY = "hub.railCollapsed"

export function loadCollapsed(storage: Storage): Set<string> {
  try {
    const raw = JSON.parse(storage.getItem(RAIL_COLLAPSED_KEY) ?? "[]")
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/** Collapses or expands a rail card; returns the collapsed cards. */
export function toggleCollapsed(storage: Storage, id: string): Set<string> {
  const set = loadCollapsed(storage)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  try {
    storage.setItem(RAIL_COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    // storage full or disabled
  }
  return set
}
