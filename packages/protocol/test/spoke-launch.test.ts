// Spoke feature "launch" (design §6.4 host runtime): the hub creates a launched session through the service spoke's
// create op, extended with the launch's agent, model and launch ID. Older spokes ignore unknown create fields, so
// the hub sends them only to spokes that announce "launch".
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { IMPLIED_OPENCODE_FEATURES, KNOWN_SPOKE_FEATURES, parseServerMessage, requestFeatures, spokeFeatures, type ServerRequest } from "../src/index.ts"

const j = (v: unknown) => JSON.stringify(v)
const frame = (req: unknown) => j({ t: "req", id: "c1", req })
const parses = (req: unknown) => parseServerMessage(frame(req)) !== undefined
const create = (extra: Record<string, unknown> = {}) => ({ op: "create", directory: "/Users/huy/projects/hub/.worktrees/feat-x", title: "api-refactor", ...extra })
const model = { providerID: "anthropic", modelID: "claude-sonnet", variant: "high" }

describe("create with launch fields", () => {
  test("a create may carry the launch ID, agent and model; it round-trips", () => {
    const req = create({ launchID: "lch_01HX", agent: "build", model })
    expect(parseServerMessage(frame(req))).toEqual({ t: "req", id: "c1", req } as any)
    const typed: ServerRequest = { op: "create", directory: "/d", launchID: "lch_1", agent: "build", model: { providerID: "p", modelID: "m" } }
    expect(typed.op).toBe("create")
  })

  test("launchID is a plain id; agent a short name; model a model selection", () => {
    for (const launchID of ["", "a b", "x".repeat(301), 5, "a\u202e"]) expect(parses(create({ launchID }))).toBe(false)
    for (const agent of ["", "-x", "x".repeat(101), "a\nb", "a\u200b", 3]) expect(parses(create({ agent }))).toBe(false)
    for (const bad of ["anthropic/claude", { providerID: "p" }, { providerID: "p", modelID: "m m" }, null]) expect(parses(create({ model: bad }))).toBe(false)
    expect(parses(create({ agent: "tdd-dev" }))).toBe(true)
    expect(parses(create({ agent: "x".repeat(100) }))).toBe(true)
  })

  test("launch is an announced spoke feature, never implied for old spokes", () => {
    expect(KNOWN_SPOKE_FEATURES as readonly string[]).toContain("launch")
    expect(IMPLIED_OPENCODE_FEATURES as readonly string[]).not.toContain("launch")
    const oldHello = { t: "hello", v: 1, processID: "p", kind: "service", directory: "/", pid: 1, mode: "always", opencodeVersion: "2.0", pluginVersion: "0.5" } as any
    expect(spokeFeatures(oldHello).has("launch")).toBe(false)
  })

  test("requestFeatures: a create with any launch field needs create and launch; a plain create needs create", () => {
    expect(requestFeatures(create() as ServerRequest)).toEqual(["create"])
    for (const extra of [{ launchID: "lch_1" }, { agent: "build" }, { model }]) expect(requestFeatures(create(extra) as ServerRequest)).toEqual(["create", "launch"])
  })

  test("isLaunchCreate tells a launch create apart", () => {
    expect((protocol as any).isLaunchCreate(create({ launchID: "lch_1" }))).toBe(true)
    expect((protocol as any).isLaunchCreate(create())).toBe(false)
  })
})
