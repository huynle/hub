import { describe, expect, test } from "bun:test"
import { inspect } from "node:util"
import { SessionTokenStore } from "../src/spoke/session-tokens"

function store(start = 1000) {
  const clock = { now: start }
  return { tokens: new SessionTokenStore(() => clock.now), clock }
}

describe("SessionTokenStore", () => {
  test("stores a token per session until it expires", () => {
    const { tokens, clock } = store()
    expect(tokens.set("ses_a", "tok-a", 2000)).toBe(true)
    expect(tokens.get("ses_a")).toEqual({ token: "tok-a", exp: 2000 })
    expect(tokens.get("ses_b")).toBeUndefined()
    clock.now = 1999
    expect(tokens.get("ses_a")?.token).toBe("tok-a")
    clock.now = 2000
    expect(tokens.get("ses_a")).toBeUndefined()
    expect(tokens.size).toBe(0)
  })

  test("refuses a token that has already expired and keeps the current one", () => {
    const { tokens } = store()
    tokens.set("ses_a", "tok-a", 5000)
    expect(tokens.set("ses_a", "stale", 1000)).toBe(false)
    expect(tokens.set("ses_b", "stale", 999)).toBe(false)
    expect(tokens.get("ses_a")?.token).toBe("tok-a")
    expect(tokens.get("ses_b")).toBeUndefined()
  })

  test("a newer token replaces the older one", () => {
    const { tokens } = store()
    tokens.set("ses_a", "tok-1", 5000)
    tokens.set("ses_a", "tok-2", 4000)
    expect(tokens.get("ses_a")).toEqual({ token: "tok-2", exp: 4000 })
    expect(tokens.size).toBe(1)
  })

  test("expired tokens are dropped lazily from the count", () => {
    const { tokens, clock } = store()
    tokens.set("ses_a", "a", 2000)
    tokens.set("ses_b", "b", 3000)
    expect(tokens.size).toBe(2)
    clock.now = 2500
    expect(tokens.size).toBe(1)
    expect(tokens.sessions()).toEqual(["ses_b"])
  })

  test("delete and clear forget tokens and the hub URL", () => {
    const { tokens } = store()
    tokens.set("ses_a", "a", 2000)
    tokens.set("ses_b", "b", 2000)
    tokens.hubURL = "https://hub.example"
    tokens.delete("ses_a")
    expect(tokens.get("ses_a")).toBeUndefined()
    expect(tokens.get("ses_b")?.token).toBe("b")
    tokens.clear()
    expect(tokens.size).toBe(0)
    expect(tokens.hubURL).toBeUndefined()
  })

  test("never shows tokens in JSON, inspect or string output", () => {
    const { tokens } = store()
    tokens.set("ses_a", "SECRET-TOKEN", 2000)
    tokens.hubURL = "https://hub.example"
    for (const text of [JSON.stringify(tokens), inspect(tokens), String(tokens), Bun.inspect(tokens), JSON.stringify({ nested: tokens })]) {
      expect(text).not.toContain("SECRET-TOKEN")
    }
    expect(JSON.parse(JSON.stringify(tokens))).toEqual({ sessions: 1, hubURL: "https://hub.example" })
  })
})
