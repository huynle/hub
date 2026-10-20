// Web push: service worker registration, subscribe/unsubscribe, keeping the hub's copy current (also after
// the hub moved to a new origin or the browser rotated the subscription), the test push, and muted sessions.
import { createSignal } from "solid-js"
import { shouldResubscribe, type NotifyEnv, type PermissionState, type PushTestAnswer, type QuietHours } from "../core/notify-core"
import { api, getJSON } from "./api"
import { navigate } from "./router"
import { toast } from "./toast"

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a || a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

/** The hub's answer to GET /api/push/prefs. */
export interface PushPrefsView {
  prefs: Record<string, boolean>
  quietHours: QuietHours | null
  /** Minutes between two activity updates of one session (hubs since 0.7). */
  activityMinutes?: number
  muted: string[]
  subscriptions: number
  subscribed?: boolean
}

/** Bumped when the subscription changed in the background (Settings re-reads its status). */
export const [pushRevision, setPushRevision] = createSignal(0)

/** Sessions the user muted (synced from the hub; drives the ⋯ menu). */
export const [mutedSessions, setMutedSessions] = createSignal<ReadonlySet<string>>(new Set())

const permission = (): PermissionState => ("Notification" in window ? (Notification.permission as PermissionState) : "default")

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined
  return (await navigator.serviceWorker.getRegistration("/").catch(() => undefined)) ?? undefined
}

export async function currentSubscription(): Promise<PushSubscription | undefined> {
  if (!pushSupported()) return undefined
  return (await (await registration())?.pushManager.getSubscription()) ?? undefined
}

/** GET /api/push/prefs, asking whether the hub holds `endpoint` for this device. */
export async function loadPushPrefs(endpoint?: string): Promise<PushPrefsView> {
  const view = await getJSON<PushPrefsView>(`/api/push/prefs${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`)
  setMutedSessions(new Set(view.muted ?? []))
  return view
}

/** What the browser and the hub report right now (Settings → Notifications). */
export async function notifyEnv(): Promise<{ env: NotifyEnv; view?: PushPrefsView }> {
  const supported = pushSupported()
  const reg = supported ? await registration() : undefined
  const sub = (await reg?.pushManager.getSubscription().catch(() => null)) ?? undefined
  const view = await loadPushPrefs(sub?.endpoint).catch(() => undefined)
  return {
    env: {
      supported,
      permission: permission(),
      worker: !!reg,
      ...(sub ? { endpoint: sub.endpoint } : {}),
      hubSubscribed: !!view?.subscribed,
      hubSubscriptions: view?.subscriptions ?? 0,
    },
    view,
  }
}

/** Registers the worker when needed, subscribes with the hub's VAPID key and tells the hub. */
export async function subscribePush(): Promise<PushSubscription> {
  const { publicKey } = await getJSON("/api/push/key")
  const key = keyBytes(publicKey)
  if (!(await registration())) await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } })
  return sub
}

export async function enableNotifications(): Promise<void> {
  if (!pushSupported()) throw new Error("This browser does not support push notifications here. On iPhone, add the app to the Home Screen first (iOS 16.4+).")
  const granted = await Notification.requestPermission()
  if (granted !== "granted") throw new Error("Notifications are blocked. Allow them in the browser's site settings.")
  await subscribePush()
}

export async function disableNotifications(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

/** POST /api/push/test: a test notification to this device's subscriptions. */
export async function sendTestNotification(): Promise<PushTestAnswer> {
  return (await api("/api/push/test", { method: "POST", json: {} })).json() as Promise<PushTestAnswer>
}

/** Mutes or unmutes a session's notifications for the signed-in user (shown at once, reverted on error). */
export async function setSessionMuted(sessionID: string, muted: boolean): Promise<void> {
  const before = mutedSessions()
  const next = new Set(before)
  if (muted) next.add(sessionID)
  else next.delete(sessionID)
  setMutedSessions(next)
  try {
    const res = (await (await api("/api/push/mute", { method: "PUT", json: { sessionID, muted } })).json()) as { muted: string[] }
    setMutedSessions(new Set(res.muted))
    toast(muted ? "Notifications muted for this session" : "Notifications on for this session")
  } catch (e) {
    setMutedSessions(before)
    toast(e instanceof Error ? e.message : String(e), "err")
  }
}

/**
 * After sign-in: loads muted sessions and, when notifications are allowed but the browser or the hub lost the
 * subscription (new hub origin, pruned endpoint), subscribes again without asking.
 */
export async function syncPush(): Promise<void> {
  const { env } = await notifyEnv().catch(() => ({ env: undefined }))
  if (!env || !shouldResubscribe(env)) return
  await subscribePush().then(
    () => setPushRevision((n) => n + 1),
    (e) => console.warn("push re-subscribe:", e?.message ?? e),
  )
}

/** Registers the service worker and routes its messages (notification clicks, Voice notification actions). */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("service worker:", e.message))
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data
    if (data?.type === "navigate" && typeof data.url === "string") {
      const url = new URL(data.url, location.origin)
      if (url.origin === location.origin) navigate(url.pathname + url.search)
    }
    for (const fn of workerListeners) fn(data)
  })
}

type WorkerListener = (data: any) => void
const workerListeners = new Set<WorkerListener>()
/** Messages from the service worker (e.g. {type: "voice-end"}). Returns an unsubscribe function. */
export function onWorkerMessage(fn: WorkerListener): () => void {
  workerListeners.add(fn)
  return () => workerListeners.delete(fn)
}
