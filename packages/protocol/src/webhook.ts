// Webhook signatures (design §6.1; decision znbg8xa5 #8). Every webhook POST carries
//   Hub-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the registration's secret>
// plus Hub-Event (the event type) and Hub-Delivery (a delivery ID, the same on every retry, for deduplication).
// While a secret rotates the header carries one v1 per secret; a receiver accepts any match. Receivers refuse a
// timestamp outside WEBHOOK_TOLERANCE_SECONDS (replay) and compare signatures in constant time.
// Only the format lives here (no crypto): the hub signs, the SDK verifies.

export const WEBHOOK_SIGNATURE_HEADER = "Hub-Signature"
export const WEBHOOK_EVENT_HEADER = "Hub-Event"
export const WEBHOOK_DELIVERY_HEADER = "Hub-Delivery"
export const WEBHOOK_SIGNATURE_SCHEME = "v1"
/** The HMAC hash (node:crypto createHmac name). */
export const WEBHOOK_SIGNATURE_ALGORITHM = "sha256"
/** Largest gap, either way, between a signature's timestamp and the receiver's clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300
/** Longest Hub-Signature header a receiver parses. */
export const WEBHOOK_SIGNATURE_MAX = 2048

export interface WebhookSignature {
  /** Unix seconds. */
  readonly t: number
  /** Hex HMAC-SHA256 values, one per active secret. */
  readonly v1: readonly string[]
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

/** The bytes the signature covers: `<t>.<raw body>`. */
export function webhookSignedPayload(t: number, body: string): string {
  return `${t}.${body}`
}

/** The Hub-Signature header value for timestamp `t` (unix seconds) and hex signatures. */
export function formatWebhookSignature(t: number, signatures: readonly string[]): string {
  return [`t=${t}`, ...signatures.map((s) => `${WEBHOOK_SIGNATURE_SCHEME}=${s}`)].join(",")
}

/** A Hub-Signature header's timestamp and v1 signatures, or undefined when it is malformed. Unknown schemes are ignored. */
export function parseWebhookSignature(header: unknown): WebhookSignature | undefined {
  if (typeof header !== "string" || header.length === 0 || header.length > WEBHOOK_SIGNATURE_MAX) return undefined
  let t: number | undefined
  const v1: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) return undefined
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") {
      if (t !== undefined || !/^\d{1,12}$/.test(value)) return undefined
      t = Number(value)
    } else if (key === WEBHOOK_SIGNATURE_SCHEME) {
      if (!HEX_SHA256.test(value)) return undefined
      v1.push(value)
    }
  }
  return t !== undefined && v1.length > 0 ? { t, v1 } : undefined
}

/** Whether timestamp `t` (unix seconds) is within `tolerance` seconds of `nowMs`. */
export function webhookTimestampFresh(t: number, nowMs: number = Date.now(), tolerance: number = WEBHOOK_TOLERANCE_SECONDS): boolean {
  return Math.abs(nowMs / 1000 - t) <= tolerance
}
