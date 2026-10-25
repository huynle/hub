// verifyWebhook (design §6.1; decision znbg8xa5 #8): a receiver checks Hub-Signature `t=…,v1=…` (HMAC-SHA256 of
// "<t>.<raw body>") against its secret(s), in constant time, and refuses stale timestamps (replay).
import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { signWebhook, verifyWebhook } from "../src/index.ts"

const SECRET = "whsec_test_secret"
const NOW = 1_800_000_000_000
const T = NOW / 1000
const BODY = JSON.stringify({ type: "launch", launch: { id: "lch_1", state: "running" } })
const hmac = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")

describe("verifyWebhook", () => {
  test("accepts a header the hub would send, from the header value or the request's headers", () => {
    const header = `t=${T},v1=${hmac(SECRET, T, BODY)}`
    expect(verifyWebhook({ body: BODY, signature: header, secret: SECRET, now: NOW })).toEqual({ ok: true, timestamp: T })
    const headers = new Headers({ "hub-signature": header, "hub-event": "launch", "hub-delivery": "dlv_1" })
    expect(verifyWebhook({ body: BODY, headers, secret: SECRET, now: NOW })).toEqual({ ok: true, timestamp: T, event: "launch", delivery: "dlv_1" })
    // A plain object of headers (node's IncomingMessage.headers), any case; bytes as the body.
    const plain = { "Hub-Signature": header, "hub-event": ["launch"] }
    expect(verifyWebhook({ body: new TextEncoder().encode(BODY), headers: plain, secret: SECRET, now: NOW })).toEqual({ ok: true, timestamp: T, event: "launch" })
  })

  test("refuses a changed body, another secret, and a missing or malformed header", () => {
    const header = `t=${T},v1=${hmac(SECRET, T, BODY)}`
    expect(verifyWebhook({ body: `${BODY} `, signature: header, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "mismatch" })
    expect(verifyWebhook({ body: BODY, signature: header, secret: "other", now: NOW })).toEqual({ ok: false, reason: "mismatch" })
    expect(verifyWebhook({ body: BODY, signature: undefined, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "missing" })
    expect(verifyWebhook({ body: BODY, headers: new Headers(), secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "missing" })
    expect(verifyWebhook({ body: BODY, signature: "t=abc,v1=zz", secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "malformed" })
    expect(verifyWebhook({ body: BODY, signature: header, secret: "", now: NOW })).toEqual({ ok: false, reason: "mismatch" })
  })

  test("refuses a timestamp outside the tolerance (default 300 s), either way", () => {
    const old = T - 301
    expect(verifyWebhook({ body: BODY, signature: `t=${old},v1=${hmac(SECRET, old, BODY)}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "stale" })
    const future = T + 301
    expect(verifyWebhook({ body: BODY, signature: `t=${future},v1=${hmac(SECRET, future, BODY)}`, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "stale" })
    expect(verifyWebhook({ body: BODY, signature: `t=${old},v1=${hmac(SECRET, old, BODY)}`, secret: SECRET, now: NOW, tolerance: 600 }).ok).toBe(true)
  })

  test("while a secret rotates: any v1 against any of the receiver's secrets", () => {
    const header = `t=${T},v1=${hmac("old", T, BODY)},v1=${hmac("new", T, BODY)}`
    expect(verifyWebhook({ body: BODY, signature: header, secret: "new", now: NOW }).ok).toBe(true)
    expect(verifyWebhook({ body: BODY, signature: `t=${T},v1=${hmac("old", T, BODY)}`, secret: ["new", "old"], now: NOW }).ok).toBe(true)
  })

  test("signWebhook makes the header verifyWebhook accepts (for tests of receivers)", () => {
    const header = signWebhook(BODY, SECRET, T)
    expect(header).toBe(`t=${T},v1=${hmac(SECRET, T, BODY)}`)
    expect(verifyWebhook({ body: BODY, signature: header, secret: SECRET, now: NOW }).ok).toBe(true)
    expect(signWebhook(BODY, SECRET)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })
})

describe("the SDK and packages/protocol agree on the format", () => {
  test("headers and tolerance; each side reads what the other writes", async () => {
    const protocol = await import("../../protocol/src/webhook.ts")
    const sdk = await import("../src/index.ts")
    expect(sdk.WEBHOOK_SIGNATURE_HEADER).toBe(protocol.WEBHOOK_SIGNATURE_HEADER)
    expect(sdk.WEBHOOK_EVENT_HEADER).toBe(protocol.WEBHOOK_EVENT_HEADER)
    expect(sdk.WEBHOOK_DELIVERY_HEADER).toBe(protocol.WEBHOOK_DELIVERY_HEADER)
    expect(sdk.WEBHOOK_TOLERANCE_SECONDS).toBe(protocol.WEBHOOK_TOLERANCE_SECONDS)
    const header = signWebhook(BODY, SECRET, T)
    expect(protocol.parseWebhookSignature(header)).toEqual({ t: T, v1: [hmac(SECRET, T, BODY)] })
    const theirs = protocol.formatWebhookSignature(T, [createHmac(protocol.WEBHOOK_SIGNATURE_ALGORITHM, SECRET).update(protocol.webhookSignedPayload(T, BODY)).digest("hex")])
    expect(verifyWebhook({ body: BODY, signature: theirs, secret: SECRET, now: NOW }).ok).toBe(true)
    // Malformed for one is malformed for the other.
    for (const bad of ["t=1", "v1=" + "a".repeat(64), "t=1,t=2,v1=" + "a".repeat(64), "t=1,v1=xyz", "x"]) {
      expect(protocol.parseWebhookSignature(bad)).toBeUndefined()
      expect(verifyWebhook({ body: BODY, signature: bad, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: "malformed" })
    }
  })
})
