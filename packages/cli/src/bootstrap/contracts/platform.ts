// The supported platform matrix: the only hosts a hubctl artifact is built for and a setup plan may target. Every
// other host is named explicitly with the reason it is refused, so "unsupported" is a clear answer rather than a
// guess at a nearby target.
import { fail, ok, type Result } from "./validate.ts"

export type Platform = "darwin" | "linux"
export type Arch = "arm64" | "x64"
/** "none" on macOS; "unknown" when a Linux host's C library could not be identified. */
export type Libc = "none" | "glibc" | "musl" | "unknown"
export type ServiceManager = "launchd" | "systemd-user"

export interface SupportedTarget {
  readonly target: string
  readonly platform: Platform
  readonly arch: Arch
  readonly libc: Libc
  /** The per-user service manager services are installed for on this target. */
  readonly serviceManager: ServiceManager
  /** The `bun build --compile --target` the release builds this target's hubctl with. */
  readonly bunTarget: string
}

export const SUPPORTED_TARGETS: readonly SupportedTarget[] = Object.freeze([
  { target: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", serviceManager: "launchd", bunTarget: "bun-darwin-arm64" },
  { target: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", serviceManager: "launchd", bunTarget: "bun-darwin-x64" },
  { target: "linux-x64", platform: "linux", arch: "x64", libc: "glibc", serviceManager: "systemd-user", bunTarget: "bun-linux-x64" },
  { target: "linux-arm64", platform: "linux", arch: "arm64", libc: "glibc", serviceManager: "systemd-user", bunTarget: "bun-linux-arm64" },
] as const)

export interface UnsupportedTarget {
  readonly target: string
  readonly reason: string
}

export const UNSUPPORTED_TARGETS: readonly UnsupportedTarget[] = Object.freeze([
  { target: "windows-x64", reason: "Windows bootstrap is out of scope (no launchd/systemd user services, different credential store)" },
  { target: "windows-arm64", reason: "Windows bootstrap is out of scope (no launchd/systemd user services, different credential store)" },
  { target: "linux-x64-musl", reason: "musl Linux (e.g. Alpine) has no hubctl build yet; the glibc build does not run there" },
  { target: "linux-arm64-musl", reason: "musl Linux (e.g. Alpine) has no hubctl build yet; the glibc build does not run there" },
] as const)

const PLATFORM_NAME: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }

/** The target name of a host as Node reports it (process.platform, process.arch) plus its C library. */
export function targetOf(platform: string, arch: string, libc: Libc): string {
  const name = PLATFORM_NAME[platform] ?? platform
  return `${name}-${arch}${name === "linux" && libc === "musl" ? "-musl" : ""}`
}

export const supportedTarget = (target: string): SupportedTarget | undefined => SUPPORTED_TARGETS.find((t) => t.target === target)

/** The target's entry in the matrix, or `unsupported_platform` with the documented reason. */
export function checkTarget(target: string): Result<SupportedTarget> {
  const supported = supportedTarget(target)
  if (supported) return ok(supported)
  const known = UNSUPPORTED_TARGETS.find((t) => t.target === target)
  return fail("", "unsupported_platform", known ? `${target} is not supported: ${known.reason}` : `${target} is not a supported target (supported: ${SUPPORTED_TARGETS.map((t) => t.target).join(", ")})`)
}
