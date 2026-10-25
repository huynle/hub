// The image installs with the lockfile, which lists every workspace: each workspace's package.json must be copied
// into every stage that installs dependencies, or `npm ci` / `bun install --frozen-lockfile` fails in the build.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const workspaces: string[] = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).workspaces ?? []
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
/** Stages (FROM … to the next FROM) that run an install. */
const installStages = dockerfile.split(/^FROM /m).slice(1).filter((stage) => /\b(npm ci|bun install)\b/.test(stage))

describe("Dockerfile and workspaces", () => {
  test("there are install stages and workspaces to check", () => {
    expect(installStages.length).toBeGreaterThan(0)
    expect(workspaces.length).toBeGreaterThan(0)
  })
  for (const ws of workspaces) {
    test(`every install stage copies ${ws}/package.json before installing`, () => {
      for (const stage of installStages) {
        const install = stage.search(/\b(npm ci|bun install)\b/)
        const copy = stage.indexOf(`COPY ${ws}/package.json`)
        expect(copy).toBeGreaterThanOrEqual(0)
        expect(copy).toBeLessThan(install)
      }
    })
  }

  // The runtime stage (the last) runs the hub from its sources: every package the server imports by relative
  // path must be there, or the image fails at start.
  for (const pkg of ["protocol", "sdk"]) {
    test(`the runtime stage copies packages/${pkg}/src`, () => {
      const runtime = dockerfile.split(/^FROM /m).at(-1) ?? ""
      expect(runtime).toContain(`COPY packages/${pkg}/src ./packages/${pkg}/src`)
      expect(runtime).toContain(`COPY packages/${pkg}/package.json ./packages/${pkg}/`)
    })
  }
})
