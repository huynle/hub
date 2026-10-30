// The plan contributors the CLI adds beside the harness adapters and node services (HBS-13):
//   hubctlContributor     with a verified manifest that pins hubctl for this host: install-artifact into
//                         user-bin:hubctl (the stable authority services and MCP clients run), then the hub alias
//                         (link-executable user-bin:hub → user-bin:hubctl). Without one: nothing.
//   enrollmentContributor inline enrollment: one enroll-machine for the given hub, only while the machine is not
//                         enrolled with it. Never a credential in the action.
//   refusing              turns a contributor's Result refusal into a typed PlanRefusal (planSetup has no refusal
//                         channel for contributors), so the CLI maps it through exitFor instead of crashing.
import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { findSecrets, manifestPayload, validateAction, verifyManifest, type Action, type ArtifactManifest, type PlanInput, type VerifiedManifest } from "../src/bootstrap/contracts/index.ts"
import { enrollmentContributor, harnessLinkContributor, hubctlContributor, PlanRefusal, refusing, type PathInspector } from "../src/setup/contributors.ts"
import { ACTIONS, DISCOVERY_DARWIN, MANIFEST_UNSIGNED, PROFILE_FULL_HARNESS, PROFILE_SESSION_ONLY, TRUST_ROOT_TEMPLATE } from "./bootstrap/fixtures.ts"

