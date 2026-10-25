// Phase 4 launch types (design §6.1, §6.4): the vocabulary shared by the launch API, the hub's launch engine, the
// node and the spoke, and the wire-level checks of a launch workspace (git hardening: no option injection, refs
// check-ref-format would accept, https/ssh remotes only).
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"

const P = protocol as any
const ws = (extra: Record<string, unknown> = {}) => ({ repo: "/Users/huy/projects/hub", mode: "worktree", branch: "feat/x", base: "main", ...extra })

describe("launch vocabulary", () => {
  test("states, outcomes and the spec's enumerations", () => {
    expect(P.LAUNCH_STATES).toEqual(["queued", "placing", "provisioning", "running", "ended"])
    expect(P.LAUNCH_OUTCOMES).toEqual(["idle", "needs_user", "failed", "timeout", "stopped", "lost"])
    expect(P.WORKSPACE_MODES).toEqual(["worktree", "checkout", "clone"])
    expect(P.RUNTIME_KINDS).toEqual(["host", "openshell"])
    expect(P.PLACEMENT_MODES).toEqual(["require", "prefer"])
    expect(P.LAUNCH_END_WHEN).toEqual(["idle", "asked", "never"])
    expect(P.CLEANUP_POLICIES).toEqual(["keep", "remove"])
  })

  test("a LaunchSpec is the launch body without a grant (phase 4)", () => {
    const spec: protocol.LaunchSpec = {
      key: "brain-abc",
      name: "api-refactor",
      roles: ["reviewer.hub"],
      harness: "opencode",
      agent: "build",
      model: "anthropic/claude",
      workspace: { repo: "/r", mode: "worktree", branch: "feat/x", base: "main" },
      runtime: { kind: "host" },
      placement: { labels: { os: "darwin" }, machine: "mbp", mode: "require" },
      prompt: "do it",
      labels: { app: "brain", "brain.task": "abc" },
      end: { when: "idle", timeout: "4h", cleanup: "keep" },
    }
    const launch: protocol.LaunchInfo = { id: "lch_1", state: "ended", reason: "idle 30 s", spec, created: 1, updated: 2, outcome: "idle", artifacts: { branch: "feat/x", head: "abc123" } }
    expect(launch.outcome).toBe("idle")
    // @ts-expect-error the grant field is not part of a phase 4 launch
    const withGrant: protocol.LaunchSpec = { ...spec, grant: "g_1" }
    expect(withGrant).toBeDefined()
  })
})

describe("launchWorkspaceProblem", () => {
  test("accepts each mode with an absolute repo", () => {
    expect(P.launchWorkspaceProblem(ws())).toBeUndefined()
    expect(P.launchWorkspaceProblem({ repo: "/r", mode: "checkout" })).toBeUndefined()
    expect(P.launchWorkspaceProblem({ repo: "/r/clone", mode: "clone", remote: "git@github.com:huynle/hub.git" })).toBeUndefined()
    expect(P.launchWorkspaceProblem({ repo: "/r/clone", mode: "clone", remote: "https://github.com/huynle/hub.git" })).toBeUndefined()
    expect(P.launchWorkspaceProblem({ repo: "/r/clone", mode: "clone", remote: "ssh://git@host:22/x.git" })).toBeUndefined()
  })

  test("the repo is an absolute, normal path", () => {
    for (const repo of ["", "rel/path", "/a/../b", "/a/./b", "/a\u0000b", "/a\nb", 5, "/" + "x".repeat(4096)]) {
      expect(P.launchWorkspaceProblem(ws({ repo }))).toMatch(/repo/)
    }
  })

  test("mode is one of the workspace modes; clone needs a remote", () => {
    expect(P.launchWorkspaceProblem(ws({ mode: "copy" }))).toMatch(/mode/)
    expect(P.launchWorkspaceProblem({ repo: "/r", mode: "clone" })).toMatch(/remote/)
  })

  test("branch and base are refs git check-ref-format would accept, never an option", () => {
    for (const branch of ["feat/x", "p4/t1-protocol", "release-1.2", "a_b"]) expect(P.launchWorkspaceProblem(ws({ branch }))).toBeUndefined()
    for (const branch of ["", "-x", "--upload-pack=evil", "a..b", "a//b", "a/", "/a", "a.", ".a", "a/.b", "a.lock", "a@{1}", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "@", "x".repeat(201), 7]) {
      expect(P.launchWorkspaceProblem(ws({ branch }))).toMatch(/branch/)
      expect(P.launchWorkspaceProblem(ws({ base: branch }))).toMatch(/base/)
    }
  })

  test("remote is an https or ssh URL, or scp-style user@host:path; never an option or another protocol", () => {
    for (const remote of ["-oProxyCommand=evil", "file:///etc", "ext::sh -c evil", "http://h/x.git", "git://h/x", "fd::3", "https://", "git@host", "a b@host:x", "https://h/x\n", "https://h/" + "x".repeat(2048), 1]) {
      expect(P.launchWorkspaceProblem({ repo: "/r", mode: "clone", remote })).toMatch(/remote/)
    }
  })
})

describe("launch labels", () => {
  test("labelsProblem accepts short keys and printable values", () => {
    expect(P.labelsProblem({ app: "brain", "brain.task": "abc", "hub.dev/os": "darwin" })).toBeUndefined()
    expect(P.labelsProblem({})).toBeUndefined()
  })

  test("keys are 1–63 token characters, values at most 256 printable characters, at most 32 labels", () => {
    expect(P.LABELS_MAX).toBe(32)
    for (const bad of [{ "": "x" }, { "-a": "x" }, { "a b": "x" }, { ["k".repeat(64)]: "x" }, { a: 5 }, { a: "x".repeat(257) }, { a: "x\u202e" }, { a: "x\ny" }]) {
      expect(P.labelsProblem(bad)).toBeDefined()
    }
    expect(P.labelsProblem(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"])))).toMatch(/32/)
    expect(P.labelsProblem([])).toBeDefined()
    expect(P.labelsProblem(null)).toBeDefined()
  })
})
