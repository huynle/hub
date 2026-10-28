// Planning a persistent launch node: the node.json merge, the hub node and spoke service units (from the embedded
// templates, pinned by digest), activation only on explicit consent, linger only as an opt-in note, and an optional
// bounded verification launch inside a configured workspace root. The plans are deterministic and validate as
// part of planSetup.
import { describe, expect, test } from "bun:test"
import { findSecrets, planDigest, type Action, type InstallService, type Profile } from "../src/bootstrap/contracts/index.ts"
import { nodeServicesContributor, planNodeServices, serviceAssets, type NodeServicesOptions } from "../src/bootstrap/adapters/node-services/plan.ts"
import { renderServiceUnit } from "../src/bootstrap/adapters/node-services/render.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { PROFILE_FULL_HARNESS, PROFILE_LAUNCH_NODE, PROFILE_SESSION_ONLY } from "./bootstrap/fixtures.ts"
import { DISCOVERY_HOST_HARNESS_IN_CONTAINER, DISCOVERY_LINUX, STANDALONE_LINUX } from "./bootstrap/node-services-fixtures.ts"

type R = { ok: boolean; issues?: readonly { code: string }[] }
const codes = (r: R) => (r.ok ? [] : r.issues!.map((i) => i.code))
const value = <T>(r: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const BASE: NodeServicesOptions = { layout: STANDALONE_LINUX, node: { workspaceRoots: ["/home/dev/projects"] } }
const input = (profile: Profile = PROFILE_LAUNCH_NODE, snapshot = DISCOVERY_LINUX) => ({ snapshot, profile })
const kinds = (actions: readonly Action[]) => actions.map((a) => `${a.kind}:${a.id}`)

describe("planNodeServices", () => {
  test("launch-node: the node.json merge and the node unit, not activated without consent", () => {
    const planned = value(planNodeServices(input(), BASE))
    expect(kinds(planned.actions)).toEqual(["ensure-directory:hub-config-dir", "merge-config:node-config", "install-service:install-node-service"])
    const install = planned.actions[2] as InstallService
    const unit = value(renderServiceUnit({ service: "node", manager: "systemd-user", layout: STANDALONE_LINUX, home: "/home/dev", environment: { HUB_CLAUDE_BIN: "/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude" } }))
    expect(install).toMatchObject({ service: "node", manager: "systemd-user", asset: "service/systemd-user/node", path: { root: "systemd-user", rel: "hub-node.service" } })
    // launch-node chooses only OpenCode: the Claude Code binary is carried only for harnesses the profile serves.
    expect(install.sha256).not.toBe(unit.sha256)
    expect(install.sha256).toBe(value(renderServiceUnit({ service: "node", manager: "systemd-user", layout: STANDALONE_LINUX, home: "/home/dev" })).sha256)
    expect(planned.actions[1]).toMatchObject({ format: "json", owner: "hub", path: { root: "config", rel: "hub/node.json" }, precondition: { exists: false }, preserveUnknown: true, set: [{ pointer: "/workspaceRoots", value: ["/home/dev/projects"] }] })
    expect(planned.notes.join("\n")).toContain("--confirm-activation")
  })

  test("full-harness: a unit per service, each carrying its own harness binary", () => {
    const planned = value(planNodeServices(input(PROFILE_FULL_HARNESS), BASE))
    const installs = planned.actions.filter((a): a is InstallService => a.kind === "install-service")
    expect(installs.map((a) => a.service)).toEqual(["node", "claude-code", "codex-spoke"])
    expect(planned.units.find((u) => u.service === "claude-code")!.text).toContain("Environment=HUB_CLAUDE_BIN=/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude")
    expect(planned.units.find((u) => u.service === "node")!.text).toContain("HUB_CLAUDE_BIN=")
    expect(planned.units.find((u) => u.service === "codex-spoke")!.text).not.toContain("HUB_CLAUDE_BIN")
  })

  test("activation and a bounded launch only when asked, the launch inside a workspace root", () => {
    const planned = value(planNodeServices(input(), { ...BASE, activate: true, launch: { harness: "opencode", workspace: { root: "home", rel: "projects/demo" } } }))
    expect(kinds(planned.actions).slice(3)).toEqual(["activate-service:activate-node-service", "launch-session:verify-launch-opencode"])
    expect(planned.actions[3]).toMatchObject({ confirm: "explicit", service: "node", manager: "systemd-user" })
    expect(planned.actions[4]).toMatchObject({ maxDurationS: 3600, harness: "opencode" })
  })

  test("a launch outside the workspace roots, without activation, or for a harness not chosen is refused", () => {
    const launch = (patch: Partial<NonNullable<NodeServicesOptions["launch"]>>, activate = true) =>
      planNodeServices(input(), { ...BASE, activate, launch: { harness: "opencode", workspace: { root: "home", rel: "projects/demo" }, ...patch } })
    expect(codes(launch({ workspace: { root: "home", rel: "elsewhere" } }))).toEqual(["invalid_path"])
    expect(codes(launch({}, false))).toEqual(["inconsistent"])
    expect(codes(launch({ harness: "codex" }))).toEqual(["inconsistent"])
    expect(codes(planNodeServices(input({ ...PROFILE_LAUNCH_NODE, launch: { enabled: false } }), { ...BASE, activate: true, launch: { harness: "opencode", workspace: { root: "home", rel: "projects/demo" } } }))).toEqual([
      "inconsistent",
    ])
  })

  test("linger is opt-in: only a note, never a command hubctl runs", () => {
    const off = value(planNodeServices(input(), BASE))
    const on = value(planNodeServices(input(), { ...BASE, linger: true }))
    expect(off.notes.join("\n")).toContain("stop when you log out")
    expect(on.notes.join("\n")).toContain("loginctl enable-linger")
    expect(kinds(on.actions)).toEqual(kinds(off.actions))
  })

  test("a session-only profile plans nothing", () => {
    expect(value(planNodeServices(input(PROFILE_SESSION_ONLY), BASE)).actions).toEqual([])
  })

  test("the node needs workspace roots, narrow ones", () => {
    expect(codes(planNodeServices(input(), { layout: STANDALONE_LINUX }))).toEqual(["missing_field"])
    expect(codes(planNodeServices(input(), { ...BASE, node: { workspaceRoots: ["/home/dev"] } }))).toEqual(["invalid_path"])
  })

  test("refuses a service that would run outside the harness's context", () => {
    expect(codes(planNodeServices(input({ ...PROFILE_LAUNCH_NODE, harnesses: ["claude-code"] }, DISCOVERY_HOST_HARNESS_IN_CONTAINER), BASE))).toEqual(["inconsistent"])
  })

  test("carries only the service's settings from the user's environment, and never a credential", () => {
    const planned = value(planNodeServices(input(), { ...BASE, environment: { XDG_CONFIG_HOME: "/home/dev/.config", HUB_TOKEN: "mt_should_never_appear", HOME: "/home/dev" } }))
    expect(planned.units[0]!.text).toContain("Environment=XDG_CONFIG_HOME=/home/dev/.config")
    expect(planned.units[0]!.text).not.toContain("mt_")
    expect(findSecrets(planned.actions)).toEqual([])
    expect(codes(planNodeServices(input(), { ...BASE, environment: { XDG_CONFIG_HOME: "mt_abcdefgh123" } }))).toEqual(["secret"])
  })

  test("an existing node.json is merged against its discovered digest", () => {
    const snapshot = { ...DISCOVERY_LINUX, configs: [{ path: "/home/dev/.config/hub/node.json", owner: "hub" as const, format: "json" as const, sha256: `sha256:${"c".repeat(64)}` }] }
    expect(value(planNodeServices(input(PROFILE_LAUNCH_NODE, snapshot), BASE)).actions[1]).toMatchObject({ precondition: { exists: true, sha256: `sha256:${"c".repeat(64)}` } })
  })
})

describe("with planSetup", () => {
  const plan = (options: NodeServicesOptions) => value(planSetup({ ...input(), links: () => undefined, enrollment: "separate", contributors: [nodeServicesContributor(options)] })).plan

  test("valid, ordered plans with exact flags; the same input gives the same digest (idempotent)", () => {
    const options = { ...BASE, activate: true, launch: { harness: "opencode" as const, workspace: { root: "home" as const, rel: "projects/demo" } } }
    const a = plan(options)
    expect(a.activatesServices).toBe(true)
    expect(a.requiresEscalation).toBe(false)
    const order = a.actions.map((x) => x.kind)
    expect(order.indexOf("install-service")).toBeLessThan(order.indexOf("activate-service"))
    expect(order.indexOf("verify-harness")).toBeLessThan(order.indexOf("launch-session"))
    expect(planDigest(plan(options))).toBe(planDigest(a))
    expect(plan(BASE).activatesServices).toBe(false)
  })

  test("the contributor refuses loudly when its options do not plan (validate with planNodeServices first)", () => {
    expect(() => planSetup({ ...input(), links: () => undefined, contributors: [nodeServicesContributor({ layout: STANDALONE_LINUX })] })).toThrow(/missing_field/)
  })
})

describe("serviceAssets", () => {
  test("renders exactly the planned units and node.json for the applier, nothing else", () => {
    const planned = value(planNodeServices(input(PROFILE_FULL_HARNESS), BASE))
    const deps = serviceAssets(planned)
    for (const action of planned.actions.filter((a): a is InstallService => a.kind === "install-service")) {
      const bytes = deps.renderService(action)!
      expect(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`).toBe(action.sha256)
      expect(deps.renderService({ ...action, path: { ...action.path, rel: "evil.service" } })).toBeUndefined()
      expect(deps.renderService({ ...action, asset: "service/launchd/node" })).toBeUndefined()
    }
  })
})
