// Contract amendment v1.1 in the transactional applier: paths resolve for the execution context (inside a
// container a root is containerPath ?? path), the versioned harness layout's `current` link (select-harness-version)
// with rollback to the previous version, service deactivation and removal with undo, the canonical snapshot digest
// in revalidation, and lossless merges of commented JSONC configs.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { snapshotDigest, type Action, type RootMapping, type SetupPlan } from "../src/bootstrap/contracts/index.ts"
import { ACTIONS, DISCOVERY_DARWIN } from "./bootstrap/fixtures.ts"
import { digestOfText, NODE_JSON, World, type WorldOptions } from "./bootstrap/transaction-fixtures.ts"

let worlds: World[] = []
const world = (options?: WorldOptions) => {
  const w = new World(options)
  worlds.push(w)
  return w
}
afterEach(() => {
  for (const w of worlds) w.cleanup()
  worlds = []
})

const ALL = { confirmActivation: true }
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

/** A plan of just these actions (flags exact). */
const only = (actions: readonly Action[]) => (p: SetupPlan): SetupPlan => ({ ...p, requiresEscalation: false, activatesServices: actions.some((a) => a.kind === "activate-service"), actions: [...actions] })
const WRITE_NODE = { ...(ACTIONS["write-file"] as Extract<Action, { kind: "write-file" }>), sha256: digestOfText(NODE_JSON) } as Action

async function applyOnly(w: World, actions: readonly Action[], patch: Parameters<World["applier"]>[0] = {}) {
  const replan = w.replan(only(actions))
  return w.applier(patch).apply({ token: w.token((await replan()).plan), replan, consent: ALL })
}

describe("v1.1 execution context", () => {
  /** Roots whose host view (`path`) and container view (`containerPath`) are two different directories. */
  const split = (w: World): RootMapping[] => w.box.roots.map((r) => ({ id: r.id, path: r.path.replace(w.box.dir, `${w.box.dir}/host-view`), containerPath: r.path }))

  test("inside a container, apply writes through containerPath", async () => {
    const w = world()
    const r = await applyOnly(w, [ACTIONS["ensure-directory"], WRITE_NODE], { roots: split(w), context: "container" })
    expect(codeOf(r)).toBe("ok")
    expect(w.read("config", "hub/node.json")).toBe(NODE_JSON)
    expect(existsSync(`${w.box.dir}/host-view`)).toBe(false)
  })

  test("on the host, apply writes through path (containerPath is the container's view, not ours)", async () => {
    const w = world()
    const roots = split(w)
    const r = await applyOnly(w, [ACTIONS["ensure-directory"], WRITE_NODE], { roots, context: "host" })
    expect(codeOf(r)).toBe("ok")
    expect(readFileSync(`${roots.find((x) => x.id === "config")!.path}/hub/node.json`, "utf8")).toBe(NODE_JSON)
    expect(existsSync(w.box.path("config", "hub/node.json"))).toBe(false)
  })

  test("the default context is the host", async () => {
    const w = world()
    const roots = split(w)
    expect(codeOf(await applyOnly(w, [WRITE_NODE], { roots }))).toBe("ok")
    expect(existsSync(`${roots.find((x) => x.id === "config")!.path}/hub/node.json`)).toBe(true)
  })
})

describe("v1.1 select-harness-version", () => {
  const current = (w: World) => readlinkSync(w.box.path("data", "hub/harnesses/opencode/current"))

  test("a fresh install becomes current through a relative link", async () => {
    const w = world()
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("ok")
    expect(current(w)).toBe("2.0.26")
    expect(readFileSync(w.box.path("data", "hub/harnesses/opencode/current/bin/opencode"), "utf8")).toBe("#!opencode 2.0.26")
  })

  test("a rollback makes the previous version current again and removes only the new version's directory", async () => {
    const w = world({ verifyFails: true })
    mkdirSync(w.box.path("data", "hub/harnesses/opencode/2.0.25/bin"), { recursive: true })
    writeFileSync(w.box.path("data", "hub/harnesses/opencode/2.0.25/bin/opencode"), "#!opencode 2.0.25")
    symlinkSync("2.0.25", w.box.path("data", "hub/harnesses/opencode/current"))
    const r = await w.applier().apply({ token: w.token(w.plan()), replan: w.replan(), consent: ALL })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(current(w)).toBe("2.0.25")
    expect(existsSync(w.box.path("data", "hub/harnesses/opencode/2.0.26"))).toBe(false)
    expect(readFileSync(w.box.path("data", "hub/harnesses/opencode/2.0.25/bin/opencode"), "utf8")).toBe("#!opencode 2.0.25")
  })

  test("selecting a version that is not installed is refused before anything changes", async () => {
    const w = world()
    const r = await applyOnly(w, [ACTIONS["select-harness-version"], ACTIONS["verify-harness"]])
    expect(codeOf(r)).toBe("not_found")
    expect(existsSync(w.box.path("data", "hub/harnesses/opencode/current"))).toBe(false)
  })
})

