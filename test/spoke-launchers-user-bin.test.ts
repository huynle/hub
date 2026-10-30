// `hub` on the user's own PATH for a plugin-only install: next to the launchers in the hub bin dir, the plugin links
// ~/.local/bin/hub to its `hub` launcher, with the setup's user-bin link rules (contract §7.6 A6, shared in
// packages/cli/src/setup/user-bin.ts): only when nothing is there or what is there is hub's own, and never when
// another `hub` is on PATH (a user's binary is never shadowed or replaced). ~/.local/bin/hubctl is left to
// `hubctl setup` (its install-artifact path; a link there would block that install and make the launchers exec
// themselves). When ~/.local/bin is not on PATH, one hint says so.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userBinLinkDecision } from "../packages/cli/src/setup/user-bin"
import { installLaunchers, linkUserBin } from "../src/spoke/launchers"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "hub-user-bin-"))
  dirs.push(d)
  return d
}

/** A home with the plugin's launchers in ~/.local/state/hub/bin. */
function setup() {
  const home = tmp()
  const binDir = path.join(home, ".local", "state", "hub", "bin")
  installLaunchers({ binDir, execPath: "/bin/opencode", bun: true, entry: "/pkg/hub-cli.js" })
  const userBin = path.join(home, ".local", "bin")
  return { home, binDir, userBin, link: path.join(userBin, "hub") }
}

describe("userBinLinkDecision (the setup's user-bin link rule)", () => {
  const base = { linkPath: "/h/.local/bin/x", target: "/t/x", hubOwned: (p: string) => p.startsWith("/t/") || p.startsWith("/old/") }
  test("the cases", () => {
    expect(userBinLinkDecision({ ...base, entry: "missing" })).toBe("create")
    expect(userBinLinkDecision({ ...base, entry: "symlink", pointsTo: "/t/x" })).toBe("in-place")
    expect(userBinLinkDecision({ ...base, entry: "symlink", pointsTo: "/old/x" })).toBe("replace")
    expect(userBinLinkDecision({ ...base, entry: "symlink", pointsTo: "/usr/local/bin/x" })).toBe("foreign")
    expect(userBinLinkDecision({ ...base, entry: "file" })).toBe("foreign")
    expect(userBinLinkDecision({ ...base, entry: "directory" })).toBe("foreign")
    expect(userBinLinkDecision({ ...base, entry: "missing", foundOnPath: "/opt/bin/x" })).toBe("shadowed")
    expect(userBinLinkDecision({ ...base, entry: "symlink", pointsTo: "/old/x", foundOnPath: "/h/.local/bin/x" })).toBe("replace")
  })
})

describe("linkUserBin (plugin-only installs)", () => {
  test("links ~/.local/bin/hub to the launcher (creating ~/.local/bin); never hubctl", () => {
    const { home, binDir, userBin, link } = setup()
    const result = linkUserBin({ home, binDir, path: userBin })
    expect(result.linked).toEqual(["hub"])
    expect(readlinkSync(link)).toBe(path.join(binDir, "hub"))
    expect(existsSync(path.join(userBin, "hubctl"))).toBe(false)
    expect(result.hint).toBeUndefined()
  })

  test("a second start changes nothing", () => {
    const { home, binDir, userBin, link } = setup()
    linkUserBin({ home, binDir, path: userBin })
    const before = lstatSync(link)
    expect(linkUserBin({ home, binDir, path: userBin }).linked).toEqual([])
    expect(lstatSync(link).ino).toBe(before.ino)
  })

  test("one hint when ~/.local/bin is not on PATH", () => {
    const { home, binDir } = setup()
    const result = linkUserBin({ home, binDir, path: "/usr/bin:/bin" })
    expect(result.linked).toEqual(["hub"])
    expect(result.hint).toContain(".local/bin")
    expect(result.hint).toContain("PATH")
  })

  test("a user's own hub (a file, or a link elsewhere) is never replaced", () => {
    const { home, binDir, userBin, link } = setup()
    mkdirSync(userBin, { recursive: true })
    writeFileSync(link, "#!/bin/sh\necho mine\n", { mode: 0o755 })
    expect(linkUserBin({ home, binDir, path: userBin }).linked).toEqual([])
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    rmSync(link)
    symlinkSync("/usr/local/bin/gh-hub", link)
    expect(linkUserBin({ home, binDir, path: userBin }).linked).toEqual([])
    expect(readlinkSync(link)).toBe("/usr/local/bin/gh-hub")
  })

  test("the setup's link (hub → hubctl) is kept", () => {
    const { home, binDir, userBin, link } = setup()
    mkdirSync(userBin, { recursive: true })
    writeFileSync(path.join(userBin, "hubctl"), "#!/bin/sh\n", { mode: 0o755 })
    symlinkSync(path.join(userBin, "hubctl"), link)
    expect(linkUserBin({ home, binDir, path: userBin }).linked).toEqual([])
    expect(readlinkSync(link)).toBe(path.join(userBin, "hubctl"))
  })

  test("a link to an older hub launcher (another state dir) is hub's own: it is moved to this one", () => {
    const { home, binDir, userBin, link } = setup()
    const old = path.join(tmp(), "state", "bin")
    installLaunchers({ binDir: old, execPath: "/bin/opencode", bun: true, entry: "/pkg/hub-cli.js" })
    mkdirSync(userBin, { recursive: true })
    symlinkSync(path.join(old, "hub"), link)
    expect(linkUserBin({ home, binDir, path: userBin }).linked).toEqual(["hub"])
    expect(readlinkSync(link)).toBe(path.join(binDir, "hub"))
  })

  test("another hub on PATH (e.g. GitHub's hub) is never shadowed", () => {
    const { home, binDir, userBin, link } = setup()
    const other = tmp()
    writeFileSync(path.join(other, "hub"), "#!/bin/sh\n", { mode: 0o755 })
    const result = linkUserBin({ home, binDir, path: `${other}:${userBin}` })
    expect(result.linked).toEqual([])
    expect(existsSync(link)).toBe(false)
    expect(result.hint).toContain(path.join(other, "hub"))
    expect(result.hint).toContain(path.join(binDir, "hub"))
  })

  test("the plugin's own bin dir on PATH does not count as another hub", () => {
    const { home, binDir, userBin, link } = setup()
    expect(linkUserBin({ home, binDir, path: `${binDir}:${userBin}` }).linked).toEqual(["hub"])
    expect(readlinkSync(link)).toBe(path.join(binDir, "hub"))
  })
})
