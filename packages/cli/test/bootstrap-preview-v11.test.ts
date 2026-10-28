// Contract amendment v1.1 in discovery and the preview planner: the canonical snapshot digest, the separate
// enrollment option (so the direct and Ansible paths plan the same digest), escalation_required and
// no_service_manager, unmergeable-format manual edits for TOML configs (with the path in the execution context), and
// hub installs found through the versioned layout's `current` link.
import { describe, expect, test } from "bun:test"
import { planDigest, snapshotDigest as contractSnapshotDigest, type Action, type DiscoverySnapshot, type Profile } from "../src/bootstrap/contracts/index.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { planSetup, previewSetup, renderPreview, revalidateApply, snapshotDigest, type PlanContributor } from "../src/bootstrap/preview/index.ts"
import { ACTIONS, MINUTE, PROFILE_LAUNCH_NODE, PROFILE_SEPARATE_ENROLLMENT, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"
import { dir, exe, file, LINUX_HOME, LINUX_IN_CONTAINER, LINUX_NATIVE, link, MAC_HOME, MAC_NATIVE, MACHO, memoryProbe, type HostSpec } from "./bootstrap/discovery-fixtures.ts"

const NONCE = "nonce-0123456789abcdef"
const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : r.issues!.map((i) => i.code))

