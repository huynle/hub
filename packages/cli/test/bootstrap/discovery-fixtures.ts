// In-memory hosts for the discovery and preview tests (HBS-03). A host is a plain map of paths to files,
// directories and symlinks; memoryProbe() exposes it through the read-only DiscoveryProbe and records every call,
// so a test can prove discover and preview only ever read. No real machine, user or secret appears here.
import type { EntryKind } from "../../src/bootstrap/contracts/index.ts"
import type { DiscoveryProbe, RuntimeFact } from "../../src/bootstrap/discovery/probe.ts"

export type Node =
  | { readonly type: "file"; readonly content: string | Uint8Array; readonly exec?: boolean }
  | { readonly type: "dir" }
  | { readonly type: "link"; readonly target: string }

export interface HostSpec {
  readonly platform: string
  readonly arch: string
  readonly uid?: number
  readonly home: string
  readonly hostname?: string
  readonly env: Record<string, string | undefined>
  readonly runtime?: RuntimeFact
  readonly machineID?: string
  readonly files: Record<string, Node>
}

export interface RecordingProbe extends DiscoveryProbe {
  readonly calls: { readonly method: string; readonly path?: string }[]
}

export const file = (content: string | Uint8Array, exec = false): Node => ({ type: "file", content, exec })
export const exe = (content: string | Uint8Array): Node => file(content, true)
export const dir: Node = { type: "dir" }
export const link = (target: string): Node => ({ type: "link", target })

/** The first bytes of native executables. */
export const MACHO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])
export const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])

const normalize = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p)
const parent = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")))
const join = (a: string, b: string) => (b.startsWith("/") ? b : a === "/" ? `/${b}` : `${a}/${b}`)

/** A probe over `spec`; every method call is recorded in `calls`. */
export function memoryProbe(spec: HostSpec): RecordingProbe {
  const files = new Map<string, Node>()
  // Every ancestor of a listed path is a directory.
  for (const [raw, node] of Object.entries(spec.files)) {
    const p = normalize(raw)
    files.set(p, node)
    for (let a = parent(p); ; a = parent(a)) {
      if (!files.has(a)) files.set(a, dir)
      if (a === "/") break
    }
  }
  const calls: { method: string; path?: string }[] = []

  // Resolves every link in `path` (including the last when `follow`); undefined when a component is missing.
  const resolve = (path: string, follow: boolean, depth = 0): string | undefined => {
    if (depth > 32) return undefined
    const parts = normalize(path).split("/").filter(Boolean)
    let current = "/"
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === ".") continue
      if (parts[i] === "..") {
        current = parent(current)
        continue
      }
      const next = join(current, parts[i]!)
      const node = files.get(next)
      if (!node) return i === parts.length - 1 && !follow ? next : undefined
      if (node.type === "link" && (follow || i < parts.length - 1)) {
        const target = resolve(join(current, node.target), true, depth + 1)
        if (!target) return undefined
        current = target
      } else current = next
    }
    return current
  }
  const nodeAt = (path: string, follow: boolean) => {
    const p = resolve(path, follow)
    return p ? files.get(p) : undefined
  }
  const kind = (node: Node | undefined): EntryKind => (!node ? "missing" : node.type === "link" ? "symlink" : node.type === "dir" ? "directory" : "file")
  const bytes = (c: string | Uint8Array) => (typeof c === "string" ? new TextEncoder().encode(c) : c)
  const record = (method: string, path?: string) => calls.push(path === undefined ? { method } : { method, path })

  return {
    calls,
    platform: spec.platform,
    arch: spec.arch,
    uid: spec.uid ?? 501,
    home: spec.home,
    hostname: spec.hostname ?? "devbox",
    env: spec.env,
    runtime: spec.runtime,
    lstat(path) {
      record("lstat", path)
      return kind(nodeAt(path, false))
    },
    stat(path) {
      record("stat", path)
      return kind(nodeAt(path, true))
    },
    readFile(path, limit) {
      record("readFile", path)
      const node = nodeAt(path, true)
      if (node?.type !== "file") return undefined
      const b = bytes(node.content)
      return limit === undefined ? b : b.slice(0, limit)
    },
    readdir(path) {
      record("readdir", path)
      const p = resolve(path, true)
      if (!p || files.get(p)?.type !== "dir") return undefined
      const prefix = p === "/" ? "/" : `${p}/`
      return [...files.keys()].filter((k) => k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length)).sort()
    },
    readlink(path) {
      record("readlink", path)
      const node = nodeAt(path, false)
      return node?.type === "link" ? node.target : undefined
    },
    realpath(path) {
      record("realpath", path)
      const p = resolve(path, true)
      return p && files.has(p) ? p : undefined
    },
    executable(path) {
      record("executable", path)
      const node = nodeAt(path, true)
      return node?.type === "file" && node.exec === true
    },
    machineID() {
      record("machineID")
      return spec.machineID
    },
  }
}

