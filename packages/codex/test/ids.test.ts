// Hub IDs for Codex's native IDs: a thread (UUIDv7) maps to ses_cx<32 hex> and back; other IDs the hub sees
// (approval requests, items, turns, inbox entries) are plain IDs.
import { describe, expect, test } from "bun:test"
import { isHubSessionID } from "../../protocol/src/index.ts"
import { codexSessionID, codexThreadID, plainID, requestKey } from "../src/ids.ts"

const THREAD = "01a174bd-b46a-7531-85b7-7ad9d9830551"

describe("ids", () => {
  test("a thread ID maps to ses_cx<32 hex> and back", () => {
    const id = codexSessionID(THREAD)
    expect(id).toBe("ses_cx01a174bdb46a753185b77ad9d9830551")
    expect(isHubSessionID(id)).toBe(true)
    expect(codexThreadID(id)).toBe(THREAD)
  })

  test("another harness's session ID is not a Codex thread", () => {
    expect(codexThreadID("ses_cc01a174bdb46a753185b77ad9d9830551")).toBeUndefined()
    expect(codexThreadID("ses_abc")).toBeUndefined()
  })

  test("plainID keeps ID characters, replaces the rest, and is never empty", () => {
    expect(plainID("01a174bd-b4b9-7521")).toBe("01a174bd-b4b9-7521")
    expect(plainID("a b\nc")).toBe("a_b_c")
    expect(plainID("")).toMatch(/^id_[0-9a-f]{16}$/)
    expect(plainID("x".repeat(400))).toHaveLength(300)
  })

  test("requestKey names a server request by connection and JSON-RPC id (numbers and strings apart)", () => {
    expect(requestKey("own", 0)).toBe("per_own_n0")
    expect(requestKey("daemon", "abc")).toBe("per_daemon_sabc")
    expect(requestKey("own", 0)).not.toBe(requestKey("own", "0"))
  })
})
