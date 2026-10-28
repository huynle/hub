import { describe, expect, test } from "bun:test"
import { ArchiveInactive } from "../src/central/agent/archive-inactive"

const T0 = 1_800_000_000_000
const sessions = [
  { sessionID: "ses_old", online: false, lastSeen: T0 - 10_000, roles: [] },
  { sessionID: "ses_recent", online: false, lastSeen: T0 - 100, roles: [] },
  { sessionID: "ses_pinned", online: false, lastSeen: T0 - 10_000, roles: [] },
]

describe("inactive archive preview", () => {
  test("preview is bounded, exact, signed and writes nothing", () => {
    const a = new ArchiveInactive({ secret: Buffer.alloc(32, 7), now: () => T0 })
    const p = a.preview("u1", sessions, { pinned: new Set(["ses_pinned"]), archived: new Set(), inactiveForMs: 1000, limit: 1 })
    expect(p.candidates).toEqual(["ses_old"])
    expect(p.previewToken).toMatch(/^hai1_/)
    expect(() => a.decode("u2", p.previewToken)).toThrow()
    expect(() => a.decode("u1", p.previewToken + "x")).toThrow()
  })

  test("apply revalidates the exact preview set and reports skip reasons", () => {
    let now = T0
    const a = new ArchiveInactive({ secret: Buffer.alloc(32, 8), now: () => now })
    const p = a.preview("u1", sessions, { pinned: new Set(), archived: new Set(), inactiveForMs: 1000, limit: 10 })
    expect(p.candidates).toEqual(["ses_old", "ses_pinned"])
    const result = a.revalidate("u1", p.previewToken, sessions, { pinned: new Set(["ses_old"]), archived: new Set(["ses_pinned"]), open: new Set(), active: new Set() })
    expect(result).toEqual({ candidates: [], skipped: [{ sessionID: "ses_old", reason: "pinned" }, { sessionID: "ses_pinned", reason: "archived" }] })
    now += 6 * 60_000
    expect(() => a.decode("u1", p.previewToken)).toThrow()
  })
})
