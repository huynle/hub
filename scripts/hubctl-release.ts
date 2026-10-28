#!/usr/bin/env bun
// The hubctl release tool: build | manifest | sign | verify | trust-root. See
// packages/cli/src/bootstrap/release/cli.ts for the commands and packages/cli/src/bootstrap/release/README.md for
// the release process. Runs from the repository root; needs only bun (no npm dependencies for manifest, sign,
// verify and trust-root, so the signing job installs nothing).
import path from "node:path"
import { runRelease } from "../packages/cli/src/bootstrap/release/cli.ts"
import { httpDigest } from "../packages/cli/src/bootstrap/release/pins.ts"

const root = path.join(import.meta.dir, "..")

process.exitCode = await runRelease(process.argv.slice(2), {
  env: process.env,
  cwd: root,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  run: async (argv) => {
    const proc = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit" })
    return await proc.exited
  },
  download: (url) => httpDigest(url),
  now: () => Date.now(),
})