// ---------- hosts ----------

const MAC_HOME = "/Users/dev"
const LINUX_HOME = "/home/dev"

const OPENCODE_CONFIG = JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [] }, null, 2)

/** macOS, arm64, native OpenCode in ~/.opencode/bin, Homebrew, launchd. */
export const MAC_NATIVE: HostSpec = {
  platform: "darwin",
  arch: "arm64",
  home: MAC_HOME,
  env: { HOME: MAC_HOME, PATH: `${MAC_HOME}/.opencode/bin:/opt/homebrew/bin:/usr/bin:/bin` },
  runtime: { id: "bun", version: "1.3.5", path: `${MAC_HOME}/.bun/bin/bun` },
  machineID: "MAC-UUID-0001",
  files: {
    "/System/Library/CoreServices/SystemVersion.plist": file(
      "<?xml version=\"1.0\"?><plist><dict><key>ProductName</key><string>macOS</string><key>ProductVersion</key><string>15.4</string></dict></plist>",
    ),
    "/bin/launchctl": exe(MACHO),
    "/usr/bin/true": exe(MACHO),
    "/opt/homebrew/bin/brew": exe("#!/bin/bash\n# brew\n"),
    "/opt/homebrew/bin/npm": link("../lib/node_modules/npm/bin/npm-cli.js"),
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js": exe("#!/usr/bin/env node\n"),
    [`${MAC_HOME}/.opencode/bin/opencode`]: exe(MACHO),
    [`${MAC_HOME}/.config/opencode/opencode.json`]: file(OPENCODE_CONFIG),
    [`${MAC_HOME}/.config/hub/config.json`]: file("{\"server\":\"https://hub.example\"}"),
    [`${MAC_HOME}/Library/LaunchAgents`]: dir,
  },
}

/** Linux x64 glibc, Claude Code native install (a link into its versions dir), Codex from npm, systemd. */
export const LINUX_NATIVE: HostSpec = {
  platform: "linux",
  arch: "x64",
  uid: 1000,
  home: LINUX_HOME,
  env: { HOME: LINUX_HOME, PATH: `${LINUX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`, XDG_CONFIG_HOME: `${LINUX_HOME}/.config/` },
  runtime: { id: "node", version: "22.11.0", path: "/usr/bin/node" },
  machineID: "0123456789abcdef0123456789abcdef",
  files: {
    "/etc/os-release": file("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\n"),
    "/etc/machine-id": file("0123456789abcdef0123456789abcdef\n"),
    "/lib64/ld-linux-x86-64.so.2": file(ELF),
    "/run/systemd/system": dir,
    "/usr/bin/systemctl": exe(ELF),
    "/usr/bin/apt": exe(ELF),
    "/usr/bin/node": exe(ELF),
    "/usr/bin/npm": link("../lib/node_modules/npm/bin/npm-cli.js"),
    "/usr/lib/node_modules/npm/bin/npm-cli.js": exe("#!/usr/bin/env node\n"),
    [`${LINUX_HOME}/.local/bin/claude`]: link(`${LINUX_HOME}/.local/share/claude/versions/2.1.90`),
    [`${LINUX_HOME}/.local/share/claude/versions/2.1.90`]: exe(ELF),
    "/usr/local/bin/codex": link("../lib/node_modules/@openai/codex/bin/codex.js"),
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js": exe("#!/usr/bin/env node\nrequire('../dist')\n"),
    "/usr/local/lib/node_modules/@openai/codex/package.json": file(JSON.stringify({ name: "@openai/codex", version: "0.165.0" })),
    [`${LINUX_HOME}/.claude.json`]: file("{\"theme\":\"dark\"}"),
    [`${LINUX_HOME}/.codex/config.toml`]: file("model = \"o4\"\n"),
    [`${LINUX_HOME}/.config/systemd/user/hub-node.service`]: file("[Unit]\nDescription=hub node\n"),
  },
}

