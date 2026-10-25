// The fake openshell's own behaviour that later tests (the runtime, the node) rely on: asynchronous delete, failures
// per sandbox and repeated, the working-directory rule of download, exec only in a Ready sandbox, and the call log.
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFakeOpenShell, type FakeOpenShell, type FakeOpenShellOptions } from "./fake-openshell.ts"

const fakes: FakeOpenShell[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup()
})

function fake(options: FakeOpenShellOptions = {}) {
  const f = createFakeOpenShell(options)
  fakes.push(f)
  const run = (...args: string[]) => spawnSync(f.binary, ["--workspace", "hub", ...args], { encoding: "utf8", input: "" })
  return { f, run }
}

describe("fake openshell", () => {
  test("delete can be asynchronous: Deleting for some gets, then not found", () => {
    const { f, run } = fake({ deleteAfterGets: 1 })
    expect(run("sandbox", "create", "--name", "hub-a", "-o", "json").status).toBe(0)
    expect(run("sandbox", "delete", "hub-a").stdout).toContain("deletion accepted")
    expect(JSON.parse(run("sandbox", "get", "hub-a", "-o", "json").stdout).phase).toBe("Deleting")
    const gone = run("sandbox", "get", "hub-a", "-o", "json")
    expect(gone.status).toBe(1)
    expect(gone.stderr).toContain("NotFound")
    expect(f.sandbox("hub-a")).toBeUndefined()
  })

  test("failures can target one sandbox and repeat (times 0 = always)", () => {
    const { f, run } = fake({ failures: [{ command: "sandbox get", name: "hub-b", times: 0, stderr: "nope\n", exitCode: 9 }] })
    run("sandbox", "create", "--name", "hub-a")
    run("sandbox", "create", "--name", "hub-b")
    expect(run("sandbox", "get", "hub-a").status).toBe(0)
    for (let i = 0; i < 2; i++) expect(run("sandbox", "get", "hub-b")).toMatchObject({ status: 9, stderr: "nope\n" })
    f.fail({ command: "sandbox stop", times: 2 })
    expect(run("sandbox", "stop", "hub-a").status).toBe(1)
    expect(run("sandbox", "stop", "hub-a").status).toBe(1)
    expect(run("sandbox", "stop", "hub-a").status).toBe(0)
  })

  test("download only from inside the working directory", () => {
    const { run } = fake()
    run("sandbox", "create", "--name", "hub-a")
    const dest = mkdtempSync(path.join(tmpdir(), "hub-fake-dl-"))
    expect(run("sandbox", "download", "hub-a", "/etc/passwd", dest).status).toBe(1)
  })

  test("exec only in a Ready sandbox; the call log records argv and stdin size", () => {
    const { f, run } = fake({ readyAfterGets: 5 })
    run("sandbox", "create", "--name", "hub-a")
    const early = run("sandbox", "exec", "-n", "hub-a", "--", "true")
    expect(early.status).toBe(1)
    expect(early.stderr).toContain("FailedPrecondition")
    f.update((s) => {
      s.sandboxes["hub/hub-a"]!.phase = "Ready"
    })
    const out = execFileSync(f.binary, ["--workspace", "hub", "sandbox", "exec", "-n", "hub-a", "--", "sh", "-c", 'pwd; test -n "$SANDBOX_ROOT"'], { encoding: "utf8", input: "abc" })
    expect(out.trim()).toEndWith(path.join("hub-a", "sandbox"))
    expect(f.calls().at(-1)).toMatchObject({ command: "sandbox exec", workspace: "hub", stdinBytes: 3 })
  })
})
