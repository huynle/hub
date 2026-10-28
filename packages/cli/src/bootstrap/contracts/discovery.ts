// DiscoverySnapshot: what `hubctl setup` found on this host, read-only, before anything is planned. It separates
// presence from health (an installed harness stays "unverified" until real probes pass), records the container and
// shim topology (a `claude` on PATH may be a shim into another environment), the package/runtime/service managers,
// who owns each config file it would touch, and where each path root lives. It can describe an unsupported host
// (supported: false) so the refusal is explicit; planning for such a host fails.
import { CONFIG_OWNERS, type ConfigOwner } from "./actions.ts"
import { HARNESS_ORDER, PROBE_KINDS, RUNTIME_IDS, type HarnessID, type Probe, type RuntimeID } from "./harness.ts"
import { digestOf } from "./canonical.ts"
import { ROOT_IDS, type ExecutionContext, type RootMapping } from "./paths.ts"
import { checkTarget, targetOf, type Libc, type ServiceManager } from "./platform.ts"
import { findSecrets } from "./secrets.ts"
import { absPath, bool, Checker, digest, header, instant, list, oneOf, pointer, semver, shape, subset, text, type Result } from "./validate.ts"

export const DISCOVERY_SCHEMA = "hub.discovery-snapshot"
export const DISCOVERY_VERSION = 1

export type ContainerKind = "none" | "docker" | "podman" | "lxc" | "wsl" | "unknown"
export type ShimKind = "host" | "container-shim" | "wrapper" | "unknown"
export const PACKAGE_MANAGERS = ["brew", "npm", "bun", "apt", "dnf", "apk", "pacman", "nix"] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]
/** hub: installed by hubctl from a pinned artifact. */
export type InstallMethod = "native" | "npm" | "brew" | "package-manager" | "hub" | "unknown"

export interface HostInfo {
  readonly fingerprint: string
  /** process.platform as found (may be unsupported). */
  readonly platform: string
  readonly arch: string
  readonly libc: Libc
  readonly target: string
  /** Exactly whether `target` is in SUPPORTED_TARGETS. */
  readonly supported: boolean
  readonly os: { readonly name: string; readonly version: string }
}

export interface Shim {
  readonly name: string
  readonly path: string
  readonly kind: ShimKind
  /** For a shim: what it forwards to, when known. */
  readonly resolvesTo?: string
}

export interface RuntimeInfo {
  readonly id: "bun" | "node"
  readonly version: string
  readonly path: string
}

export interface HarnessHealth {
  readonly state: "unverified" | "verified" | "failed"
  readonly probes: readonly Probe[]
}

/** A harness as discovery sees it. `installed` is presence only; `health` is what probes proved. */
export interface HarnessPresence {
  readonly id: HarnessID
  readonly installed: boolean
  readonly path?: string
  readonly version?: string
  readonly installMethod?: InstallMethod
  readonly health: HarnessHealth
}

export interface RuntimePresence {
  readonly id: RuntimeID
  readonly present: boolean
  readonly version?: string
}

export interface ConfigFile {
  readonly path: string
  readonly owner: ConfigOwner | "package-manager"
  readonly format: "json" | "jsonc" | "toml" | "plist" | "unit"
  /** Digest of its bytes now; null when it does not exist. Contents are never recorded. */
  readonly sha256: string | null
}

export interface DiscoverySnapshot {
  readonly schema: typeof DISCOVERY_SCHEMA
  readonly version: typeof DISCOVERY_VERSION
  readonly capturedAt: number
  readonly host: HostInfo
  readonly topology: { readonly container: ContainerKind; readonly shims: readonly Shim[] }
  readonly managers: { readonly package: readonly PackageManager[]; readonly runtime: readonly RuntimeInfo[]; readonly service: ServiceManager | "none" }
  readonly harnesses: readonly HarnessPresence[]
  readonly runtimes: readonly RuntimePresence[]
  readonly configs: readonly ConfigFile[]
  readonly roots: readonly RootMapping[]
}

const NAME = /^[A-Za-z0-9._+-]{1,64}$/
const VERSION_TEXT = /^[0-9A-Za-z.+_-]{1,64}$/

