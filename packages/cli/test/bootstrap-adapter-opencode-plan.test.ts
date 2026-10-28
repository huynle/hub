// HBS-06: planning OpenCode for a profile (contract §3.10). The adapter is a pure planner: from the discovery
// snapshot, the profile, the verified hub manifest and a read-only view of the config it already found (pinned by
// the snapshot's digest), it proposes the pinned install, the version switch, the plugin and MCP registrations, and
// real verification. Install alone is never readiness; conflicting configs are refused, never overwritten; a
// config behind a symlink becomes a manual edit through the planner.
import { describe, expect, test } from "bun:test"
import { createAdapterRegistry, validateAction, type Action, type DiscoverySnapshot, type Profile } from "../src/bootstrap/contracts/index.ts"
import { createOpencodeAdapter, OpencodePlanError, planOpencode, type OpencodePlanOptions } from "../src/bootstrap/adapters/opencode/plan.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { inspectLinks } from "../src/bootstrap/preview/links.ts"
import { planSetup } from "../src/bootstrap/preview/plan.ts"
import { MAC_HOME, MAC_NATIVE, MAC_NO_HARNESS, MAC_SYMLINKED_CONFIG, exe, file, link, memoryProbe, MACHO, type HostSpec } from "./bootstrap/discovery-fixtures.ts"
import { PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"
import { CONFIG_WITH_EVERYTHING, PINNED, opencodePin, sha256Of, signedManifest } from "./bootstrap/opencode-adapter-fixtures.ts"

const MANIFEST = signedManifest()
const profile = PROFILE_SESSION_ONLY as Profile

function host(spec: HostSpec) {
  const probe = memoryProbe(spec)
  const snap = discover(probe, { now: T0 })
  if (!snap.ok) throw new Error(JSON.stringify(snap.issues))
  return { probe, snapshot: snap.value }
}

const withFiles = (spec: HostSpec, files: HostSpec["files"], drop: (path: string) => boolean = () => false): HostSpec => ({
  ...spec,
  files: { ...Object.fromEntries(Object.entries(spec.files).filter(([p]) => !drop(p))), ...files },
})

function plan(spec: HostSpec, options: Partial<OpencodePlanOptions> = {}) {
  const { probe, snapshot } = host(spec)
  return { snapshot, probe, result: planOpencode({ snapshot, profile }, { manifest: MANIFEST, readConfig: (p) => probe.readFile(p), ...options }) }
}
const actions = (r: ReturnType<typeof plan>["result"]): Action[] => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.value.actions as Action[]
}
const kinds = (a: readonly Action[]) => a.map((x) => `${x.kind}:${x.id}`)
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

