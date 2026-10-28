// Discovery amendments found by the integration (HBS-13 item 8):
//   - a harness hub installed (data:hub/harnesses/<harness>/current/<binary>) is found even when it is not on PATH,
//     as installMethod "hub" at the version `current` points to, so a second preview after an install is a no-op;
//   - hub's own config:hub/claude-code.json is a config candidate (its digest pins the Claude Code adapter's merge);
//   - Codex's upstream evidence includes macOS notarization (its macOS binaries are codesigned).
import { describe, expect, test } from "bun:test"
import { HARNESS_EVIDENCE } from "../src/bootstrap/contracts/index.ts"
import { configCandidates, discover } from "../src/bootstrap/discovery/index.ts"
import { exe, link, file, MACHO, MAC_NO_HARNESS, memoryProbe } from "./bootstrap/discovery-fixtures.ts"

const DATA = "/Users/dev/.local/share/hub/harnesses"

describe("hub-installed harnesses off PATH", () => {
  test("each harness's current binary is found, as installed by hub at the current version", () => {
    const probe = memoryProbe({
      ...MAC_NO_HARNESS,
      files: {
        ...MAC_NO_HARNESS.files,
        [`${DATA}/opencode/2.2.0/bin/opencode`]: exe(MACHO),
        [`${DATA}/opencode/current`]: link("2.2.0"),
        [`${DATA}/claude-code/2.1.90/claude`]: exe(MACHO),
        [`${DATA}/claude-code/current`]: link("2.1.90"),
        [`${DATA}/codex/0.165.0/bin/codex`]: exe(MACHO),
        [`${DATA}/codex/current`]: link("0.165.0"),
      },
    })
    const snap = discover(probe, { now: 1 })
    if (!snap.ok) throw new Error(JSON.stringify(snap.issues))
    expect(snap.value.harnesses.map((h) => [h.id, h.installed, h.installMethod, h.version])).toEqual([
      ["opencode", true, "hub", "2.2.0"],
      ["claude-code", true, "hub", "2.1.90"],
      ["codex", true, "hub", "0.165.0"],
    ])
    expect(snap.value.harnesses.find((h) => h.id === "codex")?.path).toBe(`${DATA}/codex/current/bin/codex`)
  })

  test("PATH still wins over hub's directory", () => {
    const probe = memoryProbe({
      ...MAC_NO_HARNESS,
      env: { ...MAC_NO_HARNESS.env, PATH: "/opt/bin:/usr/bin:/bin" },
      files: { ...MAC_NO_HARNESS.files, "/opt/bin/codex": exe(MACHO), [`${DATA}/codex/0.165.0/bin/codex`]: exe(MACHO), [`${DATA}/codex/current`]: link("0.165.0") },
    })
    const snap = discover(probe, { now: 1 })
    expect(snap.ok && snap.value.harnesses.find((h) => h.id === "codex")?.path).toBe("/opt/bin/codex")
  })
})

describe("config candidates", () => {
  test("hub's claude-code.json is one, owned by hub", () => {
    const roots = [
      { id: "home" as const, path: "/Users/dev" },
      { id: "config" as const, path: "/Users/dev/.config" },
    ]
    expect(configCandidates("darwin", roots)).toContainEqual({ path: "/Users/dev/.config/hub/claude-code.json", owner: "hub", format: "json" })
    const probe = memoryProbe({ ...MAC_NO_HARNESS, files: { ...MAC_NO_HARNESS.files, "/Users/dev/.config/hub/claude-code.json": file('{"binary":"/x"}') } })
    const snap = discover(probe, { now: 1 })
    expect(snap.ok && snap.value.configs.map((c) => c.path)).toContain("/Users/dev/.config/hub/claude-code.json")
  })
})

describe("harness evidence", () => {
  test("Codex can offer sigstore and macOS notarization", () => {
    expect(HARNESS_EVIDENCE.codex).toEqual(["sigstore", "macos-notarization"])
  })
})
