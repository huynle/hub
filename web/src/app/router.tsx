// A small history router: /, /s/:sessionID, /new, /settings, /pair, /approve. Links with `href` starting with
// "/" navigate in place (keeping the SSE connection and the audio unlock).
import { createSignal, type JSX } from "solid-js"

export type Route =
  | { name: "home" }
  | { name: "session"; id: string }
  | { name: "new"; machine?: string; dir?: string; key?: string }
  | { name: "settings"; section?: string }
  | { name: "pair"; next: string; error: string }
  | { name: "approve"; code: string }

const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/")

export function parseRoute(url: URL): Route {
  const p = url.pathname
  const q = url.searchParams
  if (p === "/pair") return { name: "pair", next: safeNext(q.get("next")), error: q.get("error") ?? "" }
  if (p === "/approve") return { name: "approve", code: q.get("code") ?? "" }
  if (p === "/new") return { name: "new", machine: q.get("machine") ?? undefined, dir: q.get("dir") ?? undefined, key: q.get("key") ?? undefined }
  if (p === "/settings") return { name: "settings", section: url.hash.slice(1) || undefined }
  const m = /^\/s\/([^/]+)$/.exec(p)
  if (m) {
    try {
      return { name: "session", id: decodeURIComponent(m[1]!) }
    } catch {
      return { name: "home" }
    }
  }
  return { name: "home" }
}

const [url, setURL] = createSignal(new URL(location.href))
export const location$ = url
export const route = () => parseRoute(url())
let pushed = 0

export function navigate(path: string, { replace = false } = {}): void {
  const target = new URL(path, location.origin)
  if (target.pathname + target.search + target.hash !== location.pathname + location.search + location.hash) {
    history[replace ? "replaceState" : "pushState"]({}, "", target.pathname + target.search + target.hash)
    if (!replace) pushed++
  }
  setURL(new URL(location.href))
}

export function back(fallback = "/"): void {
  if (pushed > 0) history.back()
  else navigate(fallback)
}

window.addEventListener("popstate", () => {
  pushed = Math.max(0, pushed - 1)
  setURL(new URL(location.href))
})

document.addEventListener("click", (event) => {
  const a = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
  if (!a || a.target || a.hasAttribute("download") || event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const href = a.getAttribute("href") ?? ""
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/auth/") || href.startsWith("/api/")) return
  event.preventDefault()
  navigate(href)
})

export const sessionHref = (id: string) => `/s/${encodeURIComponent(id)}`

export function A(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />
}
