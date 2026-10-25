// image/build.ts: stages the sandbox image's build context (pinned Linux OpenCode from npm, the hub plugin packed
// from this repository, the start/entry scripts), builds the image with docker, or packs the same layout as the
// bootstrap tarball for the upload fallback. The registry and npm are faked here; the opt-in docker test builds for real.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildBootstrap, buildImage, parseArgs, stage, verifyIntegrity, type Run } from "../image/build.ts"
import { OPENCODE_VERSION, imageTag, opencodeMetadataURL, opencodeTarballURL } from "../image/image.ts"

const IMAGE = path.join(import.meta.dir, "..", "image")
const ROOT = path.join(import.meta.dir, "..", "..", "..")
const HUB_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-image-build-")))
  dirs.push(d)
  return d
}

const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** A registry tarball like @opencode/cli-linux-<arch>: package/package.json and package/bin/opencode. */
function opencodeTarball(): Uint8Array {
  const d = temp()
  mkdirSync(path.join(d, "package/bin"), { recursive: true })
  writeFileSync(path.join(d, "package/package.json"), "{}")
  writeFileSync(path.join(d, "package/bin/opencode"), "#!/bin/sh\necho fake-linux-opencode\n")
  const out = path.join(d, "oc.tgz")
  expect(Bun.spawnSync(["tar", "-czf", out, "-C", d, "package"]).exitCode).toBe(0)
  return new Uint8Array(readFileSync(out))
}

interface Fakes {
  readonly fetch: typeof fetch
  readonly run: Run
  readonly calls: string[][]
  readonly fetched: string[]
}

