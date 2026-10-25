// Which configuration the plugin's spoke runs from: the machine config, or (inside a launch's sandbox) the read-only
// launch config with node.json next to it. A broken launch config never falls back to the machine config.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { launchSource } from "../src/spoke/launch-source"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function launchFile(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-launch-source-"))
  dirs.push(dir)
  const file = path.join(dir, "config.json")
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}

describe("launchSource", () => {
  test("no launch config: the machine config", () => {
    expect(launchSource({}, () => false)).toEqual({ kind: "machine" })
  })

  test("a valid launch config: launch-bound, with node.json from the same directory", () => {
    const file = launchFile({ hubURL: "http://host.openshell.internal:4097", token: "hlt1.t", launchID: "lch_9" })
    expect(launchSource({ HUB_LAUNCH_CONFIG: file }, () => false)).toEqual({
      kind: "launch",
      file,
      launch: { hubURL: "http://host.openshell.internal:4097", token: "hlt1.t", launchID: "lch_9" },
      nodeConfig: path.join(path.dirname(file), "node.json"),
    })
  })

  test("an unreadable or invalid launch config: invalid (no spoke), never the machine config", () => {
    const bad = launchFile({ hubURL: "x", token: "secret-value", launchID: "l" })
    const result = launchSource({ HUB_LAUNCH_CONFIG: bad }, () => false)
    expect(result.kind).toBe("invalid")
    expect(result.kind === "invalid" && result.error).toMatch(/launch config/)
    expect(JSON.stringify(result)).not.toContain("secret-value")
    expect(launchSource({ HUB_LAUNCH_CONFIG: "/nonexistent/hub/config.json" }, () => false).kind).toBe("invalid")
  })
})
