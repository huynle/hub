// Loopback detection, shared by the hub (CSRF origins for a local hub, first-machine auto-approve) and the
// spoke (auto-starting a local hub). Only names that can never leave the machine count: localhost,
// 127.0.0.0/8 and ::1. Request addresses are a hint only, never authentication.

/** Hostnames as they appear in URLs (`[::1]`) or in config (`::1`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (h === "localhost" || h === "::1") return true
  const ip = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return ip !== null && ip.slice(1).every((part) => Number(part) <= 255)
}

/** An http(s) URL whose host is loopback. */
export function isLoopbackURL(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

/** A peer address (e.g. Bun's server.requestIP) on loopback, including IPv4-mapped IPv6. */
export function isLoopbackAddress(ip: string | undefined | null): boolean {
  if (!ip) return false
  const address = ip.toLowerCase().replace(/^::ffff:/, "")
  return address !== "localhost" && isLoopbackHost(address)
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"] as const

/**
 * Origins a browser may send for this public URL. A loopback public URL is reachable as localhost,
 * 127.0.0.1 and [::1] (same scheme and port); any other public URL has exactly one origin.
 */
export function loopbackOrigins(publicURL: string): Set<string> {
  const url = new URL(publicURL)
  if (!isLoopbackHost(url.hostname)) return new Set([url.origin])
  const port = url.port ? `:${url.port}` : ""
  return new Set([url.origin, ...LOOPBACK_NAMES.map((name) => `${url.protocol}//${name}${port}`)])
}
