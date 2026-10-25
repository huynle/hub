// Webhook verification for receivers (design §6.1; decision znbg8xa5 #8). The hub signs every webhook POST with
//   Hub-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// (format: packages/protocol/src/webhook.ts). verifyWebhook checks it against the receiver's secret(s) in constant
// time and refuses timestamps outside the tolerance (replay). Verify the raw body bytes as received, before parsing.
import { createHmac, timingSafeEqual } from "node:crypto"

// The format, as in packages/protocol/src/webhook.ts (the SDK imports nothing outside its package; the tests check
// the two agree).
export const WEBHOOK_SIGNATURE_HEADER = "Hub-Signature"
export const WEBHOOK_EVENT_HEADER = "Hub-Event"
export const WEBHOOK_DELIVERY_HEADER = "Hub-Delivery"
/** Largest gap, either way, between a signature's timestamp and the receiver's clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300
const SCHEME = "v1"
const ALGORITHM = "sha256"
const HEADER_MAX = 2048
const HEX_SHA256 = /^[0-9a-f]{64}$/

/** A Hub-Signature header's timestamp (unix seconds) and v1 signatures, or undefined when it is malformed. */
function parseSignature(value: string): { t: number; v1: string[] } | undefined {
  if (value.length > HEADER_MAX) return undefined
  let t: number | undefined
  const v1: string[] = []
  for (const part of value.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) return undefined
    const key = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (key === "t") {
      if (t !== undefined || !/^\d{1,12}$/.test(v)) return undefined
      t = Number(v)
    } else if (key === SCHEME) {
      if (!HEX_SHA256.test(v)) return undefined
      v1.push(v)
    }
  }
  return t !== undefined && v1.length > 0 ? { t, v1 } : undefined
}

/** Request headers: a Headers, or a plain object such as node's IncomingMessage.headers (any key case). */
export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

export interface VerifyWebhookInput {
  /** The raw request body, exactly as received. */
  readonly body: string | Uint8Array
  /** The Hub-Signature header value (or give `headers`). */
  readonly signature?: string | null
  /** The request's headers: Hub-Signature, and Hub-Event / Hub-Delivery for the answer. */
  readonly headers?: WebhookHeaders
  /** The registration's secret; several while one rotates (any may match). */
  readonly secret: string | readonly string[]
  /** The receiver's clock in ms (default Date.now()). */
  readonly now?: number
  /** Seconds a timestamp may be off either way (default WEBHOOK_TOLERANCE_SECONDS). */
  readonly tolerance?: number
}

export type WebhookVerification =
  | { readonly ok: true; readonly timestamp: number; readonly event?: string; readonly delivery?: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "stale" | "mismatch" }

function header(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue
    return typeof value === "string" ? value : value[0]
  }
  return undefined
}

const text = (body: string | Uint8Array) => (typeof body === "string" ? body : new TextDecoder().decode(body))

const hmac = (secret: string, t: number, body: string): Buffer => createHmac(ALGORITHM, secret).update(`${t}.${body}`).digest()

/** Whether a Hub-Signature matches the body under one of the secrets, and is fresh. */
export function verifyWebhook(input: VerifyWebhookInput): WebhookVerification {
  const raw = input.signature ?? header(input.headers, WEBHOOK_SIGNATURE_HEADER)
  if (raw === undefined || raw === null || raw === "") return { ok: false, reason: "missing" }
  const parsed = parseSignature(raw)
  if (!parsed) return { ok: false, reason: "malformed" }
  if (Math.abs((input.now ?? Date.now()) / 1000 - parsed.t) > (input.tolerance ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" }
  const body = text(input.body)
  const secrets = (typeof input.secret === "string" ? [input.secret] : input.secret).filter((s) => s.length > 0)
  const given = parsed.v1.map((hex) => Buffer.from(hex, "hex"))
  // Every comparison runs (no early exit), each in constant time.
  let match = false
  for (const secret of secrets) {
    const expected = hmac(secret, parsed.t, body)
    for (const signature of given) if (signature.length === expected.length && timingSafeEqual(signature, expected)) match = true
  }
  if (!match) return { ok: false, reason: "mismatch" }
  const event = header(input.headers, WEBHOOK_EVENT_HEADER)
  const delivery = header(input.headers, WEBHOOK_DELIVERY_HEADER)
  return { ok: true, timestamp: parsed.t, ...(event !== undefined ? { event } : {}), ...(delivery !== undefined ? { delivery } : {}) }
}

/** The Hub-Signature header the hub would send for `body` (for testing receivers); `t` in unix seconds, default now. */
export function signWebhook(body: string | Uint8Array, secret: string, t: number = Math.floor(Date.now() / 1000)): string {
  return `t=${t},${SCHEME}=${hmac(secret, t, text(body)).toString("hex")}`
}
