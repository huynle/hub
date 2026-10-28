// The reviewed harness pin list (packages/cli/src/bootstrap/release/pins.ts): the checked-in input the release job
// turns into the signed manifest's `harnesses`. Every pin carries its review record; the release job re-downloads
// and digests every pinned file and refuses any mismatch, so a pin nobody checked never gets signed.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { validateArtifactManifest, type HarnessPin, type IssueCode, type Result } from "../src/bootstrap/contracts/index.ts"
import { PIN_LIST_FILE, harnessPins, httpDigest, validatePinList, verifyPinDownloads, type PinList, type PinReview } from "../src/bootstrap/release/pins.ts"
import { digestBytes } from "../src/bootstrap/release/verify.ts"
import { HARNESS_PINS } from "./bootstrap/fixtures.ts"
import { releaseBody } from "./bootstrap/release-fixtures.ts"

const codes = (r: Result<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code))
const expectRejected = (r: Result<unknown>, code: IssueCode) => {
  expect(r.ok).toBe(false)
  expect(codes(r)).toContain(code)
}

const review: PinReview = { by: "octocat", on: "2026-10-28", checked: ["upstream-release", "digest-redownloaded", "evidence-listed"] }
const LIST: PinList = { schema: "hub.harness-pin-list", version: 1, pins: [...HARNESS_PINS].reverse().map((pin) => ({ pin, review })) }
const withPin = (patch: Partial<HarnessPin>, i = 0) => ({ ...LIST, pins: LIST.pins.map((p, j) => (j === i ? { ...p, pin: { ...p.pin, ...patch } } : p)) })
const withReview = (patch: Record<string, unknown>) => ({ ...LIST, pins: LIST.pins.map((p, j) => (j === 0 ? { ...p, review: { ...review, ...patch } } : p)) })

