// Host facts: path roots (and their host location inside a container), C library, OS name and version, and
// container kind. Everything is read through the probe; nothing is executed.
import { ROOT_IDS, type ContainerKind, type Libc, type RootID, type RootMapping } from "../contracts/index.ts"
import type { DiscoveryProbe } from "./probe.ts"
import { decode, join, normalizeAbs, oneLine } from "./util.ts"

// ---------- roots ----------

export function discoverRoots(probe: DiscoveryProbe): RootMapping[] | undefined {
  const home = normalizeAbs(probe.env.HOME) ?? normalizeAbs(probe.home)
  if (!home) return undefined
  const xdg = (key: string, fallback: string) => normalizeAbs(probe.env[key]) ?? join(home, fallback)
  const config = xdg("XDG_CONFIG_HOME", ".config")
  const paths: Partial<Record<RootID, string>> = {
    home,
    config,
    state: xdg("XDG_STATE_HOME", ".local/state"),
    data: xdg("XDG_DATA_HOME", ".local/share"),
    "user-bin": join(home, ".local/bin"),
    "system-bin": "/usr/local/bin",
  }
  if (probe.platform === "darwin") paths["launch-agents"] = join(home, "Library/LaunchAgents")
  if (probe.platform === "linux") paths["systemd-user"] = join(config, "systemd/user")
  return ROOT_IDS.flatMap((id) => (paths[id] ? [{ id, path: paths[id]! }] : []))
}

export interface Mount {
  readonly root: string
  readonly point: string
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))

export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = []
  for (const line of text.split("\n")) {
    const f = line.split(" ")
    if (f.length < 5) continue
    const root = normalizeAbs(unescapeMount(f[3]!))
    const point = normalizeAbs(unescapeMount(f[4]!))
    if (root && point) mounts.push({ root, point })
  }
  return mounts
}

/** In a container: where each root lives on the host, when it sits in a bind mount of a host directory. */
export function mapContainerRoots(roots: RootMapping[], mounts: readonly Mount[]): RootMapping[] {
  return roots.map((r) => {
    const mount = mounts
      .filter((m) => r.path === m.point || r.path.startsWith(m.point === "/" ? "/" : `${m.point}/`))
      .sort((a, b) => b.point.length - a.point.length)[0]
    if (!mount || mount.root === "/" || mount.root === mount.point) return r
    const host = normalizeAbs(mount.root + r.path.slice(mount.point.length))
    return host ? { id: r.id, path: host, containerPath: r.path } : r
  })
}

// ---------- host ----------

export function discoverLibc(probe: DiscoveryProbe): Libc {
  if (probe.platform === "darwin") return "none"
  if (probe.platform !== "linux") return "unknown"
  const names = ["/lib", "/lib64", "/usr/lib"].flatMap((d) => probe.readdir(d) ?? [])
  if (names.some((n) => n.startsWith("ld-musl-"))) return "musl"
  if (names.some((n) => n.startsWith("ld-linux"))) return "glibc"
  return "unknown"
}

export function discoverOS(probe: DiscoveryProbe): { name: string; version: string } {
  if (probe.platform === "darwin") {
    const plist = decode(probe.readFile("/System/Library/CoreServices/SystemVersion.plist", 64 * 1024))
    const value = (key: string) => oneLine(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1])
    return { name: value("ProductName") ?? "macOS", version: value("ProductVersion") ?? "unknown" }
  }
  if (probe.platform === "linux") {
    const text = decode(probe.readFile("/etc/os-release", 64 * 1024) ?? probe.readFile("/usr/lib/os-release", 64 * 1024))
    const value = (key: string) => oneLine(new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2"))
    return { name: value("NAME") ?? "Linux", version: value("VERSION_ID") ?? "unknown" }
  }
  return { name: oneLine(probe.platform, 32) ?? "unknown", version: "unknown" }
}

export function discoverContainer(probe: DiscoveryProbe): ContainerKind {
  if (probe.platform !== "linux") return "none"
  if (probe.lstat("/.dockerenv") !== "missing") return "docker"
  if (probe.lstat("/run/.containerenv") !== "missing") return "podman"
  const env = probe.env.container
  if (env === "docker" || env === "podman" || env === "lxc") return env
  if (env) return "unknown"
  const cgroup = decode(probe.readFile("/proc/1/cgroup", 64 * 1024))
  if (/libpod/.test(cgroup)) return "podman"
  if (/docker|containerd/.test(cgroup)) return "docker"
  if (/\blxc\b/.test(cgroup)) return "lxc"
  if (/microsoft|wsl/i.test(decode(probe.readFile("/proc/sys/kernel/osrelease", 4096)))) return "wsl"
  return "none"
}
