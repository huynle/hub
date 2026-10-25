// Phase 5 (OpenShell sandboxes) protocol: a prepared workspace names its runtime (and sandbox), so collect,
// cleanup, start and stop reach the right runtime without node state; the hub starts and stops a launch's harness
// through the node (start/stop ops, node feature "sandbox"); a spoke started inside a sandbox says which launch it
// belongs to (hello launchID). Older peers keep parsing what they parsed before.
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"

const P = protocol as any
const j = (v: unknown) => JSON.stringify(v)

const prepared = { repo: "/Users/huy/projects/hub", directory: "/Users/huy/projects/hub/.worktrees/feat-x", mode: "worktree", branch: "feat/x", base: "main", head: "0123abcd", reused: false }
const sandboxed = { ...prepared, mode: "clone", directory: "/sandbox/work", runtime: { kind: "openshell", sandbox: "hub-0123456789abcdef0123", profile: "untrusted-code" } }

const fromHub = (m: unknown) => P.parseNodeServerMessage(j(m))
const req = (r: unknown) => fromHub({ t: "req", id: "n1", req: r })

describe("prepared workspace runtime", () => {
  test("a prepared workspace without runtime is a host workspace (phase 4 shape still parses)", () => {
    expect(P.preparedWorkspaceProblem(prepared)).toBeUndefined()
    expect(P.preparedWorkspaceRuntime(prepared)).toEqual({ kind: "host" })
  })

  test("runtime names a known kind, optionally a sandbox and a profile", () => {
    expect(P.preparedWorkspaceProblem(sandboxed)).toBeUndefined()
    expect(P.preparedWorkspaceRuntime(sandboxed)).toEqual(sandboxed.runtime)
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "host" } })).toBeUndefined()
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "openshell" } })).toBeUndefined()
    for (const runtime of ["host", null, {}, { kind: "vm" }, { kind: "openshell", profile: "Bad Profile" }]) {
      expect(P.preparedWorkspaceProblem({ ...prepared, runtime })).toMatch(/runtime/)
    }
  })

  test("the sandbox name is a lowercase DNS label, and only an openshell workspace has one", () => {
    for (const sandbox of ["a", "hub-1", "x".repeat(63), "0abc"]) expect(P.isSandboxName(sandbox)).toBe(true)
    for (const sandbox of ["", "-a", "a-", "A", "a_b", "a.b", "x".repeat(64), "a b", "demo\n", 5]) {
      expect(P.isSandboxName(sandbox)).toBe(false)
      expect(P.preparedWorkspaceProblem({ ...sandboxed, runtime: { kind: "openshell", sandbox } })).toMatch(/sandbox/)
    }
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "host", sandbox: "hub-1" } })).toMatch(/sandbox/)
  })

  test("collect and cleanup carry a sandboxed workspace; prepare may return one", () => {
    expect(req({ op: "collect", launchID: "lch_1", workspace: sandboxed })).toBeDefined()
    expect(req({ op: "cleanup", launchID: "lch_1", workspace: sandboxed, policy: "remove" })).toBeDefined()
    expect(req({ op: "collect", launchID: "lch_1", workspace: { ...sandboxed, runtime: { kind: "openshell", sandbox: "Demo" } } })).toBeUndefined()
    expect(P.nodeResultProblem("prepare", { workspace: sandboxed })).toBeUndefined()
    expect(P.nodeResultProblem("prepare", { workspace: { ...sandboxed, runtime: { kind: "k8s" } } })).toMatch(/runtime/)
  })
})
