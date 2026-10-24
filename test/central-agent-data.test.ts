// Agent data storage rules beyond the store's own tests: role identity with a project scope, holder
// generations, and merging the local user's data into the admin (migrateLocal) when names collide.
import { describe, expect, test } from "bun:test"
import { mergeAgentData, normaliseAgentData } from "../src/central/agent-data"

describe("normaliseAgentData", () => {
  test("a role is unique per (role, project, session): scoped and unscoped claims of one session are both kept", () => {
    const data = normaliseAgentData({
      roles: [
        { role: "reviewer", sessionID: "ses_1", generation: 1 },
        { role: "reviewer", sessionID: "ses_1", project: "hub", generation: 2 },
        { role: "reviewer", sessionID: "ses_1", project: "hub", generation: 3 },
      ],
    })
    expect(data?.roles).toEqual([
      { role: "reviewer", sessionID: "ses_1", generation: 1 },
      { role: "reviewer", sessionID: "ses_1", project: "hub", generation: 2 },
    ])
  })

  test("generations keep non-negative integer counters only", () => {
    expect(normaliseAgentData({ generations: { "reviewer\u0000": 2, bad: -1, worse: "3", frac: 1.5 } })?.generations).toEqual({ "reviewer\u0000": 2 })
    expect(normaliseAgentData({ generations: "junk" })).toEqual({})
  })
})

describe("mergeAgentData (migrateLocal)", () => {
  test("a local name that collides with an admin name for a different session gets a suffix", () => {
    const merged = mergeAgentData(
      { names: [{ name: "api", sessionID: "ses_admin" }, { name: "api-2", sessionID: "ses_other" }] },
      { names: [{ name: "api", sessionID: "ses_local" }, { name: "web", sessionID: "ses_web" }] },
    )
    expect(merged.names).toEqual([
      { name: "api", sessionID: "ses_admin" },
      { name: "api-2", sessionID: "ses_other" },
      { name: "api-3", sessionID: "ses_local" },
      { name: "web", sessionID: "ses_web" },
    ])
  })

  test("the same name for the same session is one entry", () => {
    const merged = mergeAgentData({ names: [{ name: "api", sessionID: "ses_1" }] }, { names: [{ name: "api", sessionID: "ses_1", created: 5 }] })
    expect(merged.names).toEqual([{ name: "api", sessionID: "ses_1" }])
  })

  test("generations merge to the higher counter, so a new holder never reuses one", () => {
    const merged = mergeAgentData({ generations: { a: 3, b: 1 } }, { generations: { a: 2, b: 4, c: 1 } })
    expect(merged.generations).toEqual({ a: 3, b: 4, c: 1 })
  })
})