describe("v1.1 service deactivation and removal", () => {
  const UNIT = "<plist>codex spoke</plist>\n"
  const unitPath = (w: World) => w.box.path("launch-agents", "io.github.huynle.hub-codex-spoke.plist")
  const seed = (w: World, text = UNIT) => writeFileSync(unitPath(w), text, { mode: 0o644 })
  const deactivate = ACTIONS["deactivate-service"]
  const remove = (sha256: string) => ({ ...(ACTIONS["remove-service"] as Extract<Action, { kind: "remove-service" }>), sha256 }) as Action

  test("deactivates, then removes the unit hub installed", async () => {
    const w = world()
    seed(w)
    const r = await applyOnly(w, [deactivate, remove(digestOfText(UNIT))])
    expect(codeOf(r)).toBe("ok")
    expect(w.calls).toEqual(["deactivate codex-spoke launchd"])
    expect(existsSync(unitPath(w))).toBe(false)
  })

  test("a later failure restores the unit and reactivates the service", async () => {
    const w = world({ verifyFails: true })
    seed(w)
    const r = await applyOnly(w, [deactivate, remove(digestOfText(UNIT)), ACTIONS["verify-harness"]])
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(readFileSync(unitPath(w), "utf8")).toBe(UNIT)
    expect(w.calls).toEqual(["deactivate codex-spoke launchd", "verify opencode", "reactivate codex-spoke launchd"])
  })

  test("a unit the user changed is never removed", async () => {
    const w = world()
    seed(w, "<plist>edited by the user</plist>\n")
    const r = await applyOnly(w, [remove(digestOfText(UNIT))])
    expect(codeOf(r)).toBe("conflict")
    expect(readFileSync(unitPath(w), "utf8")).toBe("<plist>edited by the user</plist>\n")
  })

  test("an already removed unit is nothing to do", async () => {
    const w = world()
    expect(codeOf(await applyOnly(w, [remove(digestOfText(UNIT))]))).toBe("ok")
  })

  test("without a service manager client, deactivation is refused before anything changes", async () => {
    const w = world({ noServiceControl: true })
    seed(w)
    const r = await applyOnly(w, [deactivate, remove(digestOfText(UNIT))])
    expect(codeOf(r)).toBe("internal")
    expect(readFileSync(unitPath(w), "utf8")).toBe(UNIT)
  })
})

describe("v1.1 snapshot digest at apply", () => {
  test("a fresh snapshot that does not match the plan's digest is stale", async () => {
    const w = world()
    const snapshot = { ...DISCOVERY_DARWIN, capturedAt: DISCOVERY_DARWIN.capturedAt + 1 }
    const good = w.replan(only([WRITE_NODE]))
    const fresh = await good()
    const plan = { ...fresh.plan, snapshotDigest: snapshotDigest(snapshot) }
    // The same snapshot captured later is still the same host: it applies.
    const ok = await w.applier().apply({ token: w.token(plan, { snapshotDigest: plan.snapshotDigest }), replan: async () => ({ plan, snapshot }), consent: ALL })
    expect(codeOf(ok)).toBe("ok")
    const changed = { ...snapshot, configs: [] }
    const stale = await w.applier().apply({ token: w.token(plan, { snapshotDigest: plan.snapshotDigest }), replan: async () => ({ plan, snapshot: changed }), consent: ALL })
    expect(codeOf(stale)).toBe("preview_stale")
  })
})

describe("v1.1 JSONC configs", () => {
  test("merges into a commented OpenCode config and keeps every comment", async () => {
    const w = world()
    const text = '// my config\n{\n  "theme": "dark", // keep\n  "plugins": [\n    "x",\n  ],\n}\n'
    writeFileSync(w.box.path("config", "opencode/opencode.json"), text)
    const merge = { ...(ACTIONS["merge-config"] as Extract<Action, { kind: "merge-config" }>), precondition: { exists: true, sha256: digestOfText(text) } } as Action
    expect(codeOf(await applyOnly(w, [merge]))).toBe("ok")
    expect(w.read("config", "opencode/opencode.json")).toBe('// my config\n{\n  "theme": "dark", // keep\n  "plugins": [\n    "x",\n    "@huynle/hub",\n  ],\n}\n')
  })
})
