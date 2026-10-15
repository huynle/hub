// OpenCode Hub service worker: shows push notifications and opens the session they are about.
// No offline caching: every request goes to the network (the API must never be served stale).
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: "OpenCode Hub", body: event.data ? event.data.text() : "" }
  }
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
  const kind = typeof data.kind === "string" ? data.kind : "update"
  const url = sessionID ? `/s/${encodeURIComponent(sessionID)}` : "/"
  event.waitUntil(
    self.registration.showNotification(data.title || "OpenCode Hub", {
      body: data.body || "",
      tag: `${sessionID}:${kind}`,
      renotify: kind !== "finished",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const client = windows.find((c) => new URL(c.url).origin === self.location.origin)
      if (client) {
        await client.focus()
        // The page routes in place (keeps its SSE connection and audio unlock).
        if (client.url !== url) client.postMessage({ type: "navigate", url })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})

// Pass-through fetch handler (keeps the app installable); never caches.
self.addEventListener("fetch", () => {})
