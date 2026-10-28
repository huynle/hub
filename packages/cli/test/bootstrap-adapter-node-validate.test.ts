// The node-services adapter only configures narrow launch nodes (workspace roots that are real project
// directories, never / or the whole home; bounded slots; plain labels), and only installs a service where it runs
// in the same runtime and filesystem context as the harness it serves: a host service for a harness that lives in a
// container (the brain-runner lesson), or a container's unit written into the host's unit directory, is refused.
import { describe, expect, test } from "bun:test"
import { DEFAULT_SLOTS, normalizeNodeConfig } from "../../node/src/config.ts"
import { checkNodeSettings, renderNodeConfig, serviceContextOf } from "../src/bootstrap/adapters/node-services/validate.ts"
import {
  DISCOVERY_CONTAINER_HOST_UNITS,
  DISCOVERY_HOST_HARNESS_IN_CONTAINER,
  DISCOVERY_IN_CONTAINER,
  DISCOVERY_LINUX,
  STANDALONE_LINUX,
} from "./bootstrap/node-services-fixtures.ts"
import { DISCOVERY_DARWIN } from "./bootstrap/fixtures.ts"

type R = { ok: boolean; issues?: readonly { code: string; path: string }[] }
const codes = (r: R) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const linux = { snapshot: DISCOVERY_LINUX }
const settings = (patch: Record<string, unknown> = {}) => ({ workspaceRoots: ["/home/dev/projects"], ...patch })

