// A link a plan replaces is not a link it writes through (HBS-13): link-executable (the hub alias) and
// select-harness-version (the `current` link) replace their own final symlink atomically, so a rerun after an
// install must not refuse them; a symlinked directory above them still is.
import { describe, expect, test } from "bun:test"
import type { Action, PathRef } from "../src/bootstrap/contracts/index.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { DISCOVERY_DARWIN, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"

const LINK: Action = { id: "link-hub", kind: "link-executable", escalation: "user", summary: "Link hub to hubctl", path: { root: "user-bin", rel: "hub" }, target: { root: "user-bin", rel: "hubctl" } }
const plan = (links: (ref: PathRef) => { linkPath: string; resolvedPath: string } | undefined) =>
  planSetup({ snapshot: DISCOVERY_DARWIN, profile: PROFILE_SESSION_ONLY, links, contributors: [() => [LINK]] })

describe("final links a plan replaces", () => {
  test("the hub alias that already is a link is replaced, not refused", () => {
    const r = plan((ref) => (ref.root === "user-bin" && ref.rel === "hub" ? { linkPath: "/Users/dev/.local/bin/hub", resolvedPath: "/Users/dev/.local/bin/hubctl" } : undefined))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.plan.actions.map((a) => a.id)).toContain("link-hub")
  })

  test("a symlinked directory above it is still refused", () => {
    const deep: Action = { ...LINK, path: { root: "user-bin", rel: "sub/hub" } } as Action
    const r = planSetup({ snapshot: DISCOVERY_DARWIN, profile: PROFILE_SESSION_ONLY, links: (ref) => (ref.rel.startsWith("sub") ? { linkPath: "/Users/dev/.local/bin/sub", resolvedPath: "/elsewhere/sub" } : undefined), contributors: [() => [deep]] })
    expect(r.ok).toBe(false)
  })
})
