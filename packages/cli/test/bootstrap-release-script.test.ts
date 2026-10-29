// scripts/build-hubctl.sh: the wrapper the release workflow runs. It builds through the release tool, then writes
// HUBCTL_SHA256SUMS next to the binaries, in the directory --outdir chose (the repository's dist/ by default). The
// compiler is replaced by a fake `--bun` that writes a small file per --outfile, so this runs in milliseconds; see
// bootstrap-release-build.test.ts for a real compile.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.join(import.meta.dir, "..", "..", "..")
const repoSums = path.join(repo, "dist", "HUBCTL_SHA256SUMS")

/** A stand-in for `bun build --compile`: writes "<target> binary" to the --outfile. */
function fakeBun(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "hubctl-fake-bun-")), "bun")
  writeFileSync(
    file,
    `#!/bin/sh
out=""; target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outfile) out="$2"; shift ;;
    --target=*) target="\${1#--target=}" ;;
  esac
  shift
done
printf '%s binary\\n' "$target" > "$out"
`,
  )
  chmodSync(file, 0o755)
  return file
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
const repoSumsStamp = () => (existsSync(repoSums) ? `${statSync(repoSums).mtimeMs}:${readFileSync(repoSums, "utf8")}` : "absent")

function run(args: string[]) {
  const r = Bun.spawnSync(["bash", "scripts/build-hubctl.sh", ...args, "--bun", fakeBun(), "--trust-root", "/nonexistent/root.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

describe("scripts/build-hubctl.sh", () => {
  test("--outdir elsewhere: the binaries and HUBCTL_SHA256SUMS land there, the repository's dist/ is untouched", () => {
    const outdir = mkdtempSync(path.join(tmpdir(), "hubctl-outdir-"))
    const before = repoSumsStamp()
    const r = run(["linux-x64", "darwin-arm64", "--outdir", outdir])
    expect(r.stderr).not.toContain("No such file")
    expect(r.code).toBe(0)
    const sums = readFileSync(path.join(outdir, "HUBCTL_SHA256SUMS"), "utf8")
    expect(sums.trim().split("\n").sort()).toEqual(
      ["darwin-arm64", "linux-x64"].map((t) => `${sha256(path.join(outdir, `hubctl-${t}`))}  hubctl-${t}`).sort(),
    )
    expect(repoSumsStamp()).toBe(before)
  })

  test("a relative --outdir resolves against the repository root, as the release tool does", () => {
    const outdir = mkdtempSync(path.join(tmpdir(), "hubctl-outdir-rel-"))
    const r = run(["linux-x64", "--outdir", path.relative(repo, outdir)])
    expect(r.code).toBe(0)
    expect(readFileSync(path.join(outdir, "HUBCTL_SHA256SUMS"), "utf8")).toBe(`${sha256(path.join(outdir, "hubctl-linux-x64"))}  hubctl-linux-x64\n`)
  })

  test("a failed build writes no checksum file", () => {
    const outdir = mkdtempSync(path.join(tmpdir(), "hubctl-outdir-fail-"))
    const r = Bun.spawnSync(["bash", "scripts/build-hubctl.sh", "linux-x64", "--outdir", outdir, "--bun", "/bin/false", "--trust-root", "/nonexistent/root.json"], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(path.join(outdir, "HUBCTL_SHA256SUMS"))).toBe(false)
  })
})
