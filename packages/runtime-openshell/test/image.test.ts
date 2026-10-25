// The hub sandbox image (packages/runtime-openshell/image): naming, layout and the generated build and bootstrap
// commands. Building the image itself is the opt-in docker test (image-docker.it.test.ts).
import { describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  BOOTSTRAP_ROOT,
  IMAGE_ROOT,
  OPENCODE_VERSION,
  bootstrapCommands,
  bootstrapTarballName,
  dockerBuildArgs,
  dockerPlatform,
  harnessBinary,
  imageTag,
  linuxArch,
  opencodePackage,
  opencodeTarballURL,
  pluginDir,
  startCommand,
} from "../image/image.ts"

const root = path.join(import.meta.dir, "..", "..", "..")

describe("sandbox image naming", () => {
  test("the pinned OpenCode is the version the repository is tested with", () => {
    expect(OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(OPENCODE_VERSION).toBe("2.1.4")
  })

  test("maps host architectures to the Linux builds OpenCode publishes", () => {
    expect(linuxArch("arm64")).toBe("arm64")
    expect(linuxArch("aarch64")).toBe("arm64")
    expect(linuxArch("x64")).toBe("x64")
    expect(linuxArch("amd64")).toBe("x64")
    expect(linuxArch("x86_64")).toBe("x64")
    expect(() => linuxArch("ia32")).toThrow(/ia32/)
    expect(dockerPlatform("arm64")).toBe("linux/arm64")
    expect(dockerPlatform("x64")).toBe("linux/amd64")
  })

  test("names the npm package and tarball of the Linux OpenCode build", () => {
    expect(opencodePackage("arm64")).toBe(`@opencode/cli-linux-arm64@${OPENCODE_VERSION}`)
    expect(opencodePackage("x64", "2.0.0")).toBe("@opencode/cli-linux-x64@2.0.0")
    expect(opencodeTarballURL("arm64", "2.1.4")).toBe("https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.1.4.tgz")
    expect(() => opencodePackage("arm64", "latest")).toThrow(/version/)
  })

  test("tags the image with the hub and OpenCode versions", () => {
    expect(imageTag("0.6.1")).toBe(`hub-sandbox:0.6.1-opencode${OPENCODE_VERSION}`)
    expect(imageTag("0.6.1", "2.0.0", "ghcr.io/huynle/hub-sandbox")).toBe("ghcr.io/huynle/hub-sandbox:0.6.1-opencode2.0.0")
    expect(bootstrapTarballName("0.6.1", "arm64")).toBe(`hub-sandbox-bootstrap-0.6.1-opencode${OPENCODE_VERSION}-linux-arm64.tgz`)
  })
})

describe("sandbox layout", () => {
  test("the image installs under /usr/local; the bootstrap fallback under /sandbox/.hub/opt", () => {
    expect(IMAGE_ROOT).toBe("/usr/local")
    expect(BOOTSTRAP_ROOT).toBe("/sandbox/.hub/opt")
  })

  test("the harness binary is the one the sandbox policy lets out", async () => {
    const { HARNESS_BINARY } = await import("../src/policy.ts")
    expect(harnessBinary()).toBe(HARNESS_BINARY)
    expect(harnessBinary(BOOTSTRAP_ROOT)).toBe("/sandbox/.hub/opt/bin/opencode")
  })

  test("the plugin is the installed @huynle/hub package", () => {
    expect(pluginDir()).toBe("/usr/local/lib/hub/node_modules/@huynle/hub")
    expect(pluginDir(BOOTSTRAP_ROOT)).toBe("/sandbox/.hub/opt/lib/hub/node_modules/@huynle/hub")
  })

  test("the runtime starts the harness with the start script, as argv", () => {
    expect(startCommand()).toEqual(["/usr/local/bin/hub-sandbox-start"])
    expect(startCommand(BOOTSTRAP_ROOT)).toEqual(["/sandbox/.hub/opt/bin/hub-sandbox-start"])
  })
})

describe("image sources", () => {
  test("are type-checked with the repository", () => {
    const include: string[] = JSON.parse(readFileSync(path.join(root, "tsconfig.json"), "utf8")).include
    expect(include).toContain("packages/runtime-openshell/image")
  })
})

describe("scripts", () => {
  test("the start and entry scripts are executable bash scripts", () => {
    for (const f of ["start.sh", "entry.sh"]) {
      const file = path.join(root, "packages/runtime-openshell/image", f)
      expect(readFileSync(file, "utf8")).toStartWith("#!/usr/bin/env bash\n")
      expect(statSync(file).mode & 0o111).toBe(0o111)
      expect(Bun.spawnSync(["bash", "-n", file]).exitCode).toBe(0)
    }
  })
})

describe("generated commands", () => {
  test("docker build for one platform, with the versions as build args", () => {
    expect(dockerBuildArgs({ tag: "hub-sandbox:x", arch: "arm64", context: "/tmp/ctx", hubVersion: "0.6.1" })).toEqual([
      "build",
      "--platform",
      "linux/arm64",
      "--tag",
      "hub-sandbox:x",
      "--build-arg",
      "HUB_VERSION=0.6.1",
      "--build-arg",
      `OPENCODE_VERSION=${OPENCODE_VERSION}`,
      "/tmp/ctx",
    ])
  })

  test("the bootstrap fallback unpacks the uploaded tarball into its root and removes it", () => {
    expect(bootstrapCommands("/sandbox/.hub/b.tgz")).toEqual([
      ["mkdir", "-p", "/sandbox/.hub/opt"],
      ["tar", "-xzf", "/sandbox/.hub/b.tgz", "-C", "/sandbox/.hub/opt"],
      ["rm", "-f", "/sandbox/.hub/b.tgz"],
    ])
    expect(() => bootstrapCommands("/tmp/b.tgz")).toThrow(/\/sandbox/)
    expect(() => bootstrapCommands("/sandbox/../etc/b.tgz")).toThrow(/\/sandbox/)
  })
})

describe("Dockerfile", () => {
  const dockerfile = readFileSync(path.join(root, "packages/runtime-openshell/image/Dockerfile"), "utf8")

  test("Debian bookworm slim with git, bash, CA certificates, curl and procps", () => {
    expect(dockerfile).toMatch(/^FROM debian:bookworm-slim$/m)
    const install = dockerfile.match(/apt-get install[^\n]*(?:\\\n[^\n]*)*/)?.[0] ?? ""
    for (const pkg of ["git", "bash", "ca-certificates", "curl", "procps"]) expect(install).toContain(` ${pkg}`)
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*")
  })

  test("copies the staged harness, scripts and plugin under /usr/local", () => {
    expect(dockerfile).toMatch(/^COPY bin\/ \/usr\/local\/bin\/$/m)
    expect(dockerfile).toMatch(/^COPY lib\/hub\/ \/usr\/local\/lib\/hub\/$/m)
  })

  test("sets the offline OpenCode switches and does not run the harness as the main command", () => {
    for (const v of ["OPENCODE_DISABLE_MODELS_FETCH=1", "OPENCODE_DISABLE_AUTOUPDATE=1", "OPENCODE_DISABLE_PROJECT_CONFIG=1"]) expect(dockerfile).toContain(v)
    // A main command that exits moves the sandbox to Completed (exec refused): the runtime starts the harness by exec.
    expect(dockerfile).not.toMatch(/^(CMD|ENTRYPOINT) .*hub-sandbox/m)
    // OpenShell injects the proxy CA through these; the image must not pin them.
    expect(dockerfile).not.toMatch(/NODE_EXTRA_CA_CERTS|SSL_CERT_FILE/)
  })
})