describe("planOpencode", () => {
  test("a clean host: pinned install, then select, then plugin and MCP registration in a new config, then real verification", () => {
    const { result } = plan(MAC_NO_HARNESS)
    const a = actions(result)
    expect(kinds(a)).toEqual(["install-harness:install-opencode", "select-harness-version:select-opencode", "merge-config:opencode-plugin", "register-mcp-server:opencode-mcp", "verify-harness:verify-opencode"])
    for (const action of a) expect(validateAction(action)).toMatchObject({ ok: true })
    const pin = opencodePin("darwin-arm64")
    expect(a[0]).toMatchObject({ harness: "opencode", version: PINNED, target: "darwin-arm64", source: { manifest: "0.8.0", url: pin.url, file: pin.file }, size: pin.size, sha256: pin.sha256, evidence: [], path: { root: "data", rel: `hub/harnesses/opencode/${PINNED}` } })
    expect(a[1]).toMatchObject({ version: PINNED, path: { root: "data", rel: "hub/harnesses/opencode/current" }, target: { root: "data", rel: `hub/harnesses/opencode/${PINNED}` } })
    expect(a[2]).toMatchObject({ path: { root: "config", rel: "opencode/opencode.json" }, format: "json", owner: "harness:opencode", precondition: { exists: false }, set: [{ pointer: "/plugins/-", value: "@huynle/hub" }] })
    expect(a[3]).toMatchObject({ harness: "opencode", name: "hub", path: { root: "config", rel: "opencode/opencode.json" }, precondition: { exists: false } })
    expect(a[4]).toMatchObject({ probes: ["version-exec", "provider-auth", "spoke-connected"] })
  })

  test("pins the plugin to this hubctl's version when asked", () => {
    const a = actions(plan(MAC_NO_HARNESS, { pluginVersion: "0.8.0" }).result)
    expect(a.find((x) => x.id === "opencode-plugin")).toMatchObject({ set: [{ pointer: "/plugins/-", value: "@huynle/hub@0.8.0" }] })
  })

  test("deterministic: the same snapshot and profile give the same actions", () => {
    expect(JSON.stringify(actions(plan(MAC_NO_HARNESS).result))).toBe(JSON.stringify(actions(plan(MAC_NO_HARNESS).result)))
  })

  test("an existing JSONC config is edited in place, pinned by its digest", () => {
    const spec = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.jsonc`]: file(CONFIG_WITH_EVERYTHING) }, (p) => p.endsWith("opencode.json"))
    const a = actions(plan(spec).result)
    const merge = a.find((x) => x.id === "opencode-plugin")
    expect(merge).toMatchObject({ path: { root: "config", rel: "opencode/opencode.jsonc" }, format: "jsonc", precondition: { exists: true, sha256: sha256Of(CONFIG_WITH_EVERYTHING) } })
    expect(a.find((x) => x.id === "opencode-mcp")).toMatchObject({ path: { root: "config", rel: "opencode/opencode.jsonc" }, precondition: { exists: true, sha256: sha256Of(CONFIG_WITH_EVERYTHING) } })
  })

  test("a user-installed OpenCode is kept (no install); only registration and verification are planned", () => {
    const a = actions(plan(MAC_NATIVE).result)
    expect(kinds(a)).toEqual(["merge-config:opencode-plugin", "register-mcp-server:opencode-mcp", "verify-harness:verify-opencode"])
    expect(code(plan(MAC_NATIVE, { manifest: undefined }).result)).toBe("ok")
    expect(kinds(actions(plan(MAC_NATIVE, { install: "always" }).result))[0]).toBe("install-harness:install-opencode")
  })

  test("an already registered config needs no edit: verification still runs (install is never readiness)", () => {
    const registered = JSON.stringify({ plugins: ["@huynle/hub"], mcp: { servers: { hub: { type: "local", command: [`${MAC_HOME}/.local/bin/hubctl`, "mcp"] } } } })
    const spec = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file(registered) })
    expect(kinds(actions(plan(spec).result))).toEqual(["verify-harness:verify-opencode"])
  })

  test("the MCP server points at the stable hubctl authority; hub is an accepted alias, plugin-cache launchers are not", () => {
    const viaHub = JSON.stringify({ mcp: { servers: { hub: { type: "local", command: [`${MAC_HOME}/.local/bin/hub`, "mcp"] } } } })
    const spec = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file(viaHub) })
    expect(kinds(actions(plan(spec, { authority: { root: "user-bin", rel: "hub" } }).result))).not.toContain("register-mcp-server:opencode-mcp")
    expect(kinds(actions(plan(spec).result))).toContain("register-mcp-server:opencode-mcp")
    expect(() => createOpencodeAdapter({ manifest: MANIFEST, readConfig: () => undefined, authority: { root: "state", rel: "hub/bin/hubctl" } })).toThrow(/authority/)
    expect(() => createOpencodeAdapter({ manifest: MANIFEST, readConfig: () => undefined, authority: { root: "data", rel: "opencode/node_modules/@huynle/hub/hubctl" } })).toThrow(/authority/)
  })

  test("a hub-managed install: the pinned version is installed beside the current one and selected; the same version needs nothing", () => {
    const hubInstall = (version: string): HostSpec =>
      withFiles(MAC_NO_HARNESS, {
        [`${MAC_HOME}/.local/share/hub/harnesses/opencode/${version}/bin/opencode`]: exe(MACHO),
        [`${MAC_HOME}/.local/share/hub/harnesses/opencode/current`]: link(version),
        [`${MAC_HOME}/.local/bin/opencode`]: link(`${MAC_HOME}/.local/share/hub/harnesses/opencode/current/bin/opencode`),
      })
    const older = { ...hubInstall("2.1.0"), env: { ...MAC_NO_HARNESS.env, PATH: `${MAC_HOME}/.local/bin:/usr/bin:/bin` } }
    const { snapshot } = host(older)
    expect(snapshot.harnesses.find((h) => h.id === "opencode")).toMatchObject({ installMethod: "hub", version: "2.1.0" })
    expect(kinds(actions(plan(older).result)).slice(0, 2)).toEqual(["install-harness:install-opencode", "select-harness-version:select-opencode"])
    const same = { ...hubInstall(PINNED), env: older.env }
    expect(kinds(actions(plan(same).result))).not.toContain("install-harness:install-opencode")
    // A newer hub-managed version than the pin is never downgraded by planning.
    const newer = { ...hubInstall("2.9.0"), env: older.env }
    expect(kinds(actions(plan(newer).result))).not.toContain("install-harness:install-opencode")
  })

  test("no pin for this host and no OpenCode: refused as unpinned", () => {
    expect(code(plan(MAC_NO_HARNESS, { manifest: signedManifest([opencodePin("linux-x64")]) }).result)).toBe("unpinned_artifact")
    expect(code(plan(MAC_NO_HARNESS, { manifest: undefined }).result)).toBe("unpinned_artifact")
  })

  test("an OpenCode 1.x pin is refused: the Hub plugin needs OpenCode 2", () => {
    expect(code(plan(MAC_NO_HARNESS, { manifest: signedManifest([opencodePin("darwin-arm64", "1.19.5")]) }).result)).toBe("invalid")
  })

  test("conflicts are refused: a duplicate plugin, a foreign server named hub", () => {
    const dup = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file('{ "plugins": ["@huynle/hub", "@huynle/hub@0.7.0"] }') })
    expect(code(plan(dup).result)).toBe("conflict")
    const both = withFiles(MAC_NATIVE, {
      [`${MAC_HOME}/.config/opencode/opencode.json`]: file('{ "plugins": ["@huynle/hub"] }'),
      [`${MAC_HOME}/.config/opencode/opencode.jsonc`]: file('{ "plugins": ["@huynle/hub"] }'),
    })
    expect(code(plan(both).result)).toBe("conflict")
    const foreign = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file('{ "mcp": { "servers": { "hub": { "type": "remote", "url": "https://x.example/mcp" } } } }') })
    expect(code(plan(foreign).result)).toBe("conflict")
  })

  test("version drift: an older pin is updated by one precise set", () => {
    const spec = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file('{ "plugins": ["x", "@huynle/hub@0.7.0"] }') })
    expect(actions(plan(spec, { pluginVersion: "0.8.0" }).result).find((a) => a.id === "opencode-plugin")).toMatchObject({ set: [{ pointer: "/plugins/1", value: "@huynle/hub@0.8.0" }] })
    expect(code(plan(spec, { pluginVersion: "0.6.0" }).result)).toBe("conflict")
  })

  test("a config that changed since discovery (its bytes no longer match the snapshot digest) is stale", () => {
    const { snapshot } = host(MAC_NATIVE)
    const r = planOpencode({ snapshot, profile }, { manifest: MANIFEST, readConfig: () => new TextEncoder().encode('{ "plugins": [] }') })
    expect(code(r)).toBe("preview_stale")
  })

  test("a profile without OpenCode plans nothing", () => {
    const { snapshot } = host(MAC_NO_HARNESS)
    expect(actions(planOpencode({ snapshot, profile: { ...profile, harnesses: ["claude-code"] } as Profile }, { manifest: MANIFEST, readConfig: () => undefined }))).toEqual([])
  })
})

describe("the OpenCode HarnessAdapter in the planner", () => {
  const registry = (probe: ReturnType<typeof memoryProbe>, options: Partial<OpencodePlanOptions> = {}) => {
    const r = createAdapterRegistry()
    r.register(createOpencodeAdapter({ manifest: MANIFEST, readConfig: (p) => probe.readFile(p), ...options }))
    return r
  }

  test("registers as opencode and plans through planSetup in contract order", () => {
    const { probe, snapshot } = host(MAC_NO_HARNESS)
    const r = registry(probe)
    expect(r.list().map((a) => a.id)).toEqual(["opencode"])
    const planned = planSetup({ snapshot, profile, links: inspectLinks(probe, snapshot), adapters: r })
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues))
    expect(planned.value.plan.actions.map((a) => a.id)).toEqual(["state-dir", "install-opencode", "select-opencode", "opencode-plugin", "opencode-mcp", "verify-opencode"])
    expect(planned.value.blockers).toEqual([])
  })

  test("a symlinked config (~/.config/opencode into a dotfiles repo) becomes manual edits; the plan never writes through it", () => {
    const { probe, snapshot } = host(MAC_SYMLINKED_CONFIG)
    const planned = planSetup({ snapshot, profile, links: inspectLinks(probe, snapshot), adapters: registry(probe) })
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues))
    expect(planned.value.plan.actions.map((a) => a.id)).toEqual(["state-dir", "verify-opencode"])
    expect(planned.value.blockers.map((b) => [b.actionID, b.reason, b.resolvedPath, b.change.op])).toEqual([
      ["opencode-plugin", "symlinked-config", `${MAC_HOME}/dot/config/opencode/opencode.json`, "merge"],
      ["opencode-mcp", "symlinked-config", `${MAC_HOME}/dot/config/opencode/opencode.json`, "register-mcp-server"],
    ])
  })

  test("plan() throws a typed refusal for a conflicting config, so the caller reports it (exit 10), never a partial plan", () => {
    const dup = withFiles(MAC_NATIVE, { [`${MAC_HOME}/.config/opencode/opencode.json`]: file('{ "plugins": ["@huynle/hub", "github:huynle/hub"] }') })
    const { probe, snapshot } = host(dup)
    const adapter = createOpencodeAdapter({ manifest: MANIFEST, readConfig: (p) => probe.readFile(p) })
    let error: unknown
    try {
      adapter.plan({ snapshot: snapshot as DiscoverySnapshot, profile })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(OpencodePlanError)
    expect((error as OpencodePlanError).code).toBe("conflict")
  })
})
