// HBS-03: read-only discovery over an injected probe. Each fixture host (bootstrap/discovery-fixtures.ts) is a
// platform/topology case of the matrix: macOS native, Linux native, a container shim on the host, inside a
// container, musl (unsupported), no harness, and a symlinked config.
import { describe, expect, test } from "bun:test"
import { canonicalJSON, hostFingerprint, isHarnessReady, validateDiscoverySnapshot, type DiscoverySnapshot } from "../src/bootstrap/contracts/index.ts"
import { discover } from "../src/bootstrap/discovery/discover.ts"
import { T0 } from "./bootstrap/fixtures.ts"
import {
  LINUX_CONTAINER_SHIM,
  LINUX_HOME,
  LINUX_IN_CONTAINER,
  LINUX_MUSL,
  LINUX_NATIVE,
  MAC_HOME,
  MAC_NATIVE,
  MAC_NO_HARNESS,
  MAC_SYMLINKED_CONFIG,
  memoryProbe,
  OPENCODE_CONFIG,
  sha256,
  type HostSpec,
} from "./bootstrap/discovery-fixtures.ts"

function snap(spec: HostSpec, now = T0): DiscoverySnapshot {
  const result = discover(memoryProbe(spec), { now })
  if (!result.ok) throw new Error(`discover failed: ${JSON.stringify(result.issues)}`)
  return result.value
}

const harness = (s: DiscoverySnapshot, id: string) => s.harnesses.find((h) => h.id === id)
const root = (s: DiscoverySnapshot, id: string) => s.roots.find((r) => r.id === id)

