// OpenCode Hub service worker: shows push notifications, answers permissions from them, keeps the push
// subscription known to the hub.
// No offline caching: every request goes to the network (the API must never be served stale).
// Requests from here are same-origin with the device cookie (credentials: "same-origin"); POSTs carry the
// Origin header browsers add to non-GET requests, which the hub's CSRF check accepts.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

/** Kinds that wait for the user: stay on screen until handled. */
const STICKY = new Set(["question", "permission", "blocked"])
const VIBRATE = { question: [200, 100, 200], permission: [200, 100, 200], blocked: [200, 100, 200], failed: [300], test: [100] }

const sessionURL = (sessionID) => (sessionID ? `/s/${encodeURIComponent(sessionID)}` : "/")

async function postJSON(path, body) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** The pending permission's summary (e.g. "bash: bun test"), fetched from the hub, never carried by the push. */
async function permissionSummary(sessionID, requestID) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionID)}`, { credentials: "same-origin" })
    if (!res.ok) return undefined
    const session = await res.json()
    const blocker = (session.blockers || []).find((b) => b && b.kind === "permission" && b.id === requestID)
    return blocker ? String(blocker.summary || "a tool call") : undefined
  } catch {
    return undefined
  }
}

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: "OpenCode Hub", body: event.data ? event.data.text() : "" }
  }
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
  const kind = typeof data.kind === "string" ? data.kind : "update"
  const requestID = typeof data.requestID === "string" ? data.requestID : ""
  event.waitUntil(
    (async () => {
      let body = data.body || ""
      let actions = [{ action: "open", title: "Open" }]
      // Answer from the notification only when the hub confirms the request is pending and we can show what it is.
      if (kind === "permission" && sessionID && requestID) {
        const summary = await permissionSummary(sessionID, requestID)
        if (summary) {
          body = summary.length > 140 ? `${summary.slice(0, 139)}…` : summary
          actions = [
            { action: "allow-once", title: "Allow once" },
            { action: "reject", title: "Reject" },
          ]
        }
      }
      await self.registration.showNotification(data.title || "OpenCode Hub", {
        body,
        tag: `${sessionID}:${kind}`,
        renotify: kind !== "finished",
        requireInteraction: STICKY.has(kind),
        vibrate: VIBRATE[kind] || [100],
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        timestamp: Date.now(),
        actions,
        data: { url: sessionURL(sessionID), sessionID, kind, requestID },
      })
    })(),
  )
})

async function focusOrOpen(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const client = windows.find((c) => new URL(c.url).origin === self.location.origin)
  if (client) {
    await client.focus()
    // The page routes in place (keeps its SSE connection and audio unlock).
    if (client.url !== url) client.postMessage({ type: "navigate", url })
    return
  }
  await self.clients.openWindow(url)
}

self.addEventListener("notificationclick", (event) => {
  const note = event.notification
  const data = note.data || {}
  const url = new URL(data.url || "/", self.location.origin).href
  note.close()
  event.waitUntil(
    (async () => {
      if ((event.action === "allow-once" || event.action === "reject") && data.sessionID && data.requestID) {
        const decision = event.action === "allow-once" ? "once" : "reject"
        const res = await postJSON(`/api/sessions/${encodeURIComponent(data.sessionID)}/permission`, { requestID: data.requestID, decision }).catch(() => undefined)
        if (res && res.ok) return
        // Not answered (signed out, already answered, hub down): show the session instead.
        return focusOrOpen(url)
      }
      return focusOrOpen(url)
    })(),
  )
})

function urlBase64ToBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

// The browser replaced (or expired) the subscription: subscribe again and tell the hub, dropping the old one.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription
      let sub = event.newSubscription
      if (!sub) {
        const res = await fetch("/api/push/key", { credentials: "same-origin" })
        if (!res.ok) return
        const { publicKey } = await res.json()
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) })
      }
      await postJSON("/api/push/subscribe", { subscription: sub.toJSON(), ...(old ? { oldEndpoint: old.endpoint } : {}) })
    })().catch(() => {}),
  )
})

// Pass-through fetch handler (keeps the app installable); never caches.
self.addEventListener("fetch", () => {})
