// Service templates for `hub node`: a launchd agent (macOS) and a systemd user unit (Linux). `hub node install`
// fills them in (packages/cli/src/node.ts): both run `<runtime> <hub CLI entry> node run` (BUN_BE_BUN=1 so an
// OpenCode binary acts as bun), restart it after a failure but not after exit 78 (node.json gives it nothing to
// do) or a clean stop, and ship in the npm package.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const main = JSON.parse(read("package.json"))

describe("hub node service templates", () => {
  test("the launchd agent runs `hub node run` and restarts only after a failure", () => {
    const plist = read("scripts/io.github.huynle.hub-node.plist")
    expect(plist).toContain("<string>io.github.huynle.hub-node</string>")
    expect(plist).toMatch(/<string>__RUNTIME__<\/string>\s*<string>__ENTRY__<\/string>\s*<string>node<\/string>\s*<string>run<\/string>/)
    expect(plist).toMatch(/<key>BUN_BE_BUN<\/key>\s*<string>1<\/string>/)
    // XML comments cannot hold a double hyphen.
    for (const comment of plist.match(/<!--([\s\S]*?)-->/g) ?? []) expect(comment.slice(4, -3)).not.toContain("--")
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain("node.json")
  })

  test("the systemd unit runs `hub node run` and does not restart on exit 78", () => {
    const unit = read("scripts/hub-node.service")
    expect(unit).toContain("ExecStart=__RUNTIME__ __ENTRY__ node run")
    expect(unit).toContain("Environment=BUN_BE_BUN=1")
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
