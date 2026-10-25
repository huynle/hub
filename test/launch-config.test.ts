// The read-only launch config of a launch-bound spoke (inside an OpenShell sandbox): {hubURL, token, launchID},
// written by the node, found through $HUB_LAUNCH_CONFIG or at /sandbox/.hub/config.json.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { LAUNCH_CONFIG_DEFAULT, launchConfigPath, parseLaunchConfig, readLaunchConfig } from "../src/config"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const good = { hubURL: "http://host.openshell.internal:4097/", token: "hlt1.abc.def", launchID: "lch_01HX" }

describe("parseLaunchConfig", () => {
  test("accepts hubURL, token and launchID, trimming trailing slashes from the URL", () => {
    expect(parseLaunchConfig(good)).toEqual({ hubURL: "http://host.openshell.internal:4097", token: "hlt1.abc.def", launchID: "lch_01HX" })
  })

  test("rejects anything that is not a complete, valid config", () => {
    expect(parseLaunchConfig(null)).toBeUndefined()
    expect(parseLaunchConfig("x")).toBeUndefined()
    expect(parseLaunchConfig([])).toBeUndefined()
    expect(parseLaunchConfig({ ...good, hubURL: "ftp://x" })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, hubURL: "not a url" })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, token: "" })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, token: "has space" })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, token: 5 })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, launchID: "" })).toBeUndefined()
    expect(parseLaunchConfig({ ...good, launchID: "bad id" })).toBeUndefined()
    const { launchID: _l, ...noLaunch } = good
    expect(parseLaunchConfig(noLaunch)).toBeUndefined()
  })
})

describe("launchConfigPath", () => {
  test("$HUB_LAUNCH_CONFIG wins", () => {
    expect(launchConfigPath({ HUB_LAUNCH_CONFIG: "/x/config.json" }, () => true)).toBe("/x/config.json")
  })

  test("else the sandbox default when it exists", () => {
    expect(LAUNCH_CONFIG_DEFAULT).toBe("/sandbox/.hub/config.json")
    const seen: string[] = []
    expect(launchConfigPath({}, (p) => (seen.push(p), true))).toBe(LAUNCH_CONFIG_DEFAULT)
    expect(seen).toEqual([LAUNCH_CONFIG_DEFAULT])
  })

  test("else none: not launch-bound", () => {
    expect(launchConfigPath({}, () => false)).toBeUndefined()
    expect(launchConfigPath({ HUB_LAUNCH_CONFIG: "" }, () => false)).toBeUndefined()
  })
})

describe("readLaunchConfig", () => {
  const write = (content: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-launch-"))
    dirs.push(dir)
    const file = path.join(dir, "config.json")
    writeFileSync(file, content)
    return file
  }

  test("reads a valid file", () => {
    expect(readLaunchConfig(write(JSON.stringify(good)))).toEqual(parseLaunchConfig(good)!)
  })

  test("throws for a missing, unparsable or invalid file, never echoing the token", () => {
    expect(() => readLaunchConfig("/nonexistent/hub/config.json")).toThrow(/launch config/)
    expect(() => readLaunchConfig(write("{"))).toThrow(/launch config/)
    let message = ""
    try {
      readLaunchConfig(write(JSON.stringify({ ...good, hubURL: "nope", token: "secret-token-value" })))
    } catch (cause) {
      message = (cause as Error).message
    }
    expect(message).toMatch(/launch config/)
    expect(message).not.toContain("secret-token-value")
  })
})
