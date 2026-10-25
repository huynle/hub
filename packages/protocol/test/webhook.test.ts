// Webhook signatures (design §6.1, decision znbg8xa5 #8): every webhook POST carries
// `Hub-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Several v1 values may appear while a
// secret rotates. The protocol package holds the format only; the hub signs and the SDK verifies with real crypto.
import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"

const P = protocol as any
const hex = "a".repeat(64)
const hex2 = "0123456789abcdef".repeat(4)

describe("webhook signature constants", () => {
  test("header names, scheme, algorithm and replay tolerance", () => {
    expect(P.WEBHOOK_SIGNATURE_HEADER).toBe("Hub-Signature")
    expect(P.WEBHOOK_EVENT_HEADER).toBe("Hub-Event")
    expect(P.WEBHOOK_DELIVERY_HEADER).toBe("Hub-Delivery")
    expect(P.WEBHOOK_SIGNATURE_SCHEME).toBe("v1")
    expect(P.WEBHOOK_SIGNATURE_ALGORITHM).toBe("sha256")
    expect(P.WEBHOOK_TOLERANCE_SECONDS).toBe(300)
  })
})

describe("webhook signature format", () => {
  test("the signed payload is the timestamp, a dot and the raw body", () => {
    expect(P.webhookSignedPayload(1700000000, '{"a":1}')).toBe('1700000000.{"a":1}')
  })

  test("formatWebhookSignature and parseWebhookSignature round-trip, with several v1 values", () => {
    expect(P.formatWebhookSignature(1700000000, [hex])).toBe(`t=1700000000,v1=${hex}`)
    const header = P.formatWebhookSignature(1700000000, [hex, hex2])
    expect(header).toBe(`t=1700000000,v1=${hex},v1=${hex2}`)
    expect(P.parseWebhookSignature(header)).toEqual({ t: 1700000000, v1: [hex, hex2] })
  })

  test("parsing tolerates spaces and ignores unknown schemes", () => {
    expect(P.parseWebhookSignature(`t=5, v0=zz, v1=${hex}`)).toEqual({ t: 5, v1: [hex] })
  })

  test("parsing refuses a header without a timestamp or v1, or with bad values", () => {
    for (const bad of ["", `v1=${hex}`, "t=5", `t=x,v1=${hex}`, `t=-1,v1=${hex}`, `t=1.5,v1=${hex}`, "t=5,v1=XYZ", `t=5,v1=${"a".repeat(63)}`, `t=5,t=6,v1=${hex}`, "x".repeat(5000), 7]) {
      expect(P.parseWebhookSignature(bad)).toBeUndefined()
    }
  })

  test("a timestamp is fresh within the tolerance on either side", () => {
    const now = 1_700_000_000_000
    expect(P.webhookTimestampFresh(1_700_000_000, now)).toBe(true)
    expect(P.webhookTimestampFresh(1_700_000_000 - 300, now)).toBe(true)
    expect(P.webhookTimestampFresh(1_700_000_000 - 301, now)).toBe(false)
    expect(P.webhookTimestampFresh(1_700_000_000 + 301, now)).toBe(false)
    expect(P.webhookTimestampFresh(1_700_000_000 - 50, now, 10)).toBe(false)
  })

  test("the format matches an HMAC-SHA256 computed over the signed payload", () => {
    const body = '{"type":"launch","id":"lch_1"}'
    const sig = createHmac(P.WEBHOOK_SIGNATURE_ALGORITHM, "whsec_test").update(P.webhookSignedPayload(1700000000, body)).digest("hex")
    expect(P.parseWebhookSignature(P.formatWebhookSignature(1700000000, [sig]))).toEqual({ t: 1700000000, v1: [sig] })
  })
})
