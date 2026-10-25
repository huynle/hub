// Service templates for `hub node`: a launchd agent (macOS) and a systemd user unit (Linux). Both run the node's
// entry from the repository with bun, restart it after a failure but not after exit 78 (node.json gives it
// nothing to do) or a clean stop, and ship in the npm package.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const main = JSON.parse(read("package.json"))

describe("hub node service templates", () => {
  test("the launchd agent runs packages/node/src/main.ts and restarts only after a failure", () => {
    const plist = read("scripts/io.github.huynle.hub-node.plist")
    expect(plist).toContain("<string>io.github.huynle.hub-node</string>")
    expect(plist).toContain("<string>__REPO__/packages/node/src/main.ts</string>")
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain("node.json")
  })

  test("the systemd unit runs packages/node/src/main.ts and does not restart on exit 78", () => {
    const unit = read("scripts/hub-node.service")
    expect(unit).toContain("ExecStart=__HOME__/.bun/bin/bun __REPO__/packages/node/src/main.ts")
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("RestartPreventExitStatus=78")
    expect(unit).toContain("node.json")
  })

  test("both ship in the npm package", () => {
    expect(main.files).toContain("scripts/io.github.huynle.hub-node.plist")
    expect(main.files).toContain("scripts/hub-node.service")
  })

  test("the exit code the units treat as a configuration error is runNode's", async () => {
    const { EXIT_CONFIG } = await import("../packages/node/src/run.ts")
    expect(EXIT_CONFIG).toBe(78)
  })
})
