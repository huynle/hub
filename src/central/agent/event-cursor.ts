// Cursors of GET /api/agent/events (lifecycle design, frozen "Events route and tool"): opaque, versioned,
// authenticated, tenant-bound strings over a journal position (`<epoch>.<n>`).
//
//   hev1_<base64url(kid "\n" position)>.<base64url(mac)>
//
// mac is HMAC-SHA256 under the token signing key `kid` (token-keys.ts) of a domain-separated string that also binds
// the user, truncated to 16 bytes; another user's cursor, a changed byte, an unknown key or another version all fail
// to decode (400 invalid_cursor), never reset. The user never appears in the cursor itself.
import { createHmac, timingSafeEqual } from "node:crypto"

export const CURSOR_PREFIX = "hev1_"
const DOMAIN = "hub-agent-events-cursor/v1"
const MAC_BYTES = 16
const POSITION = /^([a-z0-9]{1,40})\.(\d{1,15})$/
const KID = /^[A-Za-z0-9_-]{1,64}$/
const B64URL = /^[A-Za-z0-9_-]+$/

export interface CursorKeys {
  active(): { kid: string; secret: Buffer }
  key(kid: string): Buffer | undefined
}

/** A journal position: its epoch and n. */
export function parsePosition(position: string): { epoch: string; n: number } | undefined {
  const match = POSITION.exec(position)
  return match ? { epoch: match[1]!, n: Number(match[2]) } : undefined
}

const mac = (secret: Buffer, userID: string, kid: string, position: string) => createHmac("sha256", secret).update(`${DOMAIN}\n${userID}\n${kid}\n${position}`).digest().subarray(0, MAC_BYTES)

export function encodeCursor(keys: CursorKeys, userID: string, position: string): string {
  const { kid, secret } = keys.active()
  const body = Buffer.from(`${kid}\n${position}`).toString("base64url")
  return `${CURSOR_PREFIX}${body}.${mac(secret, userID, kid, position).toString("base64url")}`
}

/** The position of a cursor this hub gave this user; undefined for anything else. */
export function decodeCursor(keys: CursorKeys, userID: string, cursor: string): string | undefined {
  if (cursor.length > 300 || !cursor.startsWith(CURSOR_PREFIX)) return undefined
  const [body, tag, ...rest] = cursor.slice(CURSOR_PREFIX.length).split(".")
  if (rest.length || !body || !tag || !B64URL.test(body) || !B64URL.test(tag)) return undefined
  const [kid, position, ...extra] = Buffer.from(body, "base64url").toString("utf8").split("\n")
  if (extra.length || !kid || !position || !KID.test(kid) || !parsePosition(position)) return undefined
  const secret = keys.key(kid)
  if (!secret) return undefined
  const given = Buffer.from(tag, "base64url")
  const expected = mac(secret, userID, kid, position)
  return given.length === expected.length && timingSafeEqual(given, expected) ? position : undefined
}
