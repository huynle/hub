#!/usr/bin/env bun
// Builds the hub sandbox image, or the bootstrap tarball of the upload fallback (see README.md next to this file).
//
//   bun packages/runtime-openshell/image/build.ts image     [--arch arm64|x64] [--tag NAME:TAG]
//   bun packages/runtime-openshell/image/build.ts bootstrap [--arch arm64|x64] [--out FILE.tgz]
//   bun packages/runtime-openshell/image/build.ts stage     --out DIR [--arch arm64|x64]
//
// All three stage the same layout (image.ts): bin/opencode (the pinned Linux OpenCode from the npm registry, checked
// against the registry's sha512 integrity), bin/hub-sandbox-start and bin/hub-sandbox-entry (start.sh, entry.sh) and
// lib/hub/node_modules/@huynle/hub (this repository packed with `npm pack --ignore-scripts` and installed with its
// production dependencies). `image` adds the Dockerfile and runs `docker build` for one platform; it never pushes
// (OpenShell's vm driver pulls from an HTTPS registry, not from local Docker: publishing is a separate, deliberate
// step, see README.md). `bootstrap` packs the layout as a .tgz for the runtime to upload into /sandbox/.hub/opt.
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ENTRY_SCRIPT,
  OPENCODE_VERSION,
  PLUGIN_SUBPATH,
  START_SCRIPT,
  bootstrapTarballName,
  dockerBuildArgs,
  imageTag,
  linuxArch,
  opencodeMetadataURL,
  opencodeTarballURL,
  type LinuxArch,
} from "./image.ts"

/** Runs a command (argv, no shell) and returns its stdout; throws on a non-zero exit. */
export type Run = (cmd: readonly string[], cwd?: string) => Promise<string>

const HERE = import.meta.dir
const REPO_ROOT = path.join(HERE, "..", "..", "..")
const REGISTRY = "https://registry.npmjs.org/"