function fakes(opts: { integrity?: string; tarballURL?: string } = {}): Fakes {
  const tarball = opencodeTarball()
  const calls: string[][] = []
  const fetched: string[] = []
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    fetched.push(url)
    if (url === opencodeMetadataURL("arm64")) return Response.json({ dist: { tarball: opts.tarballURL ?? opencodeTarballURL("arm64"), integrity: opts.integrity ?? sri(tarball) } })
    if (url === opencodeTarballURL("arm64")) return new Response(new Blob([tarball as Uint8Array<ArrayBuffer>]))
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  const run: Run = async (cmd, cwd) => {
    calls.push([...cmd])
    if (cmd[0] === "npm" && cmd[1] === "pack") {
      const dest = cmd[cmd.indexOf("--pack-destination") + 1]!
      writeFileSync(path.join(dest, `huynle-hub-${HUB_VERSION}.tgz`), "fake package")
      return JSON.stringify([{ filename: `huynle-hub-${HUB_VERSION}.tgz` }])
    }
    if (cmd[0] === "npm" && cmd[1] === "install") {
      const prefix = cmd[cmd.indexOf("--prefix") + 1]!
      mkdirSync(path.join(prefix, "node_modules/@huynle/hub"), { recursive: true })
      writeFileSync(path.join(prefix, "node_modules/@huynle/hub/server.ts"), "export {}")
      return ""
    }
    if (cmd[0] === "docker") return ""
    const p = Bun.spawnSync([...cmd], { cwd })
    if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`)
    return p.stdout.toString()
  }
  return { fetch: fakeFetch, run, calls, fetched }
}

describe("verifyIntegrity", () => {
  test("accepts the matching sha512 and refuses anything else", () => {
    const bytes = new TextEncoder().encode("hello")
    expect(() => verifyIntegrity(bytes, sri(bytes))).not.toThrow()
    expect(() => verifyIntegrity(bytes, sri(new TextEncoder().encode("other")))).toThrow(/integrity/)
    expect(() => verifyIntegrity(bytes, "sha1-abc")).toThrow(/sha512/)
  })
})

describe("stage", () => {
  test("lays out the build context: harness, scripts, plugin and Dockerfile", async () => {
    const dir = path.join(temp(), "ctx")
    const f = fakes()
    const staged = await stage({ dir, arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })
    expect(staged.hubVersion).toBe(HUB_VERSION)
    expect(readFileSync(path.join(dir, "bin/opencode"), "utf8")).toContain("fake-linux-opencode")
    for (const [name, src] of [["hub-sandbox-entry", "entry.sh"], ["hub-sandbox-start", "start.sh"], ["opencode", null]] as const) {
      const file = path.join(dir, "bin", name)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      if (src) expect(readFileSync(file, "utf8")).toBe(readFileSync(path.join(IMAGE, src), "utf8"))
    }
    expect(existsSync(path.join(dir, "lib/hub/node_modules/@huynle/hub/server.ts"))).toBe(true)
    expect(readFileSync(path.join(dir, "Dockerfile"), "utf8")).toBe(readFileSync(path.join(IMAGE, "Dockerfile"), "utf8"))
    expect(f.fetched).toEqual([opencodeMetadataURL("arm64"), opencodeTarballURL("arm64")])
  })

  test("packs this repository without its build scripts and installs it with production dependencies only", async () => {
    const dir = path.join(temp(), "ctx")
    const f = fakes()
    await stage({ dir, arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })
    const pack = f.calls.find((c) => c[0] === "npm" && c[1] === "pack")!
    expect(pack).toContain("--ignore-scripts")
    expect(pack).toContain("--json")
    const install = f.calls.find((c) => c[0] === "npm" && c[1] === "install")!
    expect(install.slice(0, 4)).toEqual(["npm", "install", "--prefix", path.join(dir, "lib/hub")])
    for (const flag of ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]) expect(install).toContain(flag)
    expect(install.at(-1)).toEndWith(`huynle-hub-${HUB_VERSION}.tgz`)
  })

  test("refuses an OpenCode tarball whose integrity does not match the registry's", async () => {
    const f = fakes({ integrity: sri(new TextEncoder().encode("tampered")) })
    await expect(stage({ dir: path.join(temp(), "ctx"), arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })).rejects.toThrow(/integrity/)
  })

  test("refuses a tarball outside the npm registry", async () => {
    const f = fakes({ tarballURL: "https://evil.example/cli.tgz" })
    await expect(stage({ dir: path.join(temp(), "ctx"), arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })).rejects.toThrow(/registry/)
    expect(f.fetched).not.toContain("https://evil.example/cli.tgz")
  })

  test("refuses a context directory that already has content", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "x"), "")
    const f = fakes()
    await expect(stage({ dir, arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })).rejects.toThrow(/not empty/)
  })
})

describe("buildImage", () => {
  test("stages a temporary context, runs docker build for the platform and removes the context", async () => {
    const f = fakes()
    const built = await buildImage({ arch: "arm64", repoRoot: ROOT, fetch: f.fetch, run: f.run })
    expect(built.tag).toBe(imageTag(HUB_VERSION))
    const docker = f.calls.find((c) => c[0] === "docker")!
    expect(docker.slice(0, 6)).toEqual(["docker", "build", "--platform", "linux/arm64", "--tag", imageTag(HUB_VERSION)])
    expect(docker).toContain(`OPENCODE_VERSION=${OPENCODE_VERSION}`)
    expect(existsSync(docker.at(-1)!)).toBe(false)
  })

  test("never pushes", async () => {
    const f = fakes()
    await buildImage({ arch: "arm64", repoRoot: ROOT, tag: "ghcr.io/x/hub-sandbox:t", fetch: f.fetch, run: f.run })
    expect(f.calls.some((c) => c.includes("push") || c.includes("--push"))).toBe(false)
  })
})

describe("buildBootstrap", () => {
  test("packs the staged layout (no Dockerfile) as the upload fallback's tarball", async () => {
    const out = path.join(temp(), "bootstrap.tgz")
    const f = fakes()
    await buildBootstrap({ arch: "arm64", repoRoot: ROOT, out, fetch: f.fetch, run: f.run })
    const list = Bun.spawnSync(["tar", "-tzf", out]).stdout.toString().split("\n").map((l) => l.replace(/^\.\//, "").replace(/\/$/, ""))
    for (const entry of ["bin/opencode", "bin/hub-sandbox-start", "bin/hub-sandbox-entry", "lib/hub/node_modules/@huynle/hub/server.ts"]) expect(list).toContain(entry)
    expect(list).not.toContain("Dockerfile")
  })
})

describe("parseArgs", () => {
  test("image, bootstrap and stage commands with their options", () => {
    expect(parseArgs(["image", "--arch", "x64", "--tag", "hub-sandbox:t"])).toEqual({ command: "image", arch: "x64", tag: "hub-sandbox:t" })
    expect(parseArgs(["bootstrap", "--arch", "aarch64", "--out", "/tmp/b.tgz"])).toEqual({ command: "bootstrap", arch: "arm64", out: "/tmp/b.tgz" })
    expect(parseArgs(["stage", "--out", "/tmp/ctx"])).toMatchObject({ command: "stage", out: "/tmp/ctx" })
    expect(parseArgs(["image"]).arch).toBe(process.arch === "x64" ? "x64" : "arm64")
  })

  test("refuses unknown commands, flags and missing values", () => {
    expect(() => parseArgs([])).toThrow(/usage/)
    expect(() => parseArgs(["push"])).toThrow(/usage/)
    expect(() => parseArgs(["image", "--push"])).toThrow(/--push/)
    expect(() => parseArgs(["image", "--tag"])).toThrow(/--tag/)
    expect(() => parseArgs(["stage"])).toThrow(/--out/)
  })
})
