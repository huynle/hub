// The openshell runtime's start and stop against the fake openshell: start hands the harness inside the sandbox its
// hub config (.hub/config.json with the hub URL it can reach, the launch token and the launch ID; .hub/node.json with
// the sandbox's workspace root; .hub/env.json) and then touches .hub/ready, which the image's entry script waits for;
// stop writes .hub/stop with the mode. The launch token never appears in an openshell argv.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PreparedWorkspace } from "../../protocol/src/index.ts"
import { RuntimeError, type StartInput } from "../../runtime-sdk/src/index.ts"
import { OpenShellCli } from "../src/cli.ts"
import { HUB_CONFIG_FILE, HUB_ENV_FILE, HUB_NODE_FILE, READY_FILE, SANDBOX_WORKDIR, sandboxName, STOP_FILE } from "../src/runtime.ts"
import { base, fake, input, rejection, setup } from "./runtime-helpers.ts"

setDefaultTimeout(60_000)

const TOKEN = "hlt1.c2VjcmV0LXRva2Vu.sig"
const start = (over: Partial<StartInput> = {}): StartInput => ({ launchID: "l1", harness: "opencode", hub: { url: "http://127.0.0.1:4096", token: TOKEN }, ...over })
/** A file under the sandbox's /sandbox in the fake. */
const file = (rel: string, launchID = "l1") => path.join(fake.sandboxRoot(sandboxName(launchID)), "sandbox", rel)
const read = (rel: string) => JSON.parse(readFileSync(file(rel), "utf8"))

describe("start", () => {
  test("uploads the hub config, node roots and env, then touches the ready file", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    const handle = await rt.start(ws, start({ env: { HUB_LABEL: "x" } }))
    expect(handle).toEqual({ launchID: "l1", workspace: ws, started: true })
    // The spoke's launch config (src/config.ts parseLaunchConfig): exactly {hubURL, token, launchID}.
    expect(read(HUB_CONFIG_FILE)).toEqual({ hubURL: "http://host.openshell.internal:4096/", token: TOKEN, launchID: "l1" })
    expect(read(HUB_NODE_FILE)).toEqual({ workspaceRoots: [SANDBOX_WORKDIR] })
    expect(read(HUB_ENV_FILE)).toEqual({ HUB_LABEL: "x" })
    expect(existsSync(file(READY_FILE))).toBe(true)
    expect([HUB_CONFIG_FILE, HUB_NODE_FILE, HUB_ENV_FILE, READY_FILE].every((f) => f.startsWith(".hub/"))).toBe(true)
    // The token travels in a file, never in an argv.
    expect(fake.calls().some((c) => c.argv.join(" ").includes(TOKEN))).toBe(false)
  })

  test("a non-loopback hub URL is kept as is", async () => {
    const rt = setup({}, { hubURL: "https://hub.example.com" })
    const ws = await rt.prepare(input())
    await rt.start(ws, start({ hub: { url: "https://hub.example.com", token: TOKEN } }))
    expect(read(HUB_CONFIG_FILE).hubURL).toBe("https://hub.example.com/")
  })

  test("a repeated start leaves the running harness alone", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    await rt.start(ws, start())
    const again = await rt.start(ws, start({ hub: { url: "http://127.0.0.1:4096", token: "hlt1.other.sig" } }))
    expect(again.started).toBe(false)
    expect(again.reason).toMatch(/already/)
    expect(read(HUB_CONFIG_FILE).token).toBe(TOKEN)
  })

  test("refuses a handle that is not this launch's sandbox, a missing sandbox, and other harnesses", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    const other: PreparedWorkspace = { ...ws, runtime: { kind: "openshell", sandbox: sandboxName("l2"), profile: "default" } }
    expect(await rejection(rt.start(other, start()))).toBeInstanceOf(RuntimeError)
    expect(await rejection(rt.start({ ...ws, runtime: { kind: "host" } }, start()))).toBeInstanceOf(RuntimeError)
    expect(await rejection(rt.start(ws, start({ launchID: "l2" })))).toBeInstanceOf(RuntimeError)
    expect(await rejection(rt.start(ws, start({ harness: "claude" })))).toBeInstanceOf(RuntimeError)
    await new OpenShellCli({ binary: fake.binary, env: base }).delete(sandboxName("l1"))
    expect((await rejection(rt.start(ws, start()))).message).toMatch(/gone/)
    expect(fake.calls().some((c) => c.argv.join(" ").includes(TOKEN))).toBe(false)
  })

  test("an error never carries the launch token", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    fake.fail({ command: "sandbox upload", stderr: `Error:   × upload failed for ${TOKEN}\n`, times: 0 })
    const error = await rejection(rt.start(ws, start()))
    expect(error).toBeInstanceOf(RuntimeError)
    expect(error.message).not.toContain(TOKEN)
  })
})

describe("stop", () => {
  test("graceful and kill write the stop file with the mode", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    const handle = await rt.start(ws, start())
    expect(await rt.stop(handle, "graceful")).toEqual({ stopped: true })
    expect(readFileSync(file(STOP_FILE), "utf8").trim()).toBe("graceful")
    expect(await rt.stop(handle, "kill")).toEqual({ stopped: true })
    expect(readFileSync(file(STOP_FILE), "utf8").trim()).toBe("kill")
    // The sandbox itself keeps running for collect.
    expect(fake.sandbox(sandboxName("l1"))!.phase).toBe("Ready")
  })

  test("nothing to stop: never started, or the sandbox is gone", async () => {
    const rt = setup()
    const ws = await rt.prepare(input())
    const handle = { launchID: "l1", workspace: ws }
    expect(await rt.stop(handle, "graceful")).toEqual({ stopped: false, reason: "the harness was never started" })
    await new OpenShellCli({ binary: fake.binary, env: base }).delete(sandboxName("l1"))
    expect(await rt.stop(handle, "graceful")).toEqual({ stopped: false, reason: "the sandbox is gone" })
  })
})
