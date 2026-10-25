import { describe, expect, test } from "bun:test"
import { helloProblems } from "../src/hello.ts"

const TOKEN = "hubm_conformance_machine"
const good = {
  t: "hello",
  v: 1,
  processID: "fake_1",
  kind: "service",
  directory: "/w",
  pid: 1,
  mode: "always",
  opencodeVersion: "",
  pluginVersion: "0.1.0",
  features: ["permission", "stop", "deliver", "sessionTokens", "actTokens"],
  harness: "fake",
  harnessVersion: "1.0.0",
  evidence: "hooks",
}
const info = { protocol: 1, harness: "fake", harnessVersion: "1.0.0", evidence: "hooks", features: ["permission", "stop", "deliver", "sessionTokens", "actTokens"], models: ["chat" as const] }
const run = (hello: Record<string, unknown>, extra: { auth?: string | null; describe?: typeof info } = {}) =>
  helloProblems({ raw: JSON.stringify(hello), auth: "auth" in extra ? extra.auth! : `Bearer ${TOKEN}`, machineToken: TOKEN, ...(extra.describe ? { describe: extra.describe } : {}) })

describe("hello shape", () => {
  test("a well-formed harness hello that matches the driver passes", () => {
    expect(run(good, { describe: info }).problems).toEqual([])
  })

  test("the first frame must be a hello the hub parses", () => {
    expect(helloProblems({ raw: "nope", auth: `Bearer ${TOKEN}`, machineToken: TOKEN }).problems[0]).toMatch(/not JSON|not a hello/)
    expect(run({ ...good, t: "sessions" }).problems[0]).toMatch(/not a hello/)
    expect(run({ ...good, kind: "daemon" }).problems.join()).toMatch(/does not parse/)
  })

  test("harness must be a lowercase token", () => {
    expect(run({ ...good, harness: "Fake Harness" }).problems.join()).toMatch(/harness/)
  })

  test("a non-OpenCode hello needs a known evidence level", () => {
    expect(run({ ...good, evidence: "guess" }).problems.join()).toMatch(/evidence "guess"/)
    const { evidence: _, ...without } = good
    expect(run(without).problems.join()).toMatch(/evidence/)
  })

  test("features must be known, without duplicates", () => {
    expect(run({ ...good, features: ["permission", "teleport"] }).problems.join()).toMatch(/unknown feature "teleport"/)
    expect(run({ ...good, features: ["permission", "permission"] }).problems.join()).toMatch(/twice/)
  })

  test("opencodeVersion rules: required for OpenCode, optional text for other harnesses", () => {
    const { opencodeVersion: _, ...noVersion } = good
    expect(run(noVersion).problems).toEqual([])
    expect(run(noVersion).notes.join()).toMatch(/opencodeVersion/)
    expect(run({ ...good, opencodeVersion: 3 }).problems.join()).toMatch(/opencodeVersion/)
    const { harness: _h, evidence: _e, harnessVersion: _v, ...legacy } = good
    expect(run({ ...legacy, opencodeVersion: "" }).problems.join()).toMatch(/opencodeVersion/)
    expect(run({ ...legacy, opencodeVersion: "1.2.3" }).problems).toEqual([])
    expect(run({ ...good, harness: "opencode", opencodeVersion: "" }).problems.join()).toMatch(/opencodeVersion/)
  })

  test("connects with the machine token as its bearer", () => {
    expect(run(good, { auth: null }).problems.join()).toMatch(/bearer/i)
    expect(run(good, { auth: "Bearer other" }).problems.join()).toMatch(/bearer/i)
  })

  test("matches what the driver describes", () => {
    expect(run(good, { describe: { ...info, harness: "other" } }).problems.join()).toMatch(/harness "fake".*"other"/)
    expect(run(good, { describe: { ...info, evidence: "rpc" } }).problems.join()).toMatch(/evidence/)
    expect(run(good, { describe: { ...info, features: ["permission"] } }).problems.join()).toMatch(/features/)
  })

  test("problems never quote the token", () => {
    expect(run(good, { auth: `Bearer ${TOKEN}x` }).problems.join()).not.toContain(TOKEN)
  })
})
