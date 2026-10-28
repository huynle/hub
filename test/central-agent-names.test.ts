// Pure helpers for @name / @@role addressing (design §2): name syntax, title placeholders, slugs, suffixes,
// reserved roles and address parsing.
import { describe, expect, test } from "bun:test"
import { deriveName, DERIVED_NAME_MAX, isPlaceholderTitle, isReservedName, isReservedRole, parseAddress, slugify, validName, withSuffix } from "../src/central/agent/names"

describe("validName", () => {
  test("[a-z0-9-], 2–40 characters", () => {
    expect(validName("ab")).toBe(true)
    expect(validName("api-refactor-2")).toBe(true)
    expect(validName("a".repeat(40))).toBe(true)
    expect(validName("a")).toBe(false)
    expect(validName("a".repeat(41))).toBe(false)
    expect(validName("Api")).toBe(false)
    expect(validName("api_refactor")).toBe(false)
    expect(validName("api.hub")).toBe(false)
    expect(validName("")).toBe(false)
  })
})

describe("isPlaceholderTitle", () => {
  test("OpenCode's fallback titles (with and without timestamp), empty and blank titles", () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle("")).toBe(true)
    expect(isPlaceholderTitle("   ")).toBe(true)
    expect(isPlaceholderTitle("New session")).toBe(true)
    expect(isPlaceholderTitle("Child session")).toBe(true)
    expect(isPlaceholderTitle("New session - 2026-10-24T20:43:31.123Z")).toBe(true)
    expect(isPlaceholderTitle("Child session - 2026-10-24T20:43:31.123Z")).toBe(true)
  })

  test("real titles are not placeholders", () => {
    expect(isPlaceholderTitle("Fix the login redirect")).toBe(false)
    expect(isPlaceholderTitle("New session handling")).toBe(false)
  })
})

describe("slugify", () => {
  test("lowercases, folds accents, turns other characters into single dashes, trims dashes", () => {
    expect(slugify("Fix the Login Redirect!")).toBe("fix-the-login-redirect")
    expect(slugify("  Café  déjà vu  ")).toBe("cafe-deja-vu")
    expect(slugify("API/refactor -- v2")).toBe("api-refactor-v2")
  })

  test("at most 40 characters without a trailing dash; undefined when shorter than 2", () => {
    const slug = slugify("word ".repeat(20))!
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith("-")).toBe(false)
    expect(slugify("日本語")).toBeUndefined()
    expect(slugify("x")).toBeUndefined()
  })
})

describe("deriveName", () => {
  test("a short title keeps its words (as slugify)", () => {
    expect(deriveName("Fix the Login Redirect")).toBe("fix-the-login-redirect")
    expect(deriveName("API refactor")).toBe("api-refactor")
    expect(deriveName("Me!")).toBe("me")
  })

  test("drops session-ID-like tokens (ses_…, msg_…, hashes, UUIDs)", () => {
    expect(deriveName("Send hello to session ses_e881b3f3fffei0")).toBe("send-hello-to-session")
    expect(deriveName("Reply to msg_hub01234567890abcdefgh now")).toBe("reply-to-now")
    expect(deriveName("Check 3f2a9c81d0e4b7a6 build")).toBe("check-build")
    expect(deriveName("Look at 123e4567-e89b-12d3-a456-426614174000")).toBe("look-at")
    // Ordinary words with digits stay.
    expect(deriveName("Upgrade to v2 for node20")).toBe("upgrade-to-v2-for")
  })

  test("at most 4 words and DERIVED_NAME_MAX characters, cut at a word boundary", () => {
    expect(DERIVED_NAME_MAX).toBe(24)
    expect(deriveName("Refactor the session list sorting and filtering code")).toBe("refactor-the-session")
    expect(deriveName("Investigate intermittent websocket disconnects")).toBe("investigate-intermittent")
    const name = deriveName("one two three four five six")!
    expect(name).toBe("one-two-three-four")
    // A single word longer than the cap is cut hard (still a valid name, no trailing dash).
    const long = deriveName("Supercalifragilisticexpialidocious-word")!
    expect(long.length).toBeLessThanOrEqual(DERIVED_NAME_MAX)
    expect(validName(long)).toBe(true)
  })

  test("undefined when nothing usable remains", () => {
    expect(deriveName("ses_e881b3f3fffei0")).toBeUndefined()
    expect(deriveName("日本語")).toBeUndefined()
    expect(deriveName("x")).toBeUndefined()
  })
})

describe("withSuffix", () => {
  test("the base when free, else -2, -3, … (cutting the base to stay within 40)", () => {
    expect(withSuffix("api", () => false)).toBe("api")
    expect(withSuffix("api", (n) => n === "api")).toBe("api-2")
    expect(withSuffix("api", (n) => n === "api" || n === "api-2")).toBe("api-3")
    const long = "a".repeat(40)
    const next = withSuffix(long, (n) => n === long)
    expect(next).toBe(`${"a".repeat(38)}-2`)
    expect(validName(next)).toBe(true)
  })
})

describe("isReservedName", () => {
  test("only me (the user's address) is reserved", () => {
    expect(isReservedName("me")).toBe(true)
    expect(isReservedName("me-2")).toBe(false)
    expect(isReservedName("meet")).toBe(false)
    expect(isReservedName("api")).toBe(false)
  })
})

describe("isReservedRole", () => {
  test("roles starting with orchestrator", () => {
    expect(isReservedRole("orchestrator")).toBe(true)
    expect(isReservedRole("orchestrator-2")).toBe(true)
    expect(isReservedRole("orchestrator.project")).toBe(true)
    expect(isReservedRole("reviewer")).toBe(false)
  })
})

describe("parseAddress", () => {
  test("session IDs and ID prefixes", () => {
    expect(parseAddress("ses_8f2a")).toEqual({ kind: "id", id: "ses_8f2a" })
  })

  test("@name and @name.project", () => {
    expect(parseAddress("@api-refactor")).toEqual({ kind: "name", name: "api-refactor" })
    expect(parseAddress("@api-refactor.hub")).toEqual({ kind: "name", name: "api-refactor", project: "hub" })
  })

  test("@@role and @@role.project", () => {
    expect(parseAddress("@@reviewer")).toEqual({ kind: "role", role: "reviewer" })
    expect(parseAddress("@@reviewer.hub")).toEqual({ kind: "role", role: "reviewer", project: "hub" })
  })

  test("project scopes are lowercased; anything else is undefined", () => {
    expect(parseAddress("@api.Hub")).toEqual({ kind: "name", name: "api", project: "hub" })
    expect(parseAddress("@API")).toBeUndefined()
    expect(parseAddress("@a")).toBeUndefined()
    expect(parseAddress("@@")).toBeUndefined()
    expect(parseAddress("@api.")).toBeUndefined()
    expect(parseAddress("ses_")).toBeUndefined()
    expect(parseAddress("ses_a/b")).toBeUndefined()
    expect(parseAddress("hello")).toBeUndefined()
    expect(parseAddress("")).toBeUndefined()
  })
})
