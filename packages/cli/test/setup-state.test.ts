// What `hubctl setup` keeps between commands (HBS-13 integration item 7), all secret-free and validated on read:
//   the setup request   `setup preview --out` writes the preview with the inputs apply must re-plan with (the
//                       profile and the choices), so `setup apply --preview <file>` needs nothing else
//   the bootstrap state state:hub/bootstrap/state.json: the applied profile, its choices and catalog revision, the
//                       last committed transaction and plan digest, and the security floors seen (hubctl and each
//                       harness's pinned minimumVersion), which only ever rise
//   requests by digest  state:hub/bootstrap/requests/<plan digest>.json: the request a plan was made from (resume,
//                       drift and verify re-plan from it)
// The journals stay the used-nonce record (the engine reads them).
import { afterEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { planDigest, type RootMapping, type SetupPreview } from "../src/bootstrap/contracts/index.ts"
import { BootstrapStateStore, raiseFloors, validateSetupRequest, type SetupRequest } from "../src/setup/state.ts"
import { MANIFEST_UNSIGNED, PLAN_LAUNCH_NODE, PREVIEW, PROFILE_LAUNCH_NODE } from "./bootstrap/fixtures.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function roots(): { dir: string; roots: RootMapping[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-setup-state-"))
  dirs.push(dir)
  return { dir, roots: [{ id: "home", path: dir }, { id: "state", path: `${dir}/.local/state` }] }
}

const PREVIEW_DOC: SetupPreview = { schema: "hub.setup-preview", version: 1, plan: PLAN_LAUNCH_NODE, planDigest: planDigest(PLAN_LAUNCH_NODE), token: { ...PREVIEW, planDigest: planDigest(PLAN_LAUNCH_NODE) }, blockers: [], evidence: [] }
const REQUEST: SetupRequest = {
  schema: "hub.setup-request",
  version: 1,
  preview: PREVIEW_DOC,
  profile: PROFILE_LAUNCH_NODE,
  choices: { enrollment: "separate", activate: true, node: { workspaceRoots: ["/Users/dev/projects"] } },
}

describe("validateSetupRequest", () => {
  test("accepts a request and migrates nothing it does not know", () => {
    const r = validateSetupRequest(JSON.parse(JSON.stringify(REQUEST)))
    expect(r.ok).toBe(true)
  })

  test("refuses unknown fields, bad choices and anything secret", () => {
    const codes = (v: unknown) => {
      const r = validateSetupRequest(v)
      return r.ok ? [] : r.issues.map((i) => i.code)
    }
    expect(codes({ ...REQUEST, extra: 1 })).toContain("unknown_field")
    expect(codes({ ...REQUEST, choices: { enrollment: "maybe" } })).toContain("invalid_value")
    expect(codes({ ...REQUEST, choices: { activate: "yes" } })).toContain("invalid_value")
    expect(codes({ ...REQUEST, choices: { server: "https://hub.example", token: "mt_abcdefghijklmnop" } })).toContain("unknown_field")
    expect(codes({ ...REQUEST, choices: { machineName: "mt_abcdefghijklmnopqrstuv" } })).toContain("secret")
    expect(codes({ ...REQUEST, schema: "other" })).not.toEqual([])
  })
})

describe("BootstrapStateStore", () => {
  test("round-trips the state and requests by digest, owner-only, atomically", () => {
    const { roots: r } = roots()
    const store = new BootstrapStateStore(r)
    expect(store.read()).toEqual({ schema: "hub.bootstrap-state", version: 1, floors: { harnesses: {} } })
    store.write({ schema: "hub.bootstrap-state", version: 1, profile: PROFILE_LAUNCH_NODE, catalogRevision: 1, txID: "tx_1", planDigest: planDigest(PLAN_LAUNCH_NODE), floors: { hubctl: "0.7.0", harnesses: { opencode: "2.0.0" } } })
    expect(store.read().floors.harnesses.opencode).toBe("2.0.0")
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600)
    store.writeRequest(REQUEST)
    expect(store.readRequest(planDigest(PLAN_LAUNCH_NODE))?.choices.activate).toBe(true)
    expect(store.readRequest(`sha256:${"0".repeat(64)}`)).toBeUndefined()
    expect(readFileSync(store.statePath, "utf8")).not.toContain("mt_")
  })

  test("a corrupt state file is refused, not guessed; a symlinked state directory is refused", () => {
    const { dir, roots: r } = roots()
    const store = new BootstrapStateStore(r)
    mkdirSync(path.dirname(store.statePath), { recursive: true })
    writeFileSync(store.statePath, "{nope")
    expect(() => store.read()).toThrow(/state/)
    rmSync(`${dir}/.local/state/hub`, { recursive: true })
    mkdirSync(`${dir}/elsewhere`)
    symlinkSync(`${dir}/elsewhere`, `${dir}/.local/state/hub`)
    expect(() => new BootstrapStateStore(r).write({ schema: "hub.bootstrap-state", version: 1, floors: { harnesses: {} } })).toThrow()
    expect(lstatSync(`${dir}/elsewhere`).isDirectory()).toBe(true)
  })
})

describe("raiseFloors", () => {
  test("floors only rise: max(seen, the manifest's) for hubctl and each harness pinned for this target", () => {
    const manifest = { ...MANIFEST_UNSIGNED, minimumVersion: "0.7.0", harnesses: MANIFEST_UNSIGNED.harnesses.map((h) => (h.harness === "opencode" ? { ...h, minimumVersion: "2.0.0" } : h)) }
    const raised = raiseFloors({ hubctl: "0.6.0", harnesses: { opencode: "2.1.0" } }, manifest as never, "darwin-arm64")
    expect(raised.hubctl).toBe("0.7.0")
    expect(raised.harnesses.opencode).toBe("2.1.0")
    expect(raiseFloors({ hubctl: "0.9.0", harnesses: {} }, manifest as never, "darwin-arm64").hubctl).toBe("0.9.0")
    expect(raiseFloors({ harnesses: {} }, manifest as never, "darwin-arm64").harnesses.opencode).toBe("2.0.0")
  })
})