describe("discovery matrix", () => {
  test("every fixture host yields a valid contract snapshot", () => {
    for (const spec of [MAC_NATIVE, LINUX_NATIVE, LINUX_CONTAINER_SHIM, LINUX_IN_CONTAINER, LINUX_MUSL, MAC_NO_HARNESS, MAC_SYMLINKED_CONFIG]) {
      const s = snap(spec)
      expect(validateDiscoverySnapshot(s)).toEqual({ ok: true, value: s })
      expect(s.capturedAt).toBe(T0)
    }
  })

  test("macOS native: host, launchd, Homebrew, a native OpenCode and the roots", async () => {
    const s = snap(MAC_NATIVE)
    expect(s.host).toEqual({
      fingerprint: hostFingerprint({ machineID: "MAC-UUID-0001", platform: "darwin", arch: "arm64", uid: 501, home: MAC_HOME }),
      platform: "darwin",
      arch: "arm64",
      libc: "none",
      target: "darwin-arm64",
      supported: true,
      os: { name: "macOS", version: "15.4" },
    })
    expect(s.topology).toEqual({ container: "none", shims: [{ name: "opencode", path: `${MAC_HOME}/.opencode/bin/opencode`, kind: "host" }] })
    expect(s.managers).toEqual({ package: ["brew", "npm"], runtime: [{ id: "bun", version: "1.3.5", path: `${MAC_HOME}/.bun/bin/bun` }], service: "launchd" })
    expect(harness(s, "opencode")).toEqual({ id: "opencode", installed: true, path: `${MAC_HOME}/.opencode/bin/opencode`, installMethod: "native", health: { state: "unverified", probes: [] } })
    expect(harness(s, "claude-code")).toEqual({ id: "claude-code", installed: false, health: { state: "unverified", probes: [] } })
    expect(s.roots).toEqual([
      { id: "home", path: MAC_HOME },
      { id: "config", path: `${MAC_HOME}/.config` },
      { id: "state", path: `${MAC_HOME}/.local/state` },
      { id: "data", path: `${MAC_HOME}/.local/share` },
      { id: "user-bin", path: `${MAC_HOME}/.local/bin` },
      { id: "launch-agents", path: `${MAC_HOME}/Library/LaunchAgents` },
      { id: "system-bin", path: "/usr/local/bin" },
    ])
    expect(s.configs).toEqual([
      { path: `${MAC_HOME}/.config/hub/config.json`, owner: "hub", format: "json", sha256: await sha256("{\"server\":\"https://hub.example\"}") },
      { path: `${MAC_HOME}/.config/opencode/opencode.json`, owner: "harness:opencode", format: "json", sha256: await sha256(OPENCODE_CONFIG) },
    ])
    expect(s.runtimes).toEqual([{ id: "openshell", present: false }])
  })

  test("Linux native: glibc, systemd --user, Claude Code via its versions link, Codex from npm, owned configs", () => {
    const s = snap(LINUX_NATIVE)
    expect(s.host).toMatchObject({ platform: "linux", arch: "x64", libc: "glibc", target: "linux-x64", supported: true, os: { name: "Ubuntu", version: "24.04" } })
    expect(s.managers.service).toBe("systemd-user")
    expect(s.managers.package).toEqual(["npm", "apt"])
    expect(s.managers.runtime).toEqual([{ id: "node", version: "22.11.0", path: "/usr/bin/node" }])
    expect(harness(s, "claude-code")).toEqual({
      id: "claude-code",
      installed: true,
      path: `${LINUX_HOME}/.local/bin/claude`,
      version: "2.1.90",
      installMethod: "native",
      health: { state: "unverified", probes: [] },
    })
    expect(harness(s, "codex")).toMatchObject({ installed: true, path: "/usr/local/bin/codex", version: "0.165.0", installMethod: "npm" })
    expect(harness(s, "opencode")?.installed).toBe(false)
    expect(s.topology.shims).toEqual([
      { name: "claude", path: `${LINUX_HOME}/.local/bin/claude`, kind: "host", resolvesTo: `${LINUX_HOME}/.local/share/claude/versions/2.1.90` },
      { name: "codex", path: "/usr/local/bin/codex", kind: "wrapper", resolvesTo: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" },
    ])
    // XDG_CONFIG_HOME's trailing slash is normalized; systemd units live under it.
    expect(root(s, "config")).toEqual({ id: "config", path: `${LINUX_HOME}/.config` })
    expect(root(s, "systemd-user")).toEqual({ id: "systemd-user", path: `${LINUX_HOME}/.config/systemd/user` })
    expect(root(s, "launch-agents")).toBeUndefined()
    expect(s.configs.map((c) => [c.path, c.owner, c.format])).toEqual([
      [`${LINUX_HOME}/.claude.json`, "harness:claude-code", "json"],
      [`${LINUX_HOME}/.codex/config.toml`, "harness:codex", "toml"],
      [`${LINUX_HOME}/.config/systemd/user/hub-node.service`, "hub", "unit"],
    ])
  })

  test("a docker-exec shim on the host is a container shim: present, never ready", () => {
    const s = snap(LINUX_CONTAINER_SHIM)
    expect(s.topology).toEqual({
      container: "none",
      shims: [{ name: "opencode", path: `${LINUX_HOME}/.local/bin/opencode`, kind: "container-shim", resolvesTo: "/usr/local/bin/opencode" }],
    })
    const oc = harness(s, "opencode")!
    expect(oc).toEqual({ id: "opencode", installed: true, path: `${LINUX_HOME}/.local/bin/opencode`, installMethod: "unknown", health: { state: "unverified", probes: [] } })
    // Presence is not readiness.
    expect(isHarnessReady({ harness: "opencode", probes: oc.health.probes }, T0)).toBe(false)
    expect(s.managers.package).toEqual([])
  })

  test("inside a container: docker, no service manager, roots mapped to the host bind mount", () => {
    const s = snap(LINUX_IN_CONTAINER)
    expect(s.host).toMatchObject({ libc: "glibc", target: "linux-arm64", supported: true, os: { name: "Debian GNU/Linux", version: "12" } })
    expect(s.topology.container).toBe("docker")
    expect(s.managers.service).toBe("none")
    expect(root(s, "home")).toEqual({ id: "home", path: "/home/dev", containerPath: "/workspace/home" })
    expect(root(s, "config")).toEqual({ id: "config", path: "/home/dev/.config", containerPath: "/workspace/home/.config" })
    // A root outside any bind mount has no container mapping.
    expect(root(s, "system-bin")).toEqual({ id: "system-bin", path: "/usr/local/bin" })
    expect(harness(s, "opencode")).toMatchObject({ installed: true, path: "/usr/local/bin/opencode", health: { state: "unverified" } })
  })

  test("musl Linux is described with supported: false", () => {
    const s = snap(LINUX_MUSL)
    expect(s.host).toMatchObject({ libc: "musl", target: "linux-x64-musl", supported: false, os: { name: "Alpine Linux", version: "3.20.3" } })
    expect(s.managers.package).toEqual(["apk"])
    expect(s.managers.service).toBe("none")
  })

  test("a host without harnesses reports each one as not installed", () => {
    const s = snap(MAC_NO_HARNESS)
    expect(s.harnesses.map((h) => [h.id, h.installed])).toEqual([
      ["opencode", false],
      ["claude-code", false],
      ["codex", false],
    ])
    expect(s.topology.shims).toEqual([])
    expect(s.configs).toEqual([])
  })

  test("a symlinked config is discovered through the link (its digest is the linked file's)", async () => {
    const s = snap(MAC_SYMLINKED_CONFIG)
    expect(s.configs.find((c) => c.owner === "harness:opencode")).toEqual({
      path: `${MAC_HOME}/.config/opencode/opencode.json`,
      owner: "harness:opencode",
      format: "json",
      sha256: await sha256(OPENCODE_CONFIG),
    })
  })
})

describe("discovery safety", () => {
  test("deterministic: the same host gives the same snapshot; only capturedAt follows the clock", () => {
    for (const spec of [MAC_NATIVE, LINUX_NATIVE, LINUX_IN_CONTAINER]) {
      expect(canonicalJSON(snap(spec))).toBe(canonicalJSON(snap(spec)))
      expect({ ...snap(spec, T0 + 5), capturedAt: T0 }).toEqual(snap(spec))
    }
  })

  test("environment values and file contents are never recorded", () => {
    const spec: HostSpec = { ...MAC_NATIVE, env: { ...MAC_NATIVE.env, OPENAI_API_KEY: "sk-live-0123456789abcdef", HUB_TOKEN: "hat_0123456789abcdef" } }
    const text = canonicalJSON(snap(spec))
    expect(text).not.toContain("sk-live")
    expect(text).not.toContain("hat_")
    expect(text).not.toContain("hub.example")
    expect(text).not.toContain("MAC-UUID")
  })

  test("a credential-shaped path fails closed instead of being recorded", () => {
    const spec: HostSpec = {
      ...MAC_NO_HARNESS,
      env: { ...MAC_NO_HARNESS.env, PATH: `${MAC_HOME}/hat_0123456789abcdef/bin:/usr/bin` },
      files: { ...MAC_NO_HARNESS.files, [`${MAC_HOME}/hat_0123456789abcdef/bin/codex`]: { type: "file", content: "#!/bin/sh\n", exec: true } },
    }
    const result = discover(memoryProbe(spec), { now: T0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("secret")
  })

  test("only read methods of the probe are used", () => {
    const probe = memoryProbe(LINUX_NATIVE)
    discover(probe, { now: T0 })
    const READS = new Set(["lstat", "stat", "readFile", "readdir", "readlink", "realpath", "executable", "machineID"])
    expect(probe.calls.length).toBeGreaterThan(0)
    expect(probe.calls.filter((c) => !READS.has(c.method))).toEqual([])
  })
})