function checkProbe(c: Checker, p: string, v: unknown) {
  const r = shape(c, p, v, ["kind", "ok", "observedAt"], ["detail"])
  if (!r) return
  oneOf(c, pointer(p, "kind"), r.kind, PROBE_KINDS)
  bool(c, pointer(p, "ok"), r.ok)
  instant(c, pointer(p, "observedAt"), r.observedAt)
  if (r.detail !== undefined) text(c, pointer(p, "detail"), r.detail)
}

function checkHarness(c: Checker, p: string, v: unknown) {
  const r = shape(c, p, v, ["id", "installed", "health"], ["path", "version", "installMethod"])
  if (!r) return
  oneOf(c, pointer(p, "id"), r.id, HARNESS_ORDER)
  bool(c, pointer(p, "installed"), r.installed)
  if (r.path !== undefined) absPath(c, pointer(p, "path"), r.path)
  if (r.version !== undefined) text(c, pointer(p, "version"), r.version, 64, VERSION_TEXT)
  if (r.installMethod !== undefined) oneOf(c, pointer(p, "installMethod"), r.installMethod, ["native", "npm", "brew", "package-manager", "hub", "unknown"] as const)
  if (r.installed === false && (r.path !== undefined || r.version !== undefined)) c.add(p, "inconsistent", "a harness that is not installed has no path or version")
  const h = shape(c, pointer(p, "health"), r.health, ["state", "probes"])
  if (!h) return
  oneOf(c, pointer(pointer(p, "health"), "state"), h.state, ["unverified", "verified", "failed"] as const)
  list(c, pointer(pointer(p, "health"), "probes"), h.probes, 32, (pp, probe) => checkProbe(c, pp, probe))
  const probes = Array.isArray(h.probes) ? (h.probes as Partial<Probe>[]) : []
  if (h.state === "verified") {
    const real = probes.filter((pr) => pr.kind !== "presence")
    if (real.length === 0 || !probes.every((pr) => pr.ok === true)) c.add(pointer(p, "health"), "inconsistent", "verified needs passing real probes, not presence")
  }
  if (h.state === "failed" && !probes.some((pr) => pr.ok === false)) c.add(pointer(p, "health"), "inconsistent", "failed needs a failing probe")
  if (r.installed === false && h.state !== "unverified") c.add(pointer(p, "health"), "inconsistent", "a harness that is not installed cannot be verified")
}

/**
 * v1.1: the one canonical digest of a snapshot that plans, preview tokens, journals, audits and the Ansible vars
 * pin: the canonical JSON without `capturedAt`, so rediscovering an unchanged host gives the same digest.
 */
export const snapshotDigest = (snapshot: DiscoverySnapshot): string => digestOf({ ...snapshot, capturedAt: undefined })

/** v1.1: the context a plan made from this snapshot resolves paths in: where discovery (and so apply) ran. */
export const executionContextOf = (snapshot: Pick<DiscoverySnapshot, "topology">): ExecutionContext => (snapshot.topology.container === "none" ? "host" : "container")

