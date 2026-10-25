import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { launchDirectoryProblem, nodeConfigPath, nodeConfigPathNextTo, readWorkspaceRoots } from "../src/spoke/node-roots"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function tmp(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-node-roots-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("nodeConfigPath", () => {
  test("is node.json next to the spoke config: ~/.config/hub, $XDG_CONFIG_HOME/hub, or $HUB_SPOKE_CONFIG's directory", () => {
    expect(nodeConfigPath({}, "/home/u")).toBe("/home/u/.config/hub/node.json")
    expect(nodeConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/hub/node.json")
    expect(nodeConfigPath({ HUB_SPOKE_CONFIG: "/etc/hub-test/config.json" }, "/home/u")).toBe("/etc/hub-test/node.json")
  })
})

describe("nodeConfigPathNextTo", () => {
  test("is node.json in the directory of a given config file (a launch-bound spoke's launch config)", () => {
    expect(nodeConfigPathNextTo("/sandbox/.hub/config.json")).toBe("/sandbox/.hub/node.json")
  })
})

describe("readWorkspaceRoots", () => {
  test("reads workspaceRoots from node.json, keeping absolute paths only", () => {
    const dir = tmp()
    const file = path.join(dir, "node.json")
    writeFileSync(file, JSON.stringify({ workspaceRoots: ["/a/projects", "relative", 7, "", "/b"], labels: { os: "darwin" }, slots: 4, memoryMB: 1024 }))
    expect(readWorkspaceRoots(file)).toEqual(["/a/projects", "/b"])
  })

  test("no file, bad JSON or no workspaceRoots means no roots", () => {
    const dir = tmp()
    expect(readWorkspaceRoots(path.join(dir, "missing.json"))).toEqual([])
    writeFileSync(path.join(dir, "bad.json"), "{nope")
    expect(readWorkspaceRoots(path.join(dir, "bad.json"))).toEqual([])
    writeFileSync(path.join(dir, "none.json"), JSON.stringify({ labels: {} }))
    expect(readWorkspaceRoots(path.join(dir, "none.json"))).toEqual([])
    writeFileSync(path.join(dir, "wrong.json"), JSON.stringify({ workspaceRoots: "/a" }))
    expect(readWorkspaceRoots(path.join(dir, "wrong.json"))).toEqual([])
  })
})

describe("launchDirectoryProblem", () => {
  test("accepts an existing directory under (or at) a root", () => {
    const root = tmp()
    mkdirSync(path.join(root, "repo", ".worktrees", "feat"), { recursive: true })
    expect(launchDirectoryProblem(path.join(root, "repo", ".worktrees", "feat"), [root])).toBeUndefined()
    expect(launchDirectoryProblem(path.join(root, "repo"), ["/nowhere", root])).toBeUndefined()
    expect(launchDirectoryProblem(root, [root])).toBeUndefined()
  })

  test("refuses without roots, outside roots, a sibling with the root as prefix, or a missing directory", () => {
    const base = tmp()
    const root = path.join(base, "projects")
    mkdirSync(path.join(root, "repo"), { recursive: true })
    mkdirSync(path.join(base, "projects-evil"))
    mkdirSync(path.join(base, "other"))
    expect(launchDirectoryProblem(path.join(root, "repo"), [])).toMatch(/workspace roots/i)
    expect(launchDirectoryProblem(path.join(base, "other"), [root])).toMatch(/not under/i)
    expect(launchDirectoryProblem(path.join(base, "projects-evil"), [root])).toMatch(/not under/i)
    expect(launchDirectoryProblem(path.join(root, "missing"), [root])).toMatch(/does not exist/i)
  })

  test("refuses a file, and resolves symlinks before checking", () => {
    const base = tmp()
    const root = path.join(base, "projects")
    mkdirSync(root)
    mkdirSync(path.join(base, "outside"))
    writeFileSync(path.join(root, "file"), "x")
    symlinkSync(path.join(base, "outside"), path.join(root, "escape"))
    expect(launchDirectoryProblem(path.join(root, "file"), [root])).toMatch(/not a directory/i)
    expect(launchDirectoryProblem(path.join(root, "escape"), [root])).toMatch(/not under/i)
    // A root given through a symlink still contains its real children.
    symlinkSync(root, path.join(base, "link"))
    mkdirSync(path.join(root, "repo"))
    expect(launchDirectoryProblem(path.join(root, "repo"), [path.join(base, "link")])).toBeUndefined()
  })
})
