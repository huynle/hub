// Read-only discovery: what `hubctl setup discover` reports about this host, as a contract DiscoverySnapshot.
// Everything comes through the injected DiscoveryProbe (reads only). Discovery never runs a harness (running even
// `--version` may create state), never records file contents or environment values, and never claims health:
// every harness it finds stays "unverified" until an adapter runs real probes. The snapshot is deterministic: the
// same host gives the same document, except for capturedAt.
import {
  checkTarget,
  EMBEDDED_ASSETS,
  fail,
  HARNESS_ORDER,
  hostFingerprint,
  PACKAGE_MANAGERS,
  rootPathIn,
  SEMVER,
  sha256Hex,
  targetOf,
  validateDiscoverySnapshot,
  type ConfigFile,
  type DiscoverySnapshot,
  type ExecutionContext,
  type HarnessPresence,
  type PackageManager,
  type Result,
  type RootID,
  type RootMapping,
  type RuntimeInfo,
  type Shim,
} from "../contracts/index.ts"
import { classifyExecutable, HARNESS_BINARIES, installOf, pathDirs, which } from "./executables.ts"
import { discoverContainer, discoverLibc, discoverOS, discoverRoots, mapContainerRoots, parseMountinfo } from "./host.ts"
import type { DiscoveryProbe } from "./probe.ts"
import { decode, join, normalizeAbs } from "./util.ts"

export interface DiscoverOptions {
  readonly now: number
}

// ---------- configs ----------

interface ConfigCandidate {
  readonly path: string
  readonly owner: ConfigFile["owner"]
  readonly format: ConfigFile["format"]
}

/** The config files a setup plan might touch, with their owners, as seen from `context` (where discovery runs). */
export function configCandidates(platform: string, roots: readonly RootMapping[], context: ExecutionContext = "host"): ConfigCandidate[] {
  const at = (id: RootID, rel: string) => {
    const r = roots.find((x) => x.id === id)
    return r ? join(rootPathIn(r, context), rel) : undefined
  }
  const list: (ConfigCandidate | undefined)[] = []
  const add = (id: RootID, rel: string, owner: ConfigFile["owner"], format: ConfigFile["format"]) => {
    const path = at(id, rel)
    list.push(path ? { path, owner, format } : undefined)
  }
  add("config", "hub/config.json", "hub", "json")
  add("config", "hub/node.json", "hub", "json")
  add("config", "hub/claude-code.json", "hub", "json")
  add("config", "opencode/opencode.json", "harness:opencode", "json")
  add("config", "opencode/opencode.jsonc", "harness:opencode", "jsonc")
  add("home", ".claude.json", "harness:claude-code", "json")
  add("home", ".claude/settings.json", "harness:claude-code", "json")
  add("home", ".codex/config.toml", "harness:codex", "toml")
  for (const asset of Object.values(EMBEDDED_ASSETS)) {
    if (platform === "darwin" && asset.manager === "launchd") add("launch-agents", asset.installAs, "hub", "plist")
    if (platform === "linux" && asset.manager === "systemd-user") add("systemd-user", asset.installAs, "hub", "unit")
  }
  return list.filter((c): c is ConfigCandidate => c !== undefined)
}

// ---------- snapshot ----------

/** Where each harness's binary is inside a hub install root (the adapters' unpackers). */
const HARNESS_BIN_DIR: Readonly<Record<(typeof HARNESS_ORDER)[number], string>> = { opencode: "/bin", "claude-code": "", codex: "/bin" }

/** Discovers this host through `probe`. Fails (instead of recording) if anything found looks like a credential. */
export function discover(probe: DiscoveryProbe, options: DiscoverOptions): Result<DiscoverySnapshot> {
  let roots = discoverRoots(probe)
  if (!roots) return fail("/roots", "unmapped_root", "this host has no absolute home directory")
  const home = roots[0]!.path
  const libc = discoverLibc(probe)
  const target = targetOf(probe.platform, probe.arch, libc)
  const container = discoverContainer(probe)
  // v1.1: discovery runs where apply will run; inside a container every root is read as containerPath ?? path.
  const context: ExecutionContext = container === "none" ? "host" : "container"
  if (container !== "none") roots = mapContainerRoots(roots, parseMountinfo(decode(probe.readFile("/proc/self/mountinfo", 1024 * 1024))))

  const dirs = pathDirs(probe)
  const extra = probe.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/sbin", "/usr/sbin", "/sbin", "/nix/var/nix/profiles/default/bin"]
  const managerDirs = [...dirs, ...extra.filter((d) => !dirs.includes(d))]
  const packages: PackageManager[] = PACKAGE_MANAGERS.filter((m) => which(probe, managerDirs, m) !== undefined)
  const runtime: RuntimeInfo[] = probe.runtime && SEMVER.test(probe.runtime.version) && normalizeAbs(probe.runtime.path) ? [{ ...probe.runtime }] : []
  let service: DiscoverySnapshot["managers"]["service"] = "none"
  if (probe.platform === "darwin" && probe.executable("/bin/launchctl")) service = "launchd"
  if (probe.platform === "linux" && probe.lstat("/run/systemd/system") === "directory" && which(probe, [...dirs, "/usr/bin", "/bin"], "systemctl")) service = "systemd-user"

  const shims: Shim[] = []
  const harnesses: HarnessPresence[] = HARNESS_ORDER.map((id) => {
    const name = HARNESS_BINARIES[id]
    const known = id === "opencode" ? [join(home, ".opencode/bin")] : id === "claude-code" ? [join(home, ".local/bin"), join(home, ".claude/local")] : []
    // A harness hub installed (data:hub/harnesses/<id>/current) is found off PATH too, so a rerun after an install
    // sees it (installMethod "hub") and plans nothing more. PATH still wins.
    const data = roots!.find((r) => r.id === "data")
    if (data) known.push(join(rootPathIn(data, context), `hub/harnesses/${id}/current${HARNESS_BIN_DIR[id]}`))
    const path = which(probe, [...dirs, ...known.filter((d) => !dirs.includes(d))], name)
    if (!path) return { id, installed: false, health: { state: "unverified", probes: [] } }
    const shim = classifyExecutable(probe, name, path)
    shims.push(shim)
    const install = installOf(probe, id, shim, roots!, context)
    return { id, installed: true, path, ...(install.version ? { version: install.version } : {}), installMethod: install.installMethod, health: { state: "unverified", probes: [] } }
  })

  const configs: ConfigFile[] = []
  for (const c of configCandidates(probe.platform, roots, context)) {
    if (probe.stat(c.path) !== "file") continue
    const bytes = probe.readFile(c.path)
    if (!bytes) return fail("/configs", "invalid_value", `${c.path} exists but cannot be read; discovery will not guess its contents`)
    configs.push({ ...c, sha256: `sha256:${sha256Hex(bytes)}` })
  }
  configs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const machineID = probe.machineID()?.trim() || `hostname:${probe.hostname}`
  const snapshot: DiscoverySnapshot = {
    schema: "hub.discovery-snapshot",
    version: 1,
    capturedAt: options.now,
    host: {
      fingerprint: hostFingerprint({ machineID, platform: probe.platform, arch: probe.arch, uid: probe.uid, home }),
      platform: probe.platform,
      arch: probe.arch,
      libc,
      target,
      supported: checkTarget(target).ok,
      os: discoverOS(probe),
    },
    topology: { container, shims },
    managers: { package: packages, runtime, service },
    harnesses,
    runtimes: [{ id: "openshell", present: which(probe, dirs, "openshell") !== undefined }],
    configs,
    roots,
  }
  return validateDiscoverySnapshot(snapshot)
}