describe("validatePinList", () => {
  test("accepts reviewed pins", () => {
    expect(validatePinList(LIST).ok).toBe(true)
  })

  test("the checked-in pin list is valid", () => {
    const file = path.join(import.meta.dir, "..", "..", "..", PIN_LIST_FILE)
    const r = validatePinList(JSON.parse(readFileSync(file, "utf8")))
    expect(codes(r)).toEqual([])
  })

  test("rejects a wrong schema, unknown fields and a missing review", () => {
    expectRejected(validatePinList({ ...LIST, schema: "hub.pins" }), "invalid_value")
    expectRejected(validatePinList({ ...LIST, version: 2 }), "unsupported_version")
    expectRejected(validatePinList({ ...LIST, extra: 1 }), "unknown_field")
    expectRejected(validatePinList({ ...LIST, pins: [{ pin: HARNESS_PINS[0] }] }), "missing_field")
  })

  test("a pin is checked like the manifest checks it (unsupported target, plain http, ranges, path in file, duplicates)", () => {
    expectRejected(validatePinList(withPin({ target: "linux-x64-musl" })), "unsupported_platform")
    expectRejected(validatePinList(withPin({ url: "http://example.com/opencode.zip", file: "opencode.zip" })), "invalid_value")
    expectRejected(validatePinList(withPin({ version: "^2.0.0" })), "invalid_value")
    expectRejected(validatePinList(withPin({ file: "../opencode" })), "invalid_path")
    expectRejected(validatePinList({ ...LIST, pins: [LIST.pins[0], LIST.pins[0]] }), "duplicate")
    expectRejected(validatePinList(withPin({ evidence: ["sigstore"] } as Partial<HarnessPin>, LIST.pins.findIndex((p) => p.pin.harness === "opencode"))), "invalid_value")
  })

  test("issue paths point into the pin list", () => {
    const r = validatePinList(withPin({ file: "../x" }, 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("/pins/1/pin/file")
  })

  test("the file is the URL's last path segment, and URLs carry no credentials, query or fragment", () => {
    expectRejected(validatePinList(withPin({ file: "other.zip" })), "inconsistent")
    const url = HARNESS_PINS.find((p) => p.harness === LIST.pins[0]!.pin.harness)!.url
    expectRejected(validatePinList(withPin({ url: url.replace("https://", "https://user:pw@") })), "invalid_value")
    expectRejected(validatePinList(withPin({ url: `${url}?token=abc` })), "invalid_value")
    expectRejected(validatePinList(withPin({ url: `${url}#x` })), "invalid_value")
  })

  test("a review names its reviewer and date and records every required check", () => {
    expectRejected(validatePinList(withReview({ by: "not a handle!" })), "invalid_value")
    expectRejected(validatePinList(withReview({ on: "yesterday" })), "invalid_value")
    expectRejected(validatePinList(withReview({ checked: ["upstream-release"] })), "missing_field")
    expectRejected(validatePinList(withReview({ checked: ["upstream-release", "digest-redownloaded", "evidence-listed", "vibes"] })), "invalid_value")
  })

  test("refuses secrets anywhere in the list", () => {
    expectRejected(validatePinList(withReview({ by: "octocat", note: undefined, checked: review.checked, token: "x" })), "unknown_field")
    expectRejected(validatePinList({ ...LIST, pins: LIST.pins.map((p, j) => (j === 0 ? { ...p, review: { ...review, by: "ghp_" + "a".repeat(36) } } : p)) }), "secret")
  })
})

describe("harnessPins", () => {
  test("orders pins by harness order, then target, so the manifest is deterministic", () => {
    const pins = harnessPins(LIST)
    expect(pins.map((p) => p.harness)).toEqual(["opencode", "claude-code", "codex"])
    expect(pins).toEqual([...HARNESS_PINS])
  })

  test("the pins form a valid manifest `harnesses` list", () => {
    expect(validateArtifactManifest({ ...releaseBody("0.8.0", "0.7.0", harnessPins(LIST)), signatures: [] }).ok).toBe(true)
  })
})

describe("verifyPinDownloads", () => {
  const bytes = new TextEncoder().encode("upstream file\n")
  const good = digestBytes(bytes)
  const listFor = (info: { size: number; sha256: string }) => ({ ...LIST, pins: [{ pin: { ...HARNESS_PINS[0]!, ...info }, review }] })

  test("passes when every pinned file re-downloads with its pinned size and digest", async () => {
    const seen: string[] = []
    const r = await verifyPinDownloads(listFor(good), async (url) => (seen.push(url), good))
    expect(r.ok).toBe(true)
    expect(seen).toEqual([HARNESS_PINS[0]!.url])
  })

  test("refuses any mismatch or failed download with integrity_mismatch, and reports every pin", async () => {
    expectRejected(await verifyPinDownloads(listFor(good), async () => ({ ...good, sha256: "sha256:" + "0".repeat(64) })), "integrity_mismatch")
    expectRejected(await verifyPinDownloads(listFor(good), async () => ({ ...good, size: good.size + 1 })), "integrity_mismatch")
    expectRejected(await verifyPinDownloads(listFor(good), async () => { throw new Error("HTTP 404") }), "integrity_mismatch")
    const all = await verifyPinDownloads(LIST, async () => good)
    expect(all.ok).toBe(false)
    if (!all.ok) expect(all.issues.length).toBe(LIST.pins.length)
  })

  test("refuses an invalid list before downloading anything", async () => {
    let called = false
    expectRejected(await verifyPinDownloads({ ...LIST, version: 9 }, async () => ((called = true), good)), "unsupported_version")
    expect(called).toBe(false)
  })
})

describe("httpDigest", () => {
  const body = new TextEncoder().encode("x".repeat(100_000))
  const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/ok" ? new Response(body) : new Response("no", { status: 404 })) })
  afterAll(() => server.stop(true))

  test("streams and digests a download", async () => {
    expect(await httpDigest(`http://127.0.0.1:${server.port}/ok`)).toEqual(digestBytes(body))
  })

  test("throws on an HTTP error", async () => {
    await expect(httpDigest(`http://127.0.0.1:${server.port}/missing`)).rejects.toThrow("404")
  })
})
