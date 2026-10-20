// The console's single reactive store, fed by the hub's SSE stream (/api/events): catalog, status, prefs,
// reads, enrollments and conversation flags in the store; activity/stream feeds in LiveFeeds (with a revision
// signal); session views subscribe to raw messages for their own timeline. Reconnects with backoff.
import { batch, createMemo, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Me, AuthInfo } from "../core/account-core"
import { isAdmin } from "../core/account-core"
import type { SpeechReadyView } from "../core/feedback-core"
import { migratePins, normalizePrefs, PendingTitles, renameTitle, retitle, setPrefs, type PrefList, type ViewPrefs } from "../core/view-core"
import { sessionRows, stableRows, type SessionRow } from "../lib/sessions"
import { LiveFeeds, applyMessage, findSession, initialHub, type HubState } from "../lib/store"
import { StreamKeeper, type StreamScope } from "../core/stream-core"
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
export const rows = createRoot(() => createMemo<SessionRow[]>((previous) => stableRows(previous, sessionRows(hub.machines, hub.prefs, hub.reads))))
export const lookup = (id: string) => findSession(hub.machines, id)
/** Titles renamed here that the catalog may not carry yet. */
const pendingTitles = new PendingTitles()

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
// One EventSource, kept by a StreamKeeper (core/stream-core.ts): paused while the page is hidden (unless Voice
// mode runs), resumed with the last event id (the hub replays what was missed), reopened when no message or
// heartbeat came for a while, lite (no streamed text) except for the session on screen.

let source: EventSource | undefined
let retry: ReturnType<typeof setTimeout> | undefined
let backoff = 1000
let keepOpen = () => false
/** Shown in the top bar: reconnecting after a pause or drop, then "Updated" for a moment. */
export const [syncNote, setSyncNote] = createSignal<"" | "reconnecting" | "updated">("")
let noteTimer: ReturnType<typeof setTimeout> | undefined
let resuming = false

const keeper = new StreamKeeper({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  open: (url) => openSource(url),
  close: () => closeSource(),
  keepOpen: () => keepOpen(),
})

/** Voice mode keeps the stream open while hidden (its replies come over it). */
export function keepStreamOpen(fn: () => boolean): void {
  keepOpen = fn
}

/** What the stream carries: streamed text only for `session` unless `full`. */
export function setStreamScope(scope: StreamScope): void {
  keeper.setScope(scope)
}

let lifecycle = false
function watchLifecycle(): void {
  if (lifecycle) return
  lifecycle = true
  document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? keeper.hidden() : keeper.visible()))
  // Back from the bfcache (iOS app switch, back button): the old stream is gone.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && keeper.state !== "stopped") keeper.reopen()
  })
  window.addEventListener("online", () => keeper.state === "open" && hub.connection === "down" && keeper.reopen())
}

export function startEvents(scope: StreamScope = { lite: false }): void {
  if (keeper.state !== "stopped") return
  watchLifecycle()
  keeper.start(scope)
  if (document.visibilityState === "hidden") keeper.hidden()
}

function closeSource(): void {
  clearTimeout(retry)
  source?.close()
  source = undefined
  if (keeper.state === "paused") setHub("connection", "paused")
}

function openSource(url: string): void {
  clearTimeout(retry)
  source?.close()
  const wasLive = hub.connection === "live" || hub.connection === "paused" || hub.connection === "down"
  resuming = wasLive
  if (wasLive) showNote("reconnecting")
  setHub("connection", "connecting")
  const es = new EventSource(url, { withCredentials: true })
  source = es
  es.onopen = () => {
    backoff = 1000
    setHub("connection", "live")
    if (resuming) showNote("updated", 2000)
    resuming = false
    void loadViewPrefs()
    void loadReads()
    void loadEnrollments()
  }
  es.onerror = async () => {
    if (source !== es) return
    setHub("connection", "down")
    // EventSource hides the status code: check whether the device was revoked.
    const res = await fetch("/api/me", { credentials: "same-origin" }).catch(() => undefined)
    if (res?.status === 401) {
      stopEvents()
      setMe(undefined)
      toPair()
      return
    }
    // The browser retries by itself (with Last-Event-ID) unless it gave up.
    if (es.readyState === EventSource.CLOSED && source === es) {
      source = undefined
      retry = setTimeout(() => keeper.state === "open" && keeper.reopen(), backoff)
      backoff = Math.min(30_000, backoff * 2)
    }
  }
  es.addEventListener("ping", () => keeper.received())
  es.onmessage = (event) => {
    keeper.received(event.lastEventId || undefined)
    let message: Record<string, any>
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    dispatch(message)
  }
}

