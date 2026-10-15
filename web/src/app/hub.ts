// The console's single reactive store, fed by the hub's SSE stream (/api/events): catalog, status, prefs,
// reads, enrollments and conversation flags in the store; activity/stream feeds in LiveFeeds (with a revision
// signal); session views subscribe to raw messages for their own timeline. Reconnects with backoff.
import { batch, createMemo, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Me, AuthInfo } from "../core/account-core"
import { isAdmin } from "../core/account-core"
import type { SpeechReadyView } from "../core/feedback-core"
import { migratePins, normalizePrefs, setPref, type PrefList, type ViewPrefs } from "../core/view-core"
import { sessionRows } from "../lib/sessions"
import { LiveFeeds, applyMessage, findSession, initialHub, type HubState } from "../lib/store"
import { api, enc, errorText, getJSON, HttpError, sessionPath, setUnauthorized } from "./api"
import { navigate, route } from "./router"
import { toast } from "./toast"

export const [hub, setHub] = createStore<HubState>(initialHub())
export const live = new LiveFeeds()
const [liveRev, setLiveRev] = createSignal(0)
/** Changes whenever an activity feed changed (read it to re-render live activity). */
export const liveTick = liveRev

export const [me, setMe] = createSignal<Me | undefined>()
export const [authInfo, setAuthInfo] = createSignal<AuthInfo | null | undefined>()
export const [speechReady, setSpeechReady] = createSignal<SpeechReadyView | null | undefined>()
export const [enrollments, setEnrollments] = createSignal<Array<{ userCode: string; machineName: string; created: number }>>([])