describe("node settings", () => {
  test("a narrow root, default slots, no labels", () => {
    expect(value(checkNodeSettings(settings(), linux))).toEqual({ workspaceRoots: ["/home/dev/projects"], slots: DEFAULT_SLOTS, labels: {} })
  })

  test("broad roots are refused: /, a top-level directory, the home, its parents, another user's home", () => {
    for (const root of ["/", "/srv", "/home", "/home/dev", "/home/other"]) expect(codes(checkNodeSettings(settings({ workspaceRoots: [root] }), linux))).toEqual(["invalid_path"])
  })

  test("hub's own directories are not workspaces", () => {
    for (const root of ["/home/dev/.config", "/home/dev/.config/hub", "/home/dev/.local/state/hub", "/home/dev/.local/bin", "/home/dev/.config/systemd/user"])
      expect(codes(checkNodeSettings(settings({ workspaceRoots: [root] }), linux))).toEqual(["invalid_path"])
  })

  test("relative, unnormalized and multi-line roots are refused", () => {
    for (const root of ["projects", "/home/dev/../dev/projects", "/home/dev/projects/", "/home/dev/a\nb", 7])
      expect(codes(checkNodeSettings(settings({ workspaceRoots: [root] }), linux))).toEqual(["invalid_path"])
  })

  test("no roots, duplicates and nested roots are refused", () => {
    expect(codes(checkNodeSettings(settings({ workspaceRoots: [] }), linux))).toEqual(["invalid_value"])
    expect(codes(checkNodeSettings({}, linux))).toEqual(["missing_field"])
    expect(codes(checkNodeSettings(settings({ workspaceRoots: ["/home/dev/projects", "/home/dev/projects"] }), linux))).toEqual(["duplicate"])
    expect(codes(checkNodeSettings(settings({ workspaceRoots: ["/home/dev/projects", "/home/dev/projects/hub"] }), linux))).toEqual(["duplicate"])
  })

  test("slots are bounded whole numbers", () => {
    expect(value(checkNodeSettings(settings({ slots: 2 }), linux)).slots).toBe(2)
    for (const slots of [0, -1, 1.5, 65, 10_000, "4"]) expect(codes(checkNodeSettings(settings({ slots }), linux))).toEqual(["invalid_value"])
  })

  test("labels are plain, never the node's own os/arch, never a credential", () => {
    expect(value(checkNodeSettings(settings({ labels: { gpu: "no", team: "infra" } }), linux)).labels).toEqual({ gpu: "no", team: "infra" })
    expect(codes(checkNodeSettings(settings({ labels: { "bad key!": "x" } }), linux))).toEqual(["invalid_value"])
    expect(codes(checkNodeSettings(settings({ labels: { os: "linux" } }), linux))).toEqual(["invalid_value"])
    expect(codes(checkNodeSettings(settings({ labels: { token: "mt_abcdefgh1234" } }), linux))).toEqual(["secret"])
  })

  test("unknown fields are refused", () => {
    expect(codes(checkNodeSettings(settings({ command: "rm -rf" }), linux))).toContain("unknown_field")
  })

  test("inside a container, a root given as the host's path is refused (the container sees it elsewhere)", () => {
    const container = { snapshot: DISCOVERY_IN_CONTAINER }
    expect(value(checkNodeSettings({ workspaceRoots: ["/workspace/home/projects"] }, container)).workspaceRoots).toEqual(["/workspace/home/projects"])
    expect(codes(checkNodeSettings({ workspaceRoots: ["/srv/dev/projects"] }, container))).toEqual(["inconsistent"])
    expect(codes(checkNodeSettings({ workspaceRoots: ["/workspace/home"] }, container))).toEqual(["invalid_path"])
  })

  test("node.json renders deterministically and the node reads it without problems", () => {
    const normalized = value(checkNodeSettings(settings({ labels: { zone: "b", gpu: "no" }, slots: 3 }), linux))
    const a = renderNodeConfig(normalized)
    const b = renderNodeConfig({ ...normalized, labels: { gpu: "no", zone: "b" } })
    expect(a.text).toBe(b.text)
    expect(a.text).toBe('{\n  "workspaceRoots": [\n    "/home/dev/projects"\n  ],\n  "slots": 3,\n  "labels": {\n    "gpu": "no",\n    "zone": "b"\n  }\n}\n')
    expect(a.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    const read = normalizeNodeConfig(JSON.parse(a.text))
    expect(read.problems).toEqual([])
    expect(read.config).toEqual({ workspaceRoots: ["/home/dev/projects"], slots: 3, labels: { gpu: "no", zone: "b" } })
  })
})

describe("same runtime context", () => {
  test("a host with its harness on the host: the host's manager, home and harness binary", () => {
    const ctx = value(serviceContextOf({ snapshot: DISCOVERY_LINUX, harnesses: ["opencode", "claude-code"], layout: STANDALONE_LINUX }))
    expect(ctx).toEqual({
      context: "host",
      manager: "systemd-user",
      home: "/home/dev",
      harnessBins: { opencode: "/home/dev/.opencode/bin/opencode", "claude-code": "/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude" },
    })
  })

  test("refuses a host service for a harness that lives in a container (brain-runner)", () => {
    const r = serviceContextOf({ snapshot: DISCOVERY_HOST_HARNESS_IN_CONTAINER, harnesses: ["claude-code"], layout: STANDALONE_LINUX })
    expect(codes(r)).toEqual(["inconsistent"])
    expect(r.ok ? "" : JSON.stringify(r.issues)).toContain("container")
  })

  test("inside a container with its own manager: the container's view of home", () => {
    const layout = { kind: "standalone" as const, executable: "/workspace/home/.local/bin/hubctl" }
    const ctx = value(serviceContextOf({ snapshot: DISCOVERY_IN_CONTAINER, harnesses: ["claude-code"], layout }))
    expect(ctx.context).toBe("container")
    expect(ctx.home).toBe("/workspace/home")
  })

  test("refuses a container whose unit directory is the host's (the host would run it with container paths)", () => {
    const layout = { kind: "standalone" as const, executable: "/workspace/home/.local/bin/hubctl" }
    expect(codes(serviceContextOf({ snapshot: DISCOVERY_CONTAINER_HOST_UNITS, harnesses: ["claude-code"], layout }))).toEqual(["inconsistent"])
  })

  test("refuses a program path from the other side of a container mount", () => {
    const layout = { kind: "standalone" as const, executable: "/srv/dev/.local/bin/hubctl" }
    expect(codes(serviceContextOf({ snapshot: DISCOVERY_IN_CONTAINER, harnesses: ["claude-code"], layout }))).toEqual(["inconsistent"])
  })

  test("no user service manager, or one that does not match the platform", () => {
    expect(codes(serviceContextOf({ snapshot: { ...DISCOVERY_LINUX, managers: { ...DISCOVERY_LINUX.managers, service: "none" } }, harnesses: ["opencode"], layout: STANDALONE_LINUX }))).toEqual([
      "no_service_manager",
    ])
    expect(codes(serviceContextOf({ snapshot: { ...DISCOVERY_LINUX, managers: { ...DISCOVERY_LINUX.managers, service: "launchd" } }, harnesses: ["opencode"], layout: STANDALONE_LINUX }))).toEqual([
      "inconsistent",
    ])
  })

  test("the unit directory must be mapped", () => {
    expect(codes(serviceContextOf({ snapshot: { ...DISCOVERY_DARWIN, roots: DISCOVERY_DARWIN.roots.filter((r) => r.id !== "launch-agents") }, harnesses: ["opencode"], layout: { kind: "standalone", executable: "/Users/dev/.local/bin/hubctl" } }))).toEqual([
      "unmapped_root",
    ])
  })
})