export function validateDiscoverySnapshot(value: unknown): Result<DiscoverySnapshot> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "capturedAt", "host", "topology", "managers", "harnesses", "runtimes", "configs", "roots"])
  if (!r) return c.result(value)
  header(c, "", r, DISCOVERY_SCHEMA, DISCOVERY_VERSION)
  instant(c, "/capturedAt", r.capturedAt)

  const host = shape(c, "/host", r.host, ["fingerprint", "platform", "arch", "libc", "target", "supported", "os"])
  if (host) {
    digest(c, "/host/fingerprint", host.fingerprint)
    text(c, "/host/platform", host.platform, 32, NAME)
    text(c, "/host/arch", host.arch, 32, NAME)
    oneOf(c, "/host/libc", host.libc, ["none", "glibc", "musl", "unknown"] as const)
    text(c, "/host/target", host.target, 64, NAME)
    bool(c, "/host/supported", host.supported)
    const os = shape(c, "/host/os", host.os, ["name", "version"])
    if (os) {
      text(c, "/host/os/name", os.name, 64)
      text(c, "/host/os/version", os.version, 64)
    }
    if (typeof host.platform === "string" && typeof host.arch === "string" && typeof host.libc === "string" && host.target !== targetOf(host.platform, host.arch, host.libc as Libc))
      c.add("/host/target", "inconsistent", "target does not match platform, arch and libc")
    if (typeof host.target === "string" && host.supported !== checkTarget(host.target).ok) c.add("/host/supported", "inconsistent", "supported must say exactly whether the target is in the support matrix")
  }

  const topology = shape(c, "/topology", r.topology, ["container", "shims"])
  if (topology) {
    oneOf(c, "/topology/container", topology.container, ["none", "docker", "podman", "lxc", "wsl", "unknown"] as const)
    list(c, "/topology/shims", topology.shims, 64, (p, v) => {
      const s = shape(c, p, v, ["name", "path", "kind"], ["resolvesTo"])
      if (!s) return
      text(c, pointer(p, "name"), s.name, 64, NAME)
      absPath(c, pointer(p, "path"), s.path)
      oneOf(c, pointer(p, "kind"), s.kind, ["host", "container-shim", "wrapper", "unknown"] as const)
      if (s.resolvesTo !== undefined) absPath(c, pointer(p, "resolvesTo"), s.resolvesTo)
    })
  }

  const managers = shape(c, "/managers", r.managers, ["package", "runtime", "service"])
  if (managers) {
    subset(c, "/managers/package", managers.package, PACKAGE_MANAGERS)
    list(c, "/managers/runtime", managers.runtime, 8, (p, v) => {
      const rt = shape(c, p, v, ["id", "version", "path"])
      if (!rt) return
      oneOf(c, pointer(p, "id"), rt.id, ["bun", "node"] as const)
      semver(c, pointer(p, "version"), rt.version)
      absPath(c, pointer(p, "path"), rt.path)
    })
    oneOf(c, "/managers/service", managers.service, ["launchd", "systemd-user", "none"] as const)
    const platform = host?.platform
    if (managers.service === "launchd" && platform !== "darwin") c.add("/managers/service", "inconsistent", "launchd is macOS only")
    if (managers.service === "systemd-user" && platform !== "linux") c.add("/managers/service", "inconsistent", "systemd is Linux only")
  }

  list(c, "/harnesses", r.harnesses, HARNESS_ORDER.length, (p, v) => checkHarness(c, p, v), (v) => (v as { id?: string })?.id)
  list(c, "/runtimes", r.runtimes, RUNTIME_IDS.length, (p, v) => {
    const rt = shape(c, p, v, ["id", "present"], ["version"])
    if (!rt) return
    oneOf(c, pointer(p, "id"), rt.id, RUNTIME_IDS)
    bool(c, pointer(p, "present"), rt.present)
    if (rt.version !== undefined) text(c, pointer(p, "version"), rt.version, 64, VERSION_TEXT)
  }, (v) => (v as { id?: string })?.id)
  list(c, "/configs", r.configs, 128, (p, v) => {
    const cf = shape(c, p, v, ["path", "owner", "format", "sha256"])
    if (!cf) return
    absPath(c, pointer(p, "path"), cf.path)
    oneOf(c, pointer(p, "owner"), cf.owner, [...CONFIG_OWNERS, "package-manager"])
    oneOf(c, pointer(p, "format"), cf.format, ["json", "jsonc", "toml", "plist", "unit"] as const)
    if (cf.sha256 !== null) digest(c, pointer(p, "sha256"), cf.sha256)
  }, (v) => (v as { path?: string })?.path)
  list(c, "/roots", r.roots, ROOT_IDS.length, (p, v) => {
    const root = shape(c, p, v, ["id", "path"], ["containerPath"])
    if (!root) return
    oneOf(c, pointer(p, "id"), root.id, ROOT_IDS)
    absPath(c, pointer(p, "path"), root.path)
    if (root.containerPath !== undefined) absPath(c, pointer(p, "containerPath"), root.containerPath)
  }, (v) => (v as { id?: string })?.id)

  for (const p of findSecrets(value)) c.add(p, "secret", "discovery never records credentials")
  return c.result(value)
}
