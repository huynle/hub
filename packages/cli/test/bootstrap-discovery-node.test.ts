// HBS-03: the real probe (node:fs, read-only) on a real directory tree. A recording fake replaces every node:fs
// write, child_process spawn and fetch while discover, preview and revalidation run: none may be called, and the
// tree is byte-for-byte and mtime-for-mtime unchanged afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import childProcess from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateDiscoverySnapshot, type Action } from "../src/bootstrap/contracts/index.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { createNodeProbe } from "../src/bootstrap/discovery/node-probe.ts"
import { previewSetup, revalidateApply, type PlanContributor } from "../src/bootstrap/preview/index.ts"
import { ACTIONS, MINUTE, PROFILE_SESSION_ONLY, T0 } from "./bootstrap/fixtures.ts"

let root = ""
let home = ""
const CONFIG = "{\n  \"plugin\": []\n}\n"

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string) => {
    const st = fs.lstatSync(p)
    const rel = path.relative(root, p) || "."
    if (st.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(p)} ${st.mtimeMs}`
    else if (st.isDirectory()) {
      out[rel] = `dir ${st.mode} ${st.mtimeMs}`
      for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name))
    } else out[rel] = `file ${st.mode} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`
  }
  walk(dir)
  return out
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hbs03-")))
  home = path.join(root, "home")
  const bin = path.join(root, "bin")
  fs.mkdirSync(path.join(home, "dot/opencode"), { recursive: true })
  fs.mkdirSync(path.join(home, ".config"), { recursive: true })
  fs.writeFileSync(path.join(home, "dot/opencode/opencode.json"), CONFIG)
  fs.symlinkSync(path.join(home, "dot/opencode"), path.join(home, ".config/opencode"))
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\nexec docker exec -i box /usr/local/bin/opencode \"$@\"\n", { mode: 0o755 })
  const pkg = path.join(root, "lib/node_modules/@openai/codex")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.165.0" }))
  fs.writeFileSync(path.join(pkg, "bin/codex.js"), "#!/usr/bin/env node\n", { mode: 0o755 })
  fs.symlinkSync(path.join(pkg, "bin/codex.js"), path.join(bin, "codex"))
  fs.writeFileSync(path.join(bin, "claude"), "not executable")
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

const opencodePlugin: PlanContributor = ({ snapshot }) => {
  const config = snapshot.configs.find((c) => c.owner === "harness:opencode")
  return [{ ...(ACTIONS["merge-config"] as Action), precondition: config?.sha256 ? { exists: true, sha256: config.sha256 } : { exists: false } } as Action]
}

/** Replaces every writing or spawning function with a recorder that throws; returns the record and a restore. */
function recordWrites() {
  const writes: string[] = []
  const restores: (() => void)[] = []
  const trap = (target: Record<string, unknown>, name: string, allow?: (...args: unknown[]) => boolean) => {
    const original = target[name]
    if (typeof original !== "function") return
    target[name] = (...args: unknown[]) => {
      if (allow?.(...args)) return (original as (...a: unknown[]) => unknown).apply(target, args)
      writes.push(`${name} ${String(args[0])}`)
      throw new Error(`write attempted: ${name}`)
    }
    restores.push(() => (target[name] = original))
  }
  const readOnly = (_p: unknown, flags?: unknown) => flags === undefined || flags === "r" || flags === fs.constants.O_RDONLY
  const f = fs as unknown as Record<string, unknown>
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "symlinkSync", "linkSync", "copyFileSync", "cpSync", "chmodSync", "chownSync", "lchownSync", "utimesSync", "lutimesSync", "truncateSync", "writeSync", "writeFile", "appendFile", "mkdir", "rm", "unlink", "rename", "symlink", "createWriteStream"])
    trap(f, name)
  trap(f, "openSync", readOnly)
  trap(f, "open", readOnly)
  const cp = childProcess as unknown as Record<string, unknown>
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(cp, name)
  const fetchBefore = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    writes.push(`fetch ${String(input)}`)
    throw new Error("network attempted")
  }) as unknown as typeof fetch
  restores.push(() => (globalThis.fetch = fetchBefore))
  return { writes, restore: () => restores.splice(0).forEach((r) => r()) }
}

describe("createNodeProbe", () => {
  test("discover, preview and revalidation on a real tree: correct findings, zero writes, zero spawns, zero network", () => {
    const before = tree(root)
    const probe = createNodeProbe({ env: { HOME: home, PATH: path.join(root, "bin") }, home, machineID: "test-machine-0001" })
    const rec = recordWrites()
    let snapshot, preview, again
    try {
      snapshot = discover(probe, { now: T0 })
      preview = previewSetup({ probe, profile: PROFILE_SESSION_ONLY, now: T0, nonce: "nonce-0123456789abcdef", contributors: [opencodePlugin] })
      again = preview.ok ? revalidateApply({ token: preview.value.token, probe, profile: PROFILE_SESSION_ONLY, now: T0 + MINUTE, usedNonces: new Set(), contributors: [opencodePlugin] }) : undefined
    } finally {
      rec.restore()
    }
    expect(rec.writes).toEqual([])
    expect(tree(root)).toEqual(before)

    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    const s = snapshot.value
    expect(validateDiscoverySnapshot(s).ok).toBe(true)
    expect(s.host).toMatchObject({ platform: process.platform, arch: process.arch })
    expect(s.topology.shims).toEqual([
      { name: "opencode", path: path.join(root, "bin/opencode"), kind: "container-shim", resolvesTo: "/usr/local/bin/opencode" },
      { name: "codex", path: path.join(root, "bin/codex"), kind: "wrapper", resolvesTo: path.join(root, "lib/node_modules/@openai/codex/bin/codex.js") },
    ])
    expect(s.harnesses.map((h) => [h.id, h.installed, h.installMethod, h.version, h.health.state])).toEqual([
      ["opencode", true, "unknown", undefined, "unverified"],
      // A file that is not executable is not a harness.
      ["claude-code", false, undefined, undefined, "unverified"],
      ["codex", true, "npm", "0.165.0", "unverified"],
    ])
    expect(s.configs).toEqual([
      { path: path.join(home, ".config/opencode/opencode.json"), owner: "harness:opencode", format: "json", sha256: `sha256:${createHash("sha256").update(CONFIG).digest("hex")}` },
    ])
    expect(s.roots[0]).toEqual({ id: "home", path: home })

    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.blockers.map((b) => [b.linkPath, b.resolvedPath])).toEqual([[path.join(home, ".config/opencode"), path.join(home, "dot/opencode/opencode.json")]])
    expect(again && !again.ok && again.issues.map((i) => i.code)).toEqual(["manual_edit_required"])
  })

  test("the same tree discovered twice gives the same snapshot", () => {
    const probe = () => createNodeProbe({ env: { HOME: home, PATH: path.join(root, "bin") }, home, machineID: "test-machine-0001" })
    expect(discover(probe(), { now: T0 })).toEqual(discover(probe(), { now: T0 }))
  })

  test("the probe reports kinds, bounded reads, links and executability", () => {
    const p = createNodeProbe({ env: {}, home, machineID: "m" })
    expect(p.lstat(path.join(home, ".config/opencode"))).toBe("symlink")
    expect(p.stat(path.join(home, ".config/opencode"))).toBe("directory")
    expect(p.lstat(path.join(home, "nope"))).toBe("missing")
    expect(p.stat(path.join(home, ".config/opencode/opencode.json"))).toBe("file")
    expect(new TextDecoder().decode(p.readFile(path.join(home, ".config/opencode/opencode.json"), 3))).toBe("{\n ")
    expect(new TextDecoder().decode(p.readFile(path.join(home, ".config/opencode/opencode.json")))).toBe(CONFIG)
    expect(p.readFile(path.join(home, "nope"))).toBeUndefined()
    expect(p.readdir(path.join(root, "bin"))).toEqual(["claude", "codex", "opencode"])
    expect(p.readlink(path.join(home, ".config/opencode"))).toBe(path.join(home, "dot/opencode"))
    expect(p.realpath(path.join(home, ".config/opencode/opencode.json"))).toBe(path.join(home, "dot/opencode/opencode.json"))
    expect(p.realpath(path.join(home, "nope"))).toBeUndefined()
    expect(p.executable(path.join(root, "bin/opencode"))).toBe(true)
    expect(p.executable(path.join(root, "bin/claude"))).toBe(false)
    expect(p.executable(path.join(root, "bin"))).toBe(false)
    expect(p.machineID()).toBe("m")
    expect(p.uid).toBe(process.getuid?.() ?? 0)
    expect(p.home).toBe(home)
  })
})