function snap(spec: HostSpec, now = T0): DiscoverySnapshot {
  const r = discover(memoryProbe(spec), { now })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const enroll: PlanContributor = () => [ACTIONS["enroll-machine"]]

describe("v1.1 snapshot digest", () => {
  test("the planner pins the contract's canonical snapshot digest", () => {
    expect(snapshotDigest).toBe(contractSnapshotDigest)
    const s = snap(MAC_NATIVE)
    const r = planSetup({ snapshot: s, profile: PROFILE_SESSION_ONLY, links: () => undefined })
    expect(r.ok && r.value.plan.snapshotDigest).toBe(contractSnapshotDigest(s))
  })
})

describe("v1.1 separate enrollment", () => {
  const plan = (profile: Profile, extra: { enrollment?: "inline" | "separate" } = {}) => {
    const r = planSetup({ snapshot: snap(MAC_NATIVE), profile, links: () => undefined, contributors: [enroll], ...extra })
    if (!r.ok) throw new Error(JSON.stringify(r.issues))
    return r.value.plan
  }

  test("inline (the default) keeps enroll-machine", () => {
    expect(plan(PROFILE_LAUNCH_NODE).actions.map((a) => a.kind)).toContain("enroll-machine")
  })

  test("separate leaves enroll-machine out, whether the profile or the caller asks for it", () => {
    expect(plan(PROFILE_SEPARATE_ENROLLMENT).actions.map((a) => a.kind)).not.toContain("enroll-machine")
    expect(plan(PROFILE_LAUNCH_NODE, { enrollment: "separate" }).actions.map((a) => a.kind)).not.toContain("enroll-machine")
  })

  test("a separate-enrollment plan has the digest of the same plan made without the enrollment contributor", () => {
    const separate = plan(PROFILE_LAUNCH_NODE, { enrollment: "separate" })
    const r = planSetup({ snapshot: snap(MAC_NATIVE), profile: PROFILE_LAUNCH_NODE, links: () => undefined })
    expect(r.ok && planDigest(r.value.plan)).toBe(planDigest(separate))
  })

  test("apply re-plans with the same option, so a separate-enrollment preview revalidates", () => {
    const p = previewSetup({ probe: memoryProbe(MAC_NATIVE), profile: PROFILE_LAUNCH_NODE, now: T0, nonce: NONCE, contributors: [enroll], enrollment: "separate" })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const again = revalidateApply({ token: p.value.token, probe: memoryProbe(MAC_NATIVE), profile: PROFILE_LAUNCH_NODE, now: T0 + MINUTE, usedNonces: new Set(), contributors: [enroll], enrollment: "separate" })
    expect(again.ok).toBe(true)
    const inline = revalidateApply({ token: p.value.token, probe: memoryProbe(MAC_NATIVE), profile: PROFILE_LAUNCH_NODE, now: T0 + MINUTE, usedNonces: new Set(), contributors: [enroll] })
    expect(codes(inline)).toEqual(["preview_stale"])
  })
})

describe("v1.1 planner codes", () => {
  test("services on a host without a user service manager: no_service_manager", () => {
    const r = previewSetup({ probe: memoryProbe(LINUX_IN_CONTAINER), profile: PROFILE_LAUNCH_NODE, now: T0, nonce: NONCE })
    expect(codes(r)).toEqual(["no_service_manager"])
  })

  test("an elevated action the profile never allows: escalation_required", () => {
    const elevated: PlanContributor = () => [{ ...(ACTIONS["install-artifact"] as Action), id: "hubctl-system", escalation: "elevated", path: { root: "system-bin", rel: "hubctl" } } as Action]
    const r = previewSetup({ probe: memoryProbe(MAC_NATIVE), profile: PROFILE_SESSION_ONLY, now: T0, nonce: NONCE, contributors: [elevated] })
    expect(codes(r)).toEqual(["escalation_required"])
  })
})

describe("v1.1 unmergeable-format manual edits", () => {
  const codexMerge: PlanContributor = ({ snapshot }) => {
    const config = snapshot.configs.find((c) => c.owner === "harness:codex")
    return [
      {
        id: "codex-hub",
        kind: "merge-config",
        escalation: "user",
        summary: "Enable the hub MCP server in Codex",
        path: { root: "home", rel: ".codex/config.toml" },
        format: "toml",
        owner: "harness:codex",
        precondition: config?.sha256 ? { exists: true, sha256: config.sha256 } : { exists: false },
        set: [{ pointer: "/mcp_servers/hub/enabled", value: true }],
        preserveUnknown: true,
      },
    ]
  }

  test("a TOML merge becomes the exact edit for the file itself and blocks apply", () => {
    const r = previewSetup({ probe: memoryProbe(LINUX_NATIVE), profile: PROFILE_SESSION_ONLY, now: T0, nonce: NONCE, contributors: [codexMerge] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.plan.actions.map((a) => a.id)).not.toContain("codex-hub")
    expect(r.value.blockers).toEqual([
      {
        kind: "manual-edit",
        reason: "unmergeable-format",
        actionID: "codex-hub",
        path: { root: "home", rel: ".codex/config.toml" },
        resolvedPath: `${LINUX_HOME}/.codex/config.toml`,
        format: "toml",
        owner: "harness:codex",
        precondition: (codexMerge({ snapshot: snap(LINUX_NATIVE), profile: PROFILE_SESSION_ONLY })[0] as Extract<Action, { kind: "merge-config" }>).precondition,
        change: { op: "merge", set: [{ pointer: "/mcp_servers/hub/enabled", value: true }] },
      },
    ])
    expect(renderPreview(r.value, LINUX_HOME).join("\n")).toContain("in ~/.codex/config.toml (hubctl cannot edit this format losslessly")
  })

  test("inside a container the edit names the file as this hubctl sees it", () => {
    const spec: HostSpec = { ...LINUX_IN_CONTAINER, files: { ...LINUX_IN_CONTAINER.files, "/workspace/home/.codex/config.toml": file('model = "o4"\n') } }
    const r = previewSetup({ probe: memoryProbe(spec), profile: PROFILE_SESSION_ONLY, now: T0, nonce: NONCE, contributors: [codexMerge] })
    expect(r.ok && r.value.blockers.map((b) => b.resolvedPath)).toEqual(["/workspace/home/.codex/config.toml"])
  })
})

describe("v1.1 discovery of the versioned harness layout", () => {
  test("a harness run through data:hub/harnesses/<id>/current is a hub install of the version it points to", () => {
    const data = `${MAC_HOME}/.local/share/hub/harnesses/opencode`
    const spec: HostSpec = {
      ...MAC_NATIVE,
      env: { ...MAC_NATIVE.env, PATH: `${data}/current/bin:/usr/bin:/bin` },
      files: {
        ...Object.fromEntries(Object.entries(MAC_NATIVE.files).filter(([p]) => !p.includes(".opencode/bin"))),
        [`${data}/2.0.26/bin/opencode`]: exe(MACHO),
        [`${data}/2.0.25`]: dir,
        [`${data}/current`]: link("2.0.26"),
      },
    }
    const opencode = snap(spec).harnesses.find((h) => h.id === "opencode")!
    expect(opencode).toMatchObject({ installed: true, installMethod: "hub", version: "2.0.26" })
  })
})
