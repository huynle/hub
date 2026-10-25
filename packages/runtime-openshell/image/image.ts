// The hub sandbox image and its upload fallback (P5 spike report gut64rwq §7–§8): naming, layout and the commands
// build.ts and the openshell runtime run. Pure: nothing here touches Docker, the network or a sandbox.
//
// Layout (the same under both roots, so one entry script serves both):
//   <root>/bin/opencode                              the Linux OpenCode build from npm @opencode/cli-linux-<arch>
//   <root>/bin/hub-sandbox-start                     starts the entry script detached (setsid nohup), returns at once
//   <root>/bin/hub-sandbox-entry                     waits for .hub/config.json + .hub/ready, runs `opencode serve
//                                                    --service`, stops it on .hub/stop
//   <root>/lib/hub/node_modules/@huynle/hub          the hub plugin (this repository's package), with its dependencies
// Roots: IMAGE_ROOT in the hub-sandbox image; BOOTSTRAP_ROOT when the runtime uploads the bootstrap tarball into a
// sandbox on the gateway's default image (/usr is read-only there; only /sandbox and /tmp are writable).

/** The OpenCode release the image pins (the version the repository's live tests run against). */
export const OPENCODE_VERSION = "2.1.4"
/** The image repository name; a registry prefix makes it pullable (the vm driver pulls over HTTPS only). */
export const IMAGE_NAME = "hub-sandbox"
/** Where the image installs the harness, scripts and plugin. */
export const IMAGE_ROOT = "/usr/local"
/** Where the bootstrap fallback unpacks the same layout inside a sandbox. */
export const BOOTSTRAP_ROOT = "/sandbox/.hub/opt"
/** The sandbox's writable working directory: uploads, downloads and the bootstrap live under it. */
export const SANDBOX_HOME = "/sandbox"
export const START_SCRIPT = "hub-sandbox-start"
export const ENTRY_SCRIPT = "hub-sandbox-entry"
export const PLUGIN_SUBPATH = "lib/hub/node_modules/@huynle/hub"

export type LinuxArch = "arm64" | "x64"

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The Linux build matching a host architecture (process.arch or uname -m); throws for others. */
export function linuxArch(arch: string): LinuxArch {
  if (arch === "arm64" || arch === "aarch64") return "arm64"
  if (arch === "x64" || arch === "amd64" || arch === "x86_64") return "x64"
  throw new Error(`no Linux OpenCode build for architecture ${arch} (arm64 and x64 only)`)
}

export function dockerPlatform(arch: LinuxArch): string {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64"
}

function pinned(version: string): string {
  if (!VERSION.test(version)) throw new Error(`the OpenCode version must be an exact version, not ${JSON.stringify(version)}`)
  return version
}

/** The npm package of the Linux OpenCode build: @opencode/cli-linux-<arch>@<version>. */
export function opencodePackage(arch: LinuxArch, version: string = OPENCODE_VERSION): string {
  return `@opencode/cli-linux-${arch}@${pinned(version)}`
}

/** The registry tarball of that package (it holds package/bin/opencode). */
export function opencodeTarballURL(arch: LinuxArch, version: string = OPENCODE_VERSION): string {
  return `https://registry.npmjs.org/@opencode/cli-linux-${arch}/-/cli-linux-${arch}-${pinned(version)}.tgz`
}

/** The registry metadata of that version (dist.integrity, dist.tarball). */
export function opencodeMetadataURL(arch: LinuxArch, version: string = OPENCODE_VERSION): string {
  return `https://registry.npmjs.org/@opencode/cli-linux-${arch}/${pinned(version)}`
}

/** <name>:<hub version>-opencode<OpenCode version>. */
export function imageTag(hubVersion: string, opencodeVersion: string = OPENCODE_VERSION, name: string = IMAGE_NAME): string {
  return `${name}:${hubVersion}-opencode${pinned(opencodeVersion)}`
}

export function bootstrapTarballName(hubVersion: string, arch: LinuxArch, opencodeVersion: string = OPENCODE_VERSION): string {
  return `${IMAGE_NAME}-bootstrap-${hubVersion}-opencode${pinned(opencodeVersion)}-linux-${arch}.tgz`
}

/** The harness binary under a root; the sandbox policy must name it (policy.ts HARNESS_BINARY for the image). */
export function harnessBinary(root: string = IMAGE_ROOT): string {
  return `${root}/bin/opencode`
}

export function pluginDir(root: string = IMAGE_ROOT): string {
  return `${root}/${PLUGIN_SUBPATH}`
}

/** The argv the runtime execs (after start uploaded .hub/config.json and touched .hub/ready, or before). */
export function startCommand(root: string = IMAGE_ROOT): string[] {
  return [`${root}/bin/${START_SCRIPT}`]
}

/** Unpacks an uploaded bootstrap tarball (a path under /sandbox) into the bootstrap root, then removes it. */
export function bootstrapCommands(uploaded: string, root: string = BOOTSTRAP_ROOT): string[][] {
  const parts = uploaded.split("/")
  if (!uploaded.startsWith(`${SANDBOX_HOME}/`) || parts.includes("..") || parts.includes(".")) throw new Error(`the bootstrap tarball must be uploaded under ${SANDBOX_HOME}, not ${uploaded}`)
  return [
    ["mkdir", "-p", root],
    ["tar", "-xzf", uploaded, "-C", root],
    ["rm", "-f", uploaded],
  ]
}

export interface DockerBuildOptions {
  readonly tag: string
  readonly arch: LinuxArch
  /** The staged build context (build.ts stage). */
  readonly context: string
  readonly hubVersion: string
  readonly opencodeVersion?: string
}

/** `docker build` arguments for one platform. */
export function dockerBuildArgs(o: DockerBuildOptions): string[] {
  return [
    "build",
    "--platform",
    dockerPlatform(o.arch),
    "--tag",
    o.tag,
    "--build-arg",
    `HUB_VERSION=${o.hubVersion}`,
    "--build-arg",
    `OPENCODE_VERSION=${pinned(o.opencodeVersion ?? OPENCODE_VERSION)}`,
    o.context,
  ]
}
