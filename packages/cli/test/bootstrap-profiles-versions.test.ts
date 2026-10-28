// Profile document versions: loading with an explicit migration trail, the versions this hubctl can read, and
// negotiating a version with a peer. Newer documents are refused, never guessed at.
import { describe, expect, test } from "bun:test"
import { PROFILE_VERSION } from "../src/bootstrap/contracts/index.ts"
import { loadProfile, negotiateProfileVersion, supportedProfileVersions } from "../src/bootstrap/profiles/versions.ts"
import { PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"
import { clone, deepFreeze, MIGRATIONS_FROM_V0, PROFILE_V0, PROFILE_V0_MIGRATED } from "./bootstrap/profiles-fixtures.ts"

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))

describe("loadProfile", () => {
  test("a current document loads unchanged, with an empty migration trail", () => {
    const r = loadProfile(deepFreeze(clone(PROFILE_FULL_HARNESS)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.profile).toEqual(PROFILE_FULL_HARNESS)
    expect(r.value.from).toBe(PROFILE_VERSION)
    expect(r.value.steps).toEqual([])
  })

  test("an older document is migrated one step at a time and the trail is reported", () => {
    const raw = deepFreeze(clone(PROFILE_V0))
    const r = loadProfile(raw, MIGRATIONS_FROM_V0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.profile).toEqual(PROFILE_V0_MIGRATED)
    expect(r.value.from).toBe(0)
    expect(r.value.steps).toEqual([{ from: 0, to: 1 }])
    expect(raw).toEqual(PROFILE_V0)
  })

  test("without a registered migration an older document is unmigratable", () => {
    expect(codes(loadProfile(PROFILE_V0))).toEqual(["unmigratable"])
  })

  test("a document from a newer hubctl is refused, never downgraded", () => {
    expect(codes(loadProfile({ ...PROFILE_SESSION_ONLY, version: PROFILE_VERSION + 1 }))).toEqual(["unsupported_version"])
  })

  test("a migration that does not advance the version is refused", () => {
    expect(codes(loadProfile(PROFILE_V0, { 0: (raw) => raw }))).toEqual(["unmigratable"])
  })

  test("a migrated document is validated like any other", () => {
    const broken = { 0: (raw: Record<string, unknown>) => ({ ...(MIGRATIONS_FROM_V0[0]!(raw) as object), services: ["node"] }) }
    expect(codes(loadProfile(PROFILE_V0, broken))).toContain("inconsistent")
  })

  test("a document without an integer version is invalid", () => {
    expect(codes(loadProfile({ ...PROFILE_SESSION_ONLY, version: "1" }))).toEqual(["invalid_value"])
    expect(codes(loadProfile(null))).toEqual(["invalid_value"])
  })
})

describe("supportedProfileVersions", () => {
  test("this hubctl reads only the current version by default", () => {
    expect(supportedProfileVersions()).toEqual([PROFILE_VERSION])
  })

  test("a version is readable only through an unbroken chain of migrations", () => {
    expect(supportedProfileVersions(MIGRATIONS_FROM_V0)).toEqual([0, 1])
    // -1 → 0 is registered, but 0 → 1 is not: neither is readable.
    expect(supportedProfileVersions({ [-1]: (raw) => ({ ...raw, version: 0 }) })).toEqual([1])
  })
})

describe("negotiateProfileVersion", () => {
  test("picks the highest version both sides understand", () => {
    expect(negotiateProfileVersion([1, 2, 3])).toEqual({ ok: true, value: 1 })
    expect(negotiateProfileVersion([0], MIGRATIONS_FROM_V0)).toEqual({ ok: true, value: 0 })
    expect(negotiateProfileVersion([0, 1], MIGRATIONS_FROM_V0)).toEqual({ ok: true, value: 1 })
  })

  test("only newer versions on offer: this hubctl must be upgraded", () => {
    expect(codes(negotiateProfileVersion([2, 3]))).toEqual(["unsupported_version"])
  })

  test("only older, unmigratable versions on offer", () => {
    expect(codes(negotiateProfileVersion([0]))).toEqual(["unmigratable"])
  })

  test("nothing (or nonsense) on offer is invalid", () => {
    expect(codes(negotiateProfileVersion([]))).toEqual(["invalid_value"])
    expect(codes(negotiateProfileVersion([1.5]))).toEqual(["invalid_value"])
  })
})
