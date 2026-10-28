// The hubctl jobs of .github/workflows/release.yml: additive to the server release, published only after its gates,
// with the signing key readable by one step of one job that installs no npm dependencies.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const text = readFileSync(path.join(import.meta.dir, "..", "..", "..", ".github/workflows/release.yml"), "utf8")
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
type Job = { needs?: string | string[]; if?: string; steps: Step[]; environment?: string; permissions?: Record<string, string>; strategy?: { matrix: { target: string[] } } }
const workflow = Bun.YAML.parse(text) as { jobs: Record<string, Job>; on: unknown }
const jobs = workflow.jobs
const needs = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [])
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n")

describe("release workflow: hubctl", () => {
  test("parses, still runs on version tags only, and keeps the server jobs", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } })
    for (const name of ["test", "binaries", "release", "image", "npm"]) expect(jobs[name]).toBeDefined()
    expect(jobs.binaries!.strategy!.matrix.target).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"])
    expect(runs(jobs.binaries!)).toContain("scripts/build-binaries.sh")
  })

  test("hubctl builds after the tests, behind the HUBCTL_RELEASE switch, with a required trust root", () => {
    const job = jobs.hubctl!
    expect(needs(job)).toEqual(["test"])
    expect(job.if).toBe("vars.HUBCTL_RELEASE == 'true'")
    expect(runs(job)).toContain("scripts/build-hubctl.sh --require-trust-root")
    expect(runs(job)).toContain("PATH=/nonexistent")
    expect(runs(job)).toContain("./hubctl --version")
    expect(runs(job)).toContain("cmp hubctl-help.txt hub-help.txt")
  })

  test("only the Sign step of hubctl-sign sees the signing key, and that job installs nothing from npm", () => {
    expect(text.match(/secrets\.HUB_RELEASE_SIGNING_KEY/g)?.length).toBe(1)
    const job = jobs["hubctl-sign"]!
    expect(job.environment).toBe("hubctl-release")
    expect(needs(job)).toEqual(["hubctl"])
    const withKey = job.steps.filter((s) => JSON.stringify(s).includes("HUB_RELEASE_SIGNING_KEY"))
    expect(withKey.map((s) => s.name)).toEqual(["Sign"])
    expect(runs(job)).not.toMatch(/\bnpm\b|\bnpx\b|bun (install|add)/)
    for (const step of job.steps.filter((s) => s.uses?.startsWith("actions/checkout"))) expect(step.with?.["persist-credentials"]).toBe(false)
    expect(runs(job)).toContain("hubctl-release.ts manifest")
    expect(runs(job)).toContain("hubctl-release.ts verify --manifest dist/hubctl-manifest.json --dist dist")
  })

  test("publishing waits for the existing release job and the verified signature", () => {
    const job = jobs["hubctl-publish"]!
    expect(needs(job).sort()).toEqual(["hubctl-sign", "release"])
    expect(needs(jobs.release!)).toEqual(["binaries"])
    expect(needs(jobs.binaries!)).toEqual(["test"])
    expect(job.permissions).toEqual({ contents: "write" })
    expect(JSON.stringify(job.steps)).not.toContain("secrets.")
  })

  test("publish re-verifies exactly the files it uploads, right before uploading them", () => {
    const job = jobs["hubctl-publish"]!
    const verify = job.steps.findIndex((s) => s.run?.includes("hubctl-release.ts verify --manifest dist/hubctl-manifest.json --dist dist"))
    const upload = job.steps.findIndex((s) => s.uses?.startsWith("softprops/action-gh-release"))
    expect(verify).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(verify)
    expect(runs(job)).not.toMatch(/\bnpm\b|\bnpx\b|bun (install|add)/)
  })

  test("no job but publish can write, and no hubctl job pushes or publishes elsewhere", () => {
    for (const name of ["hubctl", "hubctl-sign"]) {
      expect(jobs[name]!.permissions).toBeUndefined()
      expect(runs(jobs[name]!)).not.toMatch(/git push|npm publish|gh release/)
    }
  })
})
