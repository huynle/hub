// Executables on PATH: where a command is, whether it is a native binary, a wrapper script or a shim into a
// container (docker/podman exec), what it resolves to, and how (and at which version) a harness was installed,
// read from the install layout. A harness is never run to find out.
import { SEMVER, type HarnessID, type InstallMethod, type RootMapping, type Shim, type ShimKind } from "../contracts/index.ts"
import type { DiscoveryProbe } from "./probe.ts"
import { decode, join, normalizeAbs } from "./util.ts"

/** How much of an executable discovery reads to tell a native binary from a script. */
const HEAD_BYTES = 4096
const MAX_PATH_DIRS = 64

/** The command each harness is started with. */
export const HARNESS_BINARIES: Readonly<Record<HarnessID, string>> = Object.freeze({ opencode: "opencode", "claude-code": "claude", codex: "codex" })

// ---------- executables ----------

export function pathDirs(probe: DiscoveryProbe): string[] {
  const dirs: string[] = []
  for (const raw of (probe.env.PATH ?? "").split(":")) {
    const d = normalizeAbs(raw)
    if (d && !dirs.includes(d)) dirs.push(d)
    if (dirs.length >= MAX_PATH_DIRS) break
  }
  return dirs
}

export function which(probe: DiscoveryProbe, dirs: readonly string[], name: string): string | undefined {
  for (const d of dirs) {
    const candidate = join(d, name)
    if (probe.executable(candidate)) return candidate
  }
  return undefined
}

const CONTAINER_EXEC = /\b(?:docker|podman|nerdctl|distrobox|toolbox|lxc|lxc-attach)\b[^\n]*\b(?:exec|enter|run|attach)\b/
/** Container-exec options that take a value (the next word is not the program). */
const VALUE_OPTIONS = new Set(["-w", "--workdir", "-e", "--env", "-u", "--user", "--env-file", "--detach-keys", "--name"])

/** The first absolute program path after a container exec (`docker exec -i box /usr/bin/opencode "$@"`). */
function containerTarget(script: string): string | undefined {
  const line = script.split("\n").find((l) => CONTAINER_EXEC.test(l))
  if (!line) return undefined
  const words = line.trim().split(/\s+/)
  const start = words.findIndex((w, i) => /^(?:exec|enter|run|attach)$/.test(w) && words.slice(0, i).some((x) => /(?:docker|podman|nerdctl|distrobox|toolbox|lxc|lxc-attach)$/.test(x)))
  for (let i = start + 1; start >= 0 && i < words.length; i++) {
    if (VALUE_OPTIONS.has(words[i - 1]!)) continue
    const p = normalizeAbs(words[i])
    if (p) return p
  }
  return undefined
}

/** The absolute program a wrapper script execs (`exec /opt/x/bin/tool "$@"`). */
function wrapperTarget(script: string): string | undefined {
  for (const line of script.split("\n").slice(1)) {
    const m = /^\s*exec\s+(\S+)/.exec(line)
    const p = m ? normalizeAbs(m[1]) : undefined
    if (p) return p
  }
  return undefined
}

const MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O (thin and universal)
]

/** What an executable on PATH is: a native binary, a script wrapper, or a shim into a container. */
export function classifyExecutable(probe: DiscoveryProbe, name: string, path: string): Shim {
  const isLink = probe.lstat(path) === "symlink"
  const real = isLink ? normalizeAbs(probe.realpath(path)) : undefined
  const head = probe.readFile(path, HEAD_BYTES) ?? new Uint8Array()
  const native = MAGIC.some((m) => m.every((b, i) => head[i] === b))
  let kind: ShimKind = native || isLink ? "host" : "unknown"
  let resolvesTo = real && real !== path ? real : undefined
  if (!native && head[0] === 0x23 && head[1] === 0x21) {
    const script = decode(head)
    if (CONTAINER_EXEC.test(script)) {
      kind = "container-shim"
      resolvesTo = containerTarget(script)
    } else {
      kind = "wrapper"
      resolvesTo ??= wrapperTarget(script)
    }
  }
  return resolvesTo ? { name, path, kind, resolvesTo } : { name, path, kind }
}

function packageVersion(probe: DiscoveryProbe, real: string): string | undefined {
  const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(real)
  if (!m) return undefined
  try {
    const pkg = JSON.parse(decode(probe.readFile(`${m[1]}/package.json`, 64 * 1024))) as { version?: unknown }
    return typeof pkg.version === "string" && SEMVER.test(pkg.version) ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** How a harness was installed, and its version when the install layout states it (never by running it). */
export function installOf(probe: DiscoveryProbe, id: HarnessID, shim: Shim, roots: readonly RootMapping[]): { installMethod: InstallMethod; version?: string } {
  if (shim.kind === "container-shim") return { installMethod: "unknown" }
  const real = shim.kind === "host" || shim.kind === "wrapper" ? (shim.resolvesTo ?? shim.path) : shim.path
  const semver = (v: string | undefined) => (v && SEMVER.test(v) ? v : undefined)
  // Paths are read in this (possibly container) view of each root.
  const local = (root: string) => roots.find((r) => r.id === root)?.containerPath ?? roots.find((r) => r.id === root)?.path
  const data = local("data")
  const home = local("home")
  const hub = data ? new RegExp(`^${escape(data)}/hub/harnesses/${escape(id)}/([^/]+)(?:/|$)`).exec(real) : null
  if (hub && semver(hub[1])) return { installMethod: "hub", version: hub[1] }
  const brew = /\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//.exec(real)
  if (brew) return { installMethod: "brew", ...(semver(brew[1]) ? { version: brew[1] } : {}) }
  if (real.includes("/node_modules/")) {
    const version = packageVersion(probe, real)
    return { installMethod: "npm", ...(version ? { version } : {}) }
  }
  const claude = /\/claude\/versions\/([^/]+)$/.exec(real)
  if (id === "claude-code" && claude) return { installMethod: "native", ...(semver(claude[1]) ? { version: claude[1] } : {}) }
  if (home && id === "opencode" && real.startsWith(`${home}/.opencode/bin/`)) return { installMethod: "native" }
  if (/^\/(?:usr\/)?s?bin\//.test(real)) return { installMethod: "package-manager" }
  return { installMethod: "unknown" }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