/** A Linux host whose `opencode` on PATH is a shim that runs OpenCode inside a docker container. */
export const LINUX_CONTAINER_SHIM: HostSpec = {
  ...LINUX_NATIVE,
  files: {
    "/etc/os-release": LINUX_NATIVE.files["/etc/os-release"]!,
    "/etc/machine-id": LINUX_NATIVE.files["/etc/machine-id"]!,
    "/lib64/ld-linux-x86-64.so.2": file(ELF),
    "/run/systemd/system": dir,
    "/usr/bin/systemctl": exe(ELF),
    "/usr/bin/docker": exe(ELF),
    [`${LINUX_HOME}/.local/bin/opencode`]: exe("#!/bin/sh\nexec docker exec -i -w \"$PWD\" devbox /usr/local/bin/opencode \"$@\"\n"),
  },
}

/** Inside a docker container: /.dockerenv, no systemd, the home is a bind mount of the host's /home/dev. */
export const LINUX_IN_CONTAINER: HostSpec = {
  platform: "linux",
  arch: "arm64",
  uid: 1000,
  home: "/workspace/home",
  env: { HOME: "/workspace/home", PATH: "/usr/local/bin:/usr/bin:/bin" },
  machineID: "fedcba9876543210fedcba9876543210",
  files: {
    "/.dockerenv": file(""),
    "/etc/os-release": file("NAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\n"),
    "/lib/ld-linux-aarch64.so.1": file(ELF),
    "/proc/self/mountinfo": file(
      [
        "500 400 0:50 / / rw,relatime - overlay overlay rw",
        "510 500 259:1 /home/dev /workspace/home rw,relatime - ext4 /dev/nvme0n1p2 rw",
        "",
      ].join("\n"),
    ),
    "/usr/local/bin/opencode": exe(ELF),
  },
}

/** Linux musl (Alpine): described, never planned for. */
export const LINUX_MUSL: HostSpec = {
  platform: "linux",
  arch: "x64",
  uid: 1000,
  home: LINUX_HOME,
  env: { HOME: LINUX_HOME, PATH: "/usr/bin:/bin" },
  machineID: "11112222333344445555666677778888",
  files: {
    "/etc/os-release": file("NAME=\"Alpine Linux\"\nVERSION_ID=3.20.3\n"),
    "/lib/ld-musl-x86_64.so.1": file(ELF),
    "/sbin/apk": exe(ELF),
  },
}

/** macOS with no harness installed at all. */
export const MAC_NO_HARNESS: HostSpec = {
  ...MAC_NATIVE,
  env: { HOME: MAC_HOME, PATH: "/usr/bin:/bin" },
  files: {
    "/System/Library/CoreServices/SystemVersion.plist": MAC_NATIVE.files["/System/Library/CoreServices/SystemVersion.plist"]!,
    "/bin/launchctl": exe(MACHO),
  },
}

/** macOS whose ~/.config/opencode is a symlink into a dotfiles repository (decision Q8). */
export const MAC_SYMLINKED_CONFIG: HostSpec = {
  ...MAC_NATIVE,
  files: {
    ...Object.fromEntries(Object.entries(MAC_NATIVE.files).filter(([p]) => !p.startsWith(`${MAC_HOME}/.config/opencode`))),
    [`${MAC_HOME}/.config/opencode`]: link(`${MAC_HOME}/dot/config/opencode`),
    [`${MAC_HOME}/dot/config/opencode/opencode.json`]: file(OPENCODE_CONFIG),
  },
}

/** A file's sha256 as discovery reports it. */
export async function sha256(content: string | Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto")
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

export { OPENCODE_CONFIG, MAC_HOME, LINUX_HOME }