type Listener = (message: Record<string, any>) => void
const listeners = new Set<Listener>()
/** Raw SSE messages (after the store applied them). Returns an unsubscribe function. */
export function onMessage(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** All root sessions as rows (reactive). */
export const rows = createRoot(() => createMemo(() => sessionRows(hub.machines, hub.prefs, hub.reads)))
export const lookup = (id: string) => findSession(hub.machines, id)

// ---------- me ----------

setUnauthorized(() => {
  if (route().name === "pair") return
  stopEvents()
  setMe(undefined)
  toPair()
})

export function toPair(): void {
  const here = location.pathname + location.search
  navigate(`/pair${here === "/" || here.startsWith("/pair") ? "" : `?next=${enc(here)}`}`, { replace: true })
}

/** GET /api/me once; false when the device is not paired (then the pair route shows). */
export async function ensureMe(): Promise<boolean> {
  if (me()) return true
  const res = await fetch("/api/me", { credentials: "same-origin" })
  if (res.status === 401) {
    toPair()
    return false
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  setMe((await res.json()) as Me)
  return true
}

export async function loadAuth(): Promise<AuthInfo | null> {
  if (authInfo() !== undefined) return authInfo() ?? null
  try {
    const res = await fetch("/api/auth", { credentials: "same-origin" })
    const info = res.ok ? ((await res.json()) as AuthInfo) : null
    setAuthInfo(info)
    return info
  } catch {
    return null
  }
}

// ---------- events ----------

let source: EventSource | undefined
let retry: ReturnType<typeof setTimeout> | undefined
let backoff = 1000

export function startEvents(): void {
  if (source) return
  clearTimeout(retry)
  setHub("connection", "connecting")
  const es = new EventSource("/api/events", { withCredentials: true })
  source = es
  es.onopen = () => {
    backoff = 1000
    setHub("connection", "live")
    void loadViewPrefs()
    void loadReads()
    void loadEnrollments()
  }
  es.onerror = async () => {
    setHub("connection", "down")
    // EventSource hides the status code: check whether the device was revoked.
    const res = await fetch("/api/me", { credentials: "same-origin" }).catch(() => undefined)
    if (res?.status === 401) {
      stopEvents()
      setMe(undefined)
      toPair()
      return
    }
    if (es.readyState === EventSource.CLOSED && source === es) {
      source = undefined
      retry = setTimeout(startEvents, backoff)
      backoff = Math.min(30_000, backoff * 2)
    }
  }
  es.onmessage = (event) => {
    let message: Record<string, any>
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    dispatch(message)
  }
}

export function stopEvents(): void {
  source?.close()
  source = undefined
  clearTimeout(retry)
}

/** Applies one hub message everywhere (also used by tests of the UI through the mock hub). */
export function dispatch(message: Record<string, any>): void {
  batch(() => {
    if (message.type === "prefs") {
      setHub(produce((s) => applyMessage(s, message)))
      if (hub.prefsStale && !hub.prefsPending) void reloadPrefs()
    } else setHub(produce((s) => applyMessage(s, message)))
    if (message.type === "status") {
      const root = lookup(message.sessionID)
      if (!live.has(message.sessionID) && root) live.feed(message.sessionID)
    }
    if (live.apply(message) !== undefined) setLiveRev((n) => n + 1)
    if (message.type === "enrollment") void loadEnrollments()
    if (message.type === "handoff" && !(route().name === "session" && (route() as { id: string }).id === message.sessionID)) {
      const s = lookup(message.sessionID)
      toast(`Handed off: ${s?.session.title || message.sessionID}`, "", { label: "Open", run: () => navigate(`/s/${enc(message.sessionID)}`) })
    }
  })
  for (const fn of listeners) fn(message)
}

// ---------- reads ----------

async function loadReads(): Promise<void> {
  try {
    const { reads } = await getJSON<{ reads: Record<string, number> }>("/api/reads")
    setHub("reads", reads ?? {})
  } catch {
    // older hub: no unread dots
  }
}

export async function markRead(id: string): Promise<void> {
  try {
    const { reads } = await (await api(`${sessionPath(id)}/read`, { method: "POST", json: {} })).json()
    if (reads && typeof reads === "object") setHub("reads", reads)
  } catch {
    // best effort
  }
}

// ---------- enrollments, speech ----------

export async function loadEnrollments(): Promise<void> {
  if (!isAdmin(me())) {
    setEnrollments([])
    return
  }
  try {
    setEnrollments((await getJSON("/api/enrollments")).enrollments ?? [])
  } catch {
    setEnrollments([])
  }
}

export async function loadSpeechReady(): Promise<void> {
  try {
    setSpeechReady((await getJSON("/api/settings/speech")).ready ?? null)
  } catch {
    setSpeechReady(null)
  }
}

// ---------- view prefs (pin / hide), synced per user ----------

const PREF_VIEW_LOCAL = "voice.viewPrefs"
let prefsLoading = false
const prefsReady = () => hub.prefsSource === "hub" || hub.prefsSource === "local"

async function loadViewPrefs(): Promise<void> {
  if (prefsReady() || prefsLoading) return
  prefsLoading = true
  try {
    setHub({ prefs: normalizePrefs(await getJSON("/api/prefs/view")), prefsSource: "hub" })
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      let local: unknown
      try {
        local = JSON.parse(localStorage.getItem(PREF_VIEW_LOCAL) ?? "null")
      } catch {}
      setHub({ prefs: normalizePrefs(local), prefsSource: "local" })
    } else setHub("prefsSource", "error")
  } finally {
    prefsLoading = false
  }
  if (prefsReady()) await migrateLocalPins()
}

async function reloadPrefs(): Promise<void> {
  setHub({ prefsStale: false, prefsSource: "unknown" })
  await loadViewPrefs()
}

/** 0.3 kept pins on the device: merge them into the synced prefs once, then drop the local keys. */
async function migrateLocalPins(): Promise<void> {
  const { clear, patch } = migratePins(localStorage.getItem("voice.pins"), localStorage.getItem("voice.pinnedWorkspaces"), hub.prefs)
  if (!clear) return
  if (patch) {
    setHub("prefs", (p) => ({ ...p, ...patch }))
    if (!(await savePrefs(patch)).ok) return
  }
  localStorage.removeItem("voice.pins")
  localStorage.removeItem("voice.pinnedWorkspaces")
}

async function savePrefs(patch: Partial<ViewPrefs>): Promise<{ ok: boolean; error?: unknown }> {
  if (hub.prefsSource === "local") {
    localStorage.setItem(PREF_VIEW_LOCAL, JSON.stringify(hub.prefs))
    return { ok: true }
  }
  setHub("prefsPending", (n) => n + 1)
  try {
    const saved = await (await api("/api/prefs/view", { method: "PUT", json: patch })).json().catch(() => undefined)
    if (hub.prefsPending === 1 && saved && !hub.prefsStale) setHub("prefs", normalizePrefs(saved))
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  } finally {
    setHub("prefsPending", (n) => n - 1)
    if (!hub.prefsPending && hub.prefsStale) void reloadPrefs()
  }
}

/** Optimistic pin/hide: shows the result at once, saves, reverts (with a toast) if the hub refuses. */
export function changePref(list: PrefList, key: string, on: boolean, { message, undo = false }: { message?: string; undo?: boolean } = {}): void {
  if (!prefsReady()) {
    toast("Your view settings are still loading. Try again in a moment.", "err")
    void loadViewPrefs()
    return
  }
  const { prefs, patch } = setPref(hub.prefs, list, key, on)
  if (!patch) return
  setHub("prefs", prefs)
  if (message) toast(message, "", undo ? { label: "Undo", run: () => changePref(list, key, !on) } : undefined)
  void savePrefs(patch).then(({ ok, error }) => {
    if (ok) return
    setHub("prefs", setPref(hub.prefs, list, key, !on).prefs)
    toast(`Could not save that change: ${errorText(error)}`, "err")
  })
}

// ---------- session actions shared by sidebar, table and session view ----------

/** POST …/expose; the catalog confirms it. Returns whether the hub agreed. */
export async function setVoice(id: string, on: boolean): Promise<boolean> {
  try {
    await api(`${sessionPath(id)}/expose`, { method: "POST", json: { on } })
    toast(on ? "Voice enabled" : "Voice disabled")
    return true
  } catch (e) {
    toast(`Could not ${on ? "enable" : "disable"} Voice: ${errorText(e)}`, "err")
    return false
  }
}

/** POST …/stop: interrupts the whole tree. */
export async function stopTree(id: string): Promise<void> {
  try {
    const { stopped } = await (await api(`${sessionPath(id)}/stop`, { method: "POST", json: {} })).json()
    const n = Array.isArray(stopped) ? stopped.length : 0
    toast(n ? `Stopped ${n} session${n === 1 ? "" : "s"}` : "Nothing was running")
  } catch (e) {
    toast(`Could not stop: ${errorText(e)}`, "err")
  }
}
