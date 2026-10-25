// Shared frame primitives for the spoke protocol (index.ts), the node protocol (node.ts) and launch checks
// (launch.ts). Kept apart so those modules import values from here, never from each other in a cycle.

/** Largest frame (in characters) either side accepts; a larger one is a protocol error. */
export const MAX_FRAME = 1_000_000

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
export const str = (v: unknown): v is string => typeof v === "string"
export const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
/** A plain id: letters, digits and `_.:@/+~-`, 1–300 characters. */
export const ID = /^[A-Za-z0-9_.:@/+~-]{1,300}$/
/** A short lowercase token (harness id, evidence level, runtime kind). */
export const token = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && /^[a-z0-9][a-z0-9._-]*$/.test(v)
/** A feature list: at most 64 names of 1–64 characters. */
export const featureList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every((f) => nonEmpty(f) && f.length <= 64)
/** Control (C0, C1), format (bidi, zero-width, BOM) and line/paragraph separator characters. */
export const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

export const isResFrame = (v: Record<string, unknown>): boolean => nonEmpty(v.id) && typeof v.ok === "boolean" && (v.error === undefined || str(v.error))
/** Longest reconnect delay a bye's retryAfterMs may ask for (5 minutes). */
export const MAX_RETRY_AFTER_MS = 300_000
/** A bye: a reason, and optionally (e.g. a draining hub) how soon to reconnect, in whole milliseconds. */
export const isByeFrame = (v: Record<string, unknown>): boolean =>
  str(v.reason) &&
  (v.retryAfterMs === undefined || (Number.isInteger(v.retryAfterMs) && (v.retryAfterMs as number) >= 0 && (v.retryAfterMs as number) <= MAX_RETRY_AFTER_MS))
export const isWelcomeFrame = (v: Record<string, unknown>): boolean =>
  num(v.v) && nonEmpty(v.machineID) && str(v.publicURL) && (v.features === undefined || featureList(v.features))

/** Longest hub URL a sessionTokens request or a start op carries. */
export const HUB_URL_MAX_CHARS = 2048

/** An http(s) URL of at most HUB_URL_MAX_CHARS characters. */
export function isHubURL(v: unknown): v is string {
  if (!nonEmpty(v) || v.length > HUB_URL_MAX_CHARS) return false
  try {
    const url = new URL(v)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** A frame's JSON object, or undefined when it is too large, not JSON or not an object. */
export function parseFrame(raw: string | Buffer): Record<string, unknown> | undefined {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  if (text.length > MAX_FRAME) return undefined
  try {
    const value = JSON.parse(text)
    return isObj(value) ? value : undefined
  } catch {
    return undefined
  }
}