function verified(body: Omit<ArtifactManifest, "signatures"> = MANIFEST_UNSIGNED): VerifiedManifest {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const manifest = { ...body, signatures: [{ keyID: "hub-release-1", algorithm: "ed25519" as const, value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }] }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const r = verifyManifest(manifest, root)
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

const input: PlanInput = { snapshot: DISCOVERY_DARWIN, profile: PROFILE_SESSION_ONLY }

describe("hubctlContributor", () => {
  test("installs the pinned hubctl for this target into user-bin:hubctl and links hub to it", () => {
    const manifest = verified()
    const actions = hubctlContributor({ manifest })(input)
    expect(actions.map((a) => a.kind)).toEqual(["install-artifact", "link-executable"])
    const [install, link] = actions as [Extract<(typeof actions)[number], { kind: "install-artifact" }>, Extract<(typeof actions)[number], { kind: "link-executable" }>]
    const pinned = MANIFEST_UNSIGNED.artifacts.find((a) => a.target === DISCOVERY_DARWIN.host.target)!
    expect(install).toMatchObject({ artifact: "hubctl", version: "0.8.0", target: DISCOVERY_DARWIN.host.target, sha256: pinned.sha256, path: { root: "user-bin", rel: "hubctl" } })
    expect(link).toMatchObject({ path: { root: "user-bin", rel: "hub" }, target: { root: "user-bin", rel: "hubctl" } })
    for (const a of actions) expect(validateAction(a).ok).toBe(true)
  })

  test("no manifest, or no artifact for this target: nothing", () => {
    expect(hubctlContributor({})(input)).toEqual([])
    const other = verified({ ...MANIFEST_UNSIGNED, artifacts: MANIFEST_UNSIGNED.artifacts.filter((a) => a.target !== DISCOVERY_DARWIN.host.target) })
    expect(hubctlContributor({ manifest: other })(input)).toEqual([])
  })
})

// HBS-12 acceptance (E3): a converged host plans no hubctl install and no hub link, whatever path the hubctl that
// previews runs from: the installed file is compared by digest with the pinned artifact, the link by its target.
describe("hubctlContributor on a converged host", () => {
  const pinned = MANIFEST_UNSIGNED.artifacts.find((a) => a.target === DISCOVERY_DARWIN.host.target)!
  const inspector = (files: Record<string, string>, links: Record<string, string>) => ({
    sha256: (ref: { root: string; rel: string }) => files[`${ref.root}:${ref.rel}`],
    linksTo: (ref: { root: string; rel: string }, target: { root: string; rel: string }) => links[`${ref.root}:${ref.rel}`] === `${target.root}:${target.rel}`,
  })

  test("the pinned hubctl already installed and hub linked to it: nothing", () => {
    const installed = inspector({ "user-bin:hubctl": pinned.sha256 }, { "user-bin:hub": "user-bin:hubctl" })
    expect(hubctlContributor({ manifest: verified(), installed })(input)).toEqual([])
  })

  test("the pinned hubctl installed, the link missing or elsewhere: only the link", () => {
    for (const links of [{}, { "user-bin:hub": "home:elsewhere" }] as Record<string, string>[]) {
      const actions = hubctlContributor({ manifest: verified(), installed: inspector({ "user-bin:hubctl": pinned.sha256 }, links) })(input)
      expect(actions.map((a) => a.id)).toEqual(["link-hub"])
    }
  })

  test("another hubctl (other bytes) or none: installed, and linked when needed", () => {
    const other = `sha256:${"ab".repeat(32)}`
    expect(hubctlContributor({ manifest: verified(), installed: inspector({ "user-bin:hubctl": other }, { "user-bin:hub": "user-bin:hubctl" }) })(input).map((a) => a.id)).toEqual(["install-hubctl"])
    expect(hubctlContributor({ manifest: verified(), installed: inspector({}, {}) })(input).map((a) => a.id)).toEqual(["install-hubctl", "link-hub"])
  })
})

// HBS-12 acceptance (E4, contract amendment A6): a hub-installed harness is put on PATH by a typed link in user-bin
// (~/.local/bin/opencode → data:hub/harnesses/opencode/current/bin/opencode), only when nothing else of that name is on
// PATH and user-bin holds no other file of that name (never shadow or replace a user's binary).
describe("harnessLinkContributor", () => {
  const BIN = "/u/.local/bin"
  const DATA = "/u/.local/share"
  const where = (ref: { root: string; rel: string }) => `${ref.root === "user-bin" ? BIN : ref.root === "data" ? DATA : "/elsewhere"}/${ref.rel}`
  const inspector = (state: { entries?: Record<string, "file" | "directory" | "symlink">; links?: Record<string, string>; path?: Record<string, string> }): PathInspector => ({
    entry: (ref) => state.entries?.[where(ref)] ?? (state.links?.[where(ref)] ? "symlink" : "missing"),
    linkTarget: (ref) => state.links?.[where(ref)],
    where,
    onPath: (name) => state.path?.[name],
  })
  const selectOpencode = { ...(ACTIONS["select-harness-version"] as Extract<Action, { kind: "select-harness-version" }>), harness: "opencode" as const }
  const current = `${DATA}/hub/harnesses/opencode/current`

  test("a harness this plan makes current, with no other opencode anywhere on PATH: linked into user-bin", () => {
    const actions = harnessLinkContributor(inspector({}))({ ...input, planned: [selectOpencode] })
    expect(actions).toEqual([
      {
        id: "link-opencode",
        kind: "link-executable",
        escalation: "user",
        summary: "Put the hub-installed OpenCode on PATH: link ~/.local/bin/opencode to its current version",
        path: { root: "user-bin", rel: "opencode" },
        target: { root: "data", rel: "hub/harnesses/opencode/current/bin/opencode" },
      },
    ])
    for (const a of actions) expect(validateAction(a).ok).toBe(true)
  })

  test("an already current hub install (a rerun) is linked too; an existing right link is converged", () => {
    const state = { entries: { [`${current}/bin/opencode`]: "file" as const } }
    expect(harnessLinkContributor(inspector(state))(input).map((a) => a.id)).toEqual(["link-opencode"])
    const linked = { ...state, links: { [`${BIN}/opencode`]: `${current}/bin/opencode` }, path: { opencode: `${BIN}/opencode` } }
    expect(harnessLinkContributor(inspector(linked))(input)).toEqual([])
  })

  test("a stale hub-owned link (into hub's own harness directory) is replaced", () => {
    const state = { entries: { [`${current}/bin/opencode`]: "file" as const }, links: { [`${BIN}/opencode`]: `${DATA}/hub/harnesses/opencode/2.1.0/bin/opencode` }, path: { opencode: `${BIN}/opencode` } }
    expect(harnessLinkContributor(inspector(state))(input).map((a) => a.id)).toEqual(["link-opencode"])
  })

  test("never shadows or replaces the user's binary", () => {
    const base = { entries: { [`${current}/bin/opencode`]: "file" as const } }
    // Another opencode on PATH (before or after user-bin): left alone.
    expect(harnessLinkContributor(inspector({ ...base, path: { opencode: "/opt/homebrew/bin/opencode" } }))(input)).toEqual([])
    // A user's own file or link in user-bin (on PATH or not): left alone.
    expect(harnessLinkContributor(inspector({ entries: { ...base.entries, [`${BIN}/opencode`]: "file" } }))(input)).toEqual([])
    expect(harnessLinkContributor(inspector({ ...base, links: { [`${BIN}/opencode`]: "/u/.opencode/bin/opencode" } }))(input)).toEqual([])
  })

  test("a harness hub does not manage here is not linked; claude and codex use their own binaries", () => {
    expect(harnessLinkContributor(inspector({}))(input)).toEqual([])
    const all = {
      entries: {
        [`${DATA}/hub/harnesses/opencode/current/bin/opencode`]: "file" as const,
        [`${DATA}/hub/harnesses/claude-code/current/claude`]: "file" as const,
        [`${DATA}/hub/harnesses/codex/current/bin/codex`]: "file" as const,
      },
    }
    const actions = harnessLinkContributor(inspector(all))({ snapshot: DISCOVERY_DARWIN, profile: PROFILE_FULL_HARNESS }) as Extract<Action, { kind: "link-executable" }>[]
    expect(actions.map((a) => [a.id, a.path.rel, a.target.rel])).toEqual([
      ["link-opencode", "opencode", "hub/harnesses/opencode/current/bin/opencode"],
      ["link-claude-code", "claude", "hub/harnesses/claude-code/current/claude"],
      ["link-codex", "codex", "hub/harnesses/codex/current/bin/codex"],
    ])
  })
})

describe("enrollmentContributor", () => {
  test("enrolls with the given hub while the machine is not enrolled with it", () => {
    const actions = enrollmentContributor({ server: "https://hub.example", machineName: "laptop", enrolledWith: undefined })(input)
    expect(actions).toEqual([{ id: "enroll-machine", kind: "enroll-machine", escalation: "user", summary: "Enroll this machine with https://hub.example (device code; you approve it on the hub)", server: "https://hub.example", machineName: "laptop" }])
    expect(validateAction(actions[0]!).ok).toBe(true)
    expect(findSecrets(actions)).toEqual([])
  })

  test("already enrolled with that hub, or no hub given: nothing", () => {
    expect(enrollmentContributor({ server: "https://hub.example", machineName: "laptop", enrolledWith: "https://hub.example" })(input)).toEqual([])
    expect(enrollmentContributor({ machineName: "laptop", enrolledWith: undefined })(input)).toEqual([])
  })
})

describe("refusing", () => {
  test("a Result refusal becomes a typed PlanRefusal with the issue's error code", () => {
    const contributor = refusing(() => ({ ok: false, issues: [{ path: "/node", code: "missing_field", message: "needs workspace roots" }] }))
    let caught: unknown
    try {
      contributor(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlanRefusal)
    expect((caught as PlanRefusal).code).toBe("invalid")
    expect((caught as PlanRefusal).message).toContain("needs workspace roots")
    const noManager = refusing(() => ({ ok: false, issues: [{ path: "/managers/service", code: "no_service_manager", message: "none" }] }))
    expect(() => noManager(input)).toThrow(PlanRefusal)
    try {
      noManager(input)
    } catch (error) {
      expect((error as PlanRefusal).code).toBe("no_service_manager")
    }
  })

  test("a success passes its actions through", () => {
    expect(refusing(() => ({ ok: true, value: [] }))(input)).toEqual([])
  })
})
