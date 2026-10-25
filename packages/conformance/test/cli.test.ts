import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { formatTable, parseArgs, splitCommand, type ConformanceReport } from "../src/index.ts"
import { referenceDriver } from "./helpers.ts"

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts")

const report: ConformanceReport = {
  suite: "spoke",
  ok: false,
  driver: ["bun", "driver.ts"],
  harness: "fake",
  harnessVersion: "1.0.0",
  evidence: "hooks",
  features: ["permission"],
  startedAt: "2026-10-25T00:00:00.000Z",
  durationMs: 1234,
  checks: [
    { id: "hello", title: "Hello shape", status: "pass", problems: [], notes: [] },
    { id: "deliver.modes", title: "Deliver result modes", status: "fail", problems: ["first problem", "second problem"], notes: [] },
    { id: "permission", title: "Permission replies", status: "skip", problems: [], notes: [], reason: "permission not announced" },
  ],
}

describe("report table", () => {
  test("one row per check: status, then problems, the skip reason or notes; a summary line", () => {
    const table = formatTable(report)
    const lines = table.split("\n")
    expect(lines[0]).toBe("hub-conformance spoke: fake 1.0.0 (evidence hooks), 1.2 s")
    expect(lines.find((l) => l.startsWith("hello"))).toMatch(/^hello\s+pass\s*$/)
    expect(lines.find((l) => l.startsWith("deliver.modes"))).toMatch(/^deliver\.modes\s+FAIL\s+first problem$/)
    expect(table).toMatch(/\n\s+second problem\n/)
    expect(lines.find((l) => l.startsWith("permission"))).toMatch(/^permission\s+skip\s+permission not announced$/)
    expect(lines.at(-1)).toBe("FAIL: 1 passed, 1 failed, 1 skipped")
  })
})

describe("command line", () => {
  test("splitCommand splits on whitespace and honours quotes and backslashes, without any shell expansion", () => {
    expect(splitCommand(`bun "my driver.ts" --fault='a b' x\\ y $HOME`)).toEqual(["bun", "my driver.ts", "--fault=a b", "x y", "$HOME"])
  })

  test("parseArgs takes the driver from --driver or after --, and the output options", () => {
    expect(parseArgs(["spoke", "--driver", "bun d.ts --x"])).toEqual({ suite: "spoke", driver: ["bun", "d.ts", "--x"], json: false })
    expect(parseArgs(["spoke", "--json", "--out", "r.json", "--retry-after-ms", "200", "--", "bun", "d.ts"])).toEqual({ suite: "spoke", driver: ["bun", "d.ts"], json: true, out: "r.json", retryAfterMs: 200 })
    expect(parseArgs(["spoke"])).toMatchObject({ error: expect.stringMatching(/driver/) })
    expect(parseArgs(["runtime", "--driver", "x"])).toMatchObject({ error: expect.stringMatching(/suite/) })
    expect(parseArgs(["spoke", "--driver", "x", "--retry-after-ms", "soon"])).toMatchObject({ error: expect.stringMatching(/retry-after-ms/) })
  })

  test(
    "hub-conformance spoke exits 0 with a table for the reference driver, 1 with JSON for a broken one",
    async () => {
      const ok = Bun.spawn([process.execPath, CLI, "spoke", "--retry-after-ms", "200", "--driver", referenceDriver().join(" ")], { stdout: "pipe", stderr: "pipe" })
      const [okOut, okCode] = await Promise.all([new Response(ok.stdout).text(), ok.exited])
      expect(okOut).toMatch(/PASS: 9 passed, 0 failed, 0 skipped/)
      expect(okCode).toBe(0)

      const out = path.join(mkdtempSync(path.join(tmpdir(), "conformance-cli-")), "report.json")
      const bad = Bun.spawn([process.execPath, CLI, "spoke", "--json", "--out", out, "--retry-after-ms", "200", "--", ...referenceDriver("tokens")], { stdout: "pipe", stderr: "pipe" })
      const [badOut, badCode] = await Promise.all([new Response(bad.stdout).text(), bad.exited])
      const parsed = JSON.parse(badOut) as ConformanceReport
      expect(parsed.ok).toBe(false)
      expect(parsed.checks.find((c) => c.id === "tokens")?.status).toBe("fail")
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(parsed)
      expect(badCode).toBe(1)
    },
    90_000,
  )

  test("a usage error exits 2", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "spoke"], { stdout: "pipe", stderr: "pipe" })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(err).toMatch(/usage: hub-conformance spoke/)
    expect(code).toBe(2)
  })
})