function showNote(note: "reconnecting" | "updated", ms?: number): void {
  clearTimeout(noteTimer)
  setSyncNote(note)
  if (ms) noteTimer = setTimeout(() => setSyncNote(""), ms)
}

export function stopEvents(): void {
  keeper.stop()
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
    } else if (message.type === "catalog") {
      setHub(
        produce((s) => {
          applyMessage(s, message)
          pendingTitles.apply(s.machines, Date.now())
        }),
      )
    } else setHub(produce((s) => applyMessage(s, message)))
    if (message.type === "status") {
      const root = lookup(message.sessionID)
      if (!live.has(message.sessionID) && root) live.feed(message.sessionID)
    }
    if (live.apply(message) !== undefined) setLiveRev((n) => n + 1)
    if (message.type === "enrollment") void loadEnrollments()
    // The hub could not replay what this page missed: refresh what is not in the catalog.
    if (message.type === "resync") {
      void loadReads()
      void reloadPrefs()
      void loadEnrollments()
    }
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

/** Optimistic pin/archive: shows the result at once, saves, reverts (with a toast) if the hub refuses. */
export function changePref(list: PrefList, key: string, on: boolean, options: { message?: string; undo?: boolean } = {}): void {
  changePrefs(list, [key], on, options)
}

/** changePref for several keys at once (bulk archive): one save, one message, Undo reverts only what changed. */
export function changePrefs(list: PrefList, keys: readonly string[], on: boolean, { message, undo = false }: { message?: string; undo?: boolean } = {}): void {
  if (!prefsReady()) {
    toast("Your view settings are still loading. Try again in a moment.", "err")
    void loadViewPrefs()
    return
  }
  const before = new Set(hub.prefs[list])
  const changed = keys.filter((key) => before.has(key) !== on)
  const { prefs, patch } = setPrefs(hub.prefs, list, changed, on)
  if (!patch) return
  setHub("prefs", prefs)
  if (message) toast(message, "", undo ? { label: "Undo", run: () => changePrefs(list, changed, !on) } : undefined)
  void savePrefs(patch).then(({ ok, error }) => {
    if (ok) return
    setHub("prefs", setPrefs(hub.prefs, list, changed, !on).prefs)
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

/**
 * Optimistic rename (POST …/rename, OpenCode's session.update): shows the new title at once, reverts with a
 * toast if the hub refuses. Returns whether it was saved (a blank or unchanged title is not sent).
 */
export async function renameSession(id: string, raw: string): Promise<boolean> {
  const checked = renameTitle(raw)
  if ("error" in checked) {
    toast(checked.error, "err")
    return false
  }
  const { title } = checked
  const previous = lookup(id)?.session.title
  if (previous === title) return false
  pendingTitles.set(id, title, Date.now())
  setHub(produce((s) => void retitle(s.machines, id, title)))
  try {
    const saved = await (await api(`${sessionPath(id)}/rename`, { method: "POST", json: { title } })).json().catch(() => undefined)
    const confirmed = typeof saved?.title === "string" && saved.title ? saved.title : title
    if (confirmed !== title && lookup(id)?.session.title === title) {
      pendingTitles.drop(id, title)
      pendingTitles.set(id, confirmed, Date.now())
      setHub(produce((s) => void retitle(s.machines, id, confirmed)))
    }
    return true
  } catch (e) {
    pendingTitles.drop(id, title)
    // Revert unless the catalog already moved on (a newer title from elsewhere).
    if (previous !== undefined && lookup(id)?.session.title === title) setHub(produce((s) => void retitle(s.machines, id, previous)))
    toast(`Could not rename: ${errorText(e)}`, "err")
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
