// Web push: service worker registration, subscribe/unsubscribe and keeping the hub's copy current.
import { api, getJSON } from "./api"
import { navigate } from "./router"

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

export async function currentSubscription(): Promise<PushSubscription | undefined> {
  if (!pushSupported()) return undefined
  const reg = await navigator.serviceWorker.getRegistration("/")
  return (await reg?.pushManager.getSubscription()) ?? undefined
}

export async function subscribePush(): Promise<PushSubscription> {
  const { publicKey } = await getJSON("/api/push/key")
  const key = keyBytes(publicKey)
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
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in the browser's site settings.")
  await subscribePush()
}

export async function disableNotifications(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

/** Registers the service worker; keeps an existing subscription known to the hub; routes notification clicks. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(async () => {
      if (pushSupported() && Notification.permission === "granted" && (await currentSubscription().catch(() => undefined))) await subscribePush().catch(() => {})
    })
    .catch((e) => console.warn("service worker:", e.message))
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "navigate" && typeof event.data.url === "string") {
      const url = new URL(event.data.url, location.origin)
      if (url.origin === location.origin) navigate(url.pathname + url.search)
    }
  })
}