export const run: Run = async (cmd, cwd) => {
  const p = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${err.trim().split("\n").slice(-5).join("\n")}`)
  return out
}

/** Throws unless `bytes` match an npm sha512 subresource-integrity string. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const sha512 = integrity.split(/\s+/).find((s) => s.startsWith("sha512-"))
  if (!sha512) throw new Error(`expected a sha512 integrity, got ${JSON.stringify(integrity)}`)
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  if (actual !== sha512) throw new Error(`integrity mismatch: expected ${sha512}, got ${actual}`)
}

export interface BuildOptions {
  readonly arch: LinuxArch
  /** This repository (default: three levels up from this file). */
  readonly repoRoot?: string
  readonly opencodeVersion?: string
  readonly fetch?: typeof fetch
  readonly run?: Run
  readonly log?: (line: string) => void
}

export interface StageOptions extends BuildOptions {
  /** The context directory: created, or empty. */
  readonly dir: string
  /** Copy the Dockerfile too (default true). */
  readonly dockerfile?: boolean
}

/** Stages the layout into `dir`; returns the hub version packed. */
export async function stage(o: StageOptions): Promise<{ dir: string; hubVersion: string }> {
  const exec = o.run ?? run
  const get = o.fetch ?? fetch
  const log = o.log ?? (() => {})
  const repoRoot = o.repoRoot ?? REPO_ROOT
  const version = o.opencodeVersion ?? OPENCODE_VERSION
  if (existsSync(o.dir) && readdirSync(o.dir).length > 0) throw new Error(`the context directory ${o.dir} is not empty`)
  const bin = path.join(o.dir, "bin")
  mkdirSync(bin, { recursive: true })
  const work = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-sandbox-stage-"))
  try {
    // The Linux OpenCode build, checked against the registry's integrity.
    log(`fetching OpenCode ${version} for linux-${o.arch}`)
    const meta = await get(opencodeMetadataURL(o.arch, version))
    if (!meta.ok) throw new Error(`npm registry: ${meta.status} for ${opencodeMetadataURL(o.arch, version)}`)
    const dist = ((await meta.json()) as { dist?: { tarball?: unknown; integrity?: unknown } }).dist
    if (typeof dist?.tarball !== "string" || typeof dist.integrity !== "string") throw new Error("npm registry: no dist.tarball/dist.integrity")
    if (!dist.tarball.startsWith(REGISTRY)) throw new Error(`refusing an OpenCode tarball outside the npm registry: ${dist.tarball}`)
    const res = await get(dist.tarball)
    if (!res.ok) throw new Error(`npm registry: ${res.status} for ${dist.tarball}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    verifyIntegrity(bytes, dist.integrity)
    const tgz = path.join(work, "opencode.tgz")
    writeFileSync(tgz, bytes)
    await exec(["tar", "-xzf", tgz, "-C", work, "package/bin/opencode"])
    copyFileSync(path.join(work, "package/bin/opencode"), path.join(bin, "opencode"))
    chmodSync(path.join(bin, "opencode"), 0o755)

    // The scripts.
    for (const [name, src] of [
      [START_SCRIPT, "start.sh"],
      [ENTRY_SCRIPT, "entry.sh"],
    ] as const) {
      copyFileSync(path.join(HERE, src), path.join(bin, name))
      chmodSync(path.join(bin, name), 0o755)
    }

    // The hub plugin: this repository as its npm package, with production dependencies.
    log("packing the hub plugin")
    const packed = JSON.parse(await exec(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", work], repoRoot)) as Array<{ filename: string }>
    const file = packed[0]?.filename
    if (!file) throw new Error("npm pack reported no file")
    const prefix = path.join(o.dir, "lib/hub")
    mkdirSync(prefix, { recursive: true })
    await exec(["npm", "install", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", path.join(work, path.basename(file))], work)
    if (!existsSync(path.join(o.dir, PLUGIN_SUBPATH, "server.ts"))) throw new Error(`the plugin was not installed at ${PLUGIN_SUBPATH}`)
    // The prefix's package.json only names the temporary tarball.
    rmSync(path.join(prefix, "package.json"), { force: true })

    if (o.dockerfile !== false) copyFileSync(path.join(HERE, "Dockerfile"), path.join(o.dir, "Dockerfile"))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  const hubVersion = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version
  return { dir: o.dir, hubVersion }
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), prefix))
}

/** Builds the image locally (docker build); never pushes. */
export async function buildImage(o: BuildOptions & { tag?: string }): Promise<{ tag: string }> {
  const exec = o.run ?? run
  const dir = tempDir("hub-sandbox-image-")
  try {
    const { hubVersion } = await stage({ ...o, dir })
    const tag = o.tag ?? imageTag(hubVersion, o.opencodeVersion)
    o.log?.(`docker build ${tag}`)
    await exec(["docker", ...dockerBuildArgs({ tag, arch: o.arch, context: dir, hubVersion, ...(o.opencodeVersion ? { opencodeVersion: o.opencodeVersion } : {}) })])
    return { tag }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Packs the layout as the bootstrap tarball (default name in the current directory). */
export async function buildBootstrap(o: BuildOptions & { out?: string }): Promise<{ out: string }> {
  const exec = o.run ?? run
  const dir = tempDir("hub-sandbox-bootstrap-")
  try {
    const { hubVersion } = await stage({ ...o, dir, dockerfile: false })
    const out = path.resolve(o.out ?? bootstrapTarballName(hubVersion, o.arch, o.opencodeVersion))
    await exec(["tar", "-czf", out, "-C", dir, "bin", "lib"])
    return { out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface Args {
  readonly command: "image" | "bootstrap" | "stage"
  readonly arch: LinuxArch
  readonly tag?: string
  readonly out?: string
}

const USAGE = "usage: build.ts image [--arch arm64|x64] [--tag NAME:TAG] | bootstrap [--arch arm64|x64] [--out FILE.tgz] | stage --out DIR [--arch arm64|x64]"

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv
  if (command !== "image" && command !== "bootstrap" && command !== "stage") throw new Error(USAGE)
  let arch: LinuxArch = linuxArch(process.arch)
  let tag: string | undefined
  let out: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    const allowed = flag === "--arch" || (flag === "--tag" && command === "image") || (flag === "--out" && command !== "image")
    if (!allowed) throw new Error(`unknown option ${flag}\n${USAGE}`)
    const value = rest[++i]
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`)
    if (flag === "--arch") arch = linuxArch(value)
    else if (flag === "--tag") tag = value
    else out = value
  }
  if (command === "stage" && !out) throw new Error(`stage needs --out DIR\n${USAGE}`)
  return { command, arch, ...(tag ? { tag } : {}), ...(out ? { out } : {}) }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const log = (line: string) => console.error(`[build] ${line}`)
    if (args.command === "image") console.log((await buildImage({ arch: args.arch, log, ...(args.tag ? { tag: args.tag } : {}) })).tag)
    else if (args.command === "bootstrap") console.log((await buildBootstrap({ arch: args.arch, log, ...(args.out ? { out: args.out } : {}) })).out)
    else console.log((await stage({ arch: args.arch, log, dir: path.resolve(args.out!) })).dir)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
