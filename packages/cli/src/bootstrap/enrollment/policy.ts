// The network policy of machine enrollment: which hub URLs a machine credential may be sent to, and which approval
// link may be shown to the user.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const MAX_URL = 2048

/**
 * The normalized hub URL (origin + path, no trailing slash), or undefined when it is not allowed: https only, plain
 * http only for a loopback hub (a local hub, and the tests); no user info, query, fragment or whitespace. Matches the
 * contract's hubURL check, and what src/config.ts normalize() keeps.
 */
export function checkServerURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return undefined
  if (/[\s?#]/.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) return undefined
  if (!/^https?:\/\/[^\s/]+/.test(value)) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

export const isLoopbackServer = (server: string): boolean => {
  try {
    return LOOPBACK.has(new URL(server).hostname)
  } catch {
    return false
  }
}

const USER_CODE = /^[A-Za-z0-9-]{4,32}$/

export const isUserCode = (value: unknown): value is string => typeof value === "string" && USER_CODE.test(value)

/**
 * The approval link to show. The hub's own link is used only when it is on the hub's origin (scheme, host and port)
 * and passes the URL policy: anything else could send the user (and their hub login) to a phishing page. Otherwise
 * the link is rebuilt on the hub URL, with a warning.
 */
export function approvalURL(server: string, approveURL: unknown, userCode: string): { url: string; warning?: string } {
  const own = `${server}/approve?code=${encodeURIComponent(userCode)}`
  if (typeof approveURL !== "string" || approveURL.length > MAX_URL || /\s/.test(approveURL)) return { url: own, warning: "the hub sent no usable approval link; showing one on the hub URL" }
  try {
    const link = new URL(approveURL)
    const base = new URL(server)
    const allowed = checkServerURL(`${link.origin}${link.pathname}`) !== undefined && !link.username && !link.password
    if (allowed && link.origin === base.origin) return { url: link.href }
  } catch {}
  return { url: own, warning: "the hub's approval link is on another origin; showing one on the hub URL instead" }
}
