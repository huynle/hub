// Native session IDs (a Claude Code UUID, a Codex thread UUIDv7, any other harness ID) mapped to hub session IDs
// (ses_ + letters and digits) and back (decision fx04e42c point 2).
import { describe, expect, test } from "bun:test"
import { isHubSessionID } from "../../protocol/src/index.ts"
import { hubSessionID, nativeSessionID, SESSION_NAMESPACE } from "../src/index.ts"

const UUID = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f"
const UUID7 = "019a2f3c-7b1d-7e2a-8c3d-4e5f6a7b8c9d"

describe("hubSessionID", () => {
  test("a UUID becomes ses_<ns><32 hex> (Claude Code: ses_cc…)", () => {
    expect(hubSessionID("cc", UUID)).toBe("ses_cc3f2b8c1e4d5a4b6c9e7f0a1b2c3d4e5f")
    expect(hubSessionID("cx", UUID7)).toBe("ses_cx019a2f3c7b1d7e2a8c3d4e5f6a7b8c9d")
    expect(isHubSessionID(hubSessionID("cc", UUID))).toBe(true)
  })

  test("UUIDs are canonicalised to lower case", () => {
    expect(hubSessionID("cc", UUID.toUpperCase())).toBe(hubSessionID("cc", UUID))
  })

  test("any other native ID is hex-encoded behind a 0 marker, still a hub session ID", () => {
    const id = hubSessionID("ai", "thread/42 ü")
    expect(id).toBe(`ses_ai0${Buffer.from("thread/42 ü", "utf8").toString("hex")}`)
    expect(isHubSessionID(id)).toBe(true)
  })

  test("is deterministic", () => {
    expect(hubSessionID("cc", UUID)).toBe(hubSessionID("cc", UUID))
    expect(hubSessionID("ai", "x")).toBe(hubSessionID("ai", "x"))
  })

  test("refuses a bad namespace, an empty ID and an ID too long for the hub's rule", () => {
    for (const ns of ["", "c", "ccc", "C1", "c1", "CC", "c-"]) expect(() => hubSessionID(ns, UUID)).toThrow(/namespace/)
    expect(() => hubSessionID("cc", "")).toThrow(/empty/)
    expect(() => hubSessionID("ai", "x".repeat(99))).toThrow(/too long/)
    expect(isHubSessionID(hubSessionID("ai", "x".repeat(98)))).toBe(true)
  })

  test("the namespace rule is two lowercase letters", () => {
    expect(SESSION_NAMESPACE.test("cc")).toBe(true)
    expect(SESSION_NAMESPACE.test("c1")).toBe(false)
  })
})

describe("nativeSessionID", () => {
  test("reverses hubSessionID", () => {
    expect(nativeSessionID("cc", hubSessionID("cc", UUID))).toBe(UUID)
    expect(nativeSessionID("cx", hubSessionID("cx", UUID7))).toBe(UUID7)
    for (const raw of ["thread/42 ü", "x", "a".repeat(98), "0", "deadbeef"]) expect(nativeSessionID("ai", hubSessionID("ai", raw))).toBe(raw)
  })

  test("is undefined for another namespace, an OpenCode ID or a malformed one", () => {
    const cc = hubSessionID("cc", UUID)
    expect(nativeSessionID("cx", cc)).toBeUndefined()
    expect(nativeSessionID("cc", "ses_7f3aKq9")).toBeUndefined()
    expect(nativeSessionID("cc", "ses_cc0")).toBeUndefined()
    expect(nativeSessionID("cc", "ses_cc0abc")).toBeUndefined()
    expect(nativeSessionID("cc", "ses_cc" + "g".repeat(32))).toBeUndefined()
    expect(nativeSessionID("cc", "ses_cc" + "a".repeat(31))).toBeUndefined()
    expect(nativeSessionID("cc", "nope")).toBeUndefined()
    expect(nativeSessionID("cc", 42 as unknown as string)).toBeUndefined()
  })

  test("never collides: a 32-hex UUID form and the 0-marked form differ in length parity", () => {
    const a = hubSessionID("ai", "0123456789abcdef") // 16 bytes → 0 + 32 hex (odd length)
    expect(nativeSessionID("ai", a)).toBe("0123456789abcdef")
    expect(a.length - "ses_ai".length).toBe(33)
  })
})
