import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { connectDriver, DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, spawnDriver, type DriverClient, type DriverHandlers } from "../src/index.ts"

const info = { protocol: DRIVER_PROTOCOL_VERSION, harness: "fake", harnessVersion: "1.0", evidence: "hooks", features: ["turn", "permission"], models: ["anthropic" as const] }

/** A driver served in-process over two PassThrough pipes, and a client connected to it. */
function pair(handlers: DriverHandlers) {
  const toDriver = new PassThrough()
  const fromDriver = new PassThrough()
  const served = serveDriver(handlers, { input: toDriver, output: fromDriver })
  const client = connectDriver({ input: fromDriver, output: toDriver })
  return { served, client, toDriver, fromDriver }
}

const clients: DriverClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
})

describe("harness driver protocol (in-process)", () => {
  test("typed calls reach the handlers and return their results", async () => {
    const calls: Array<[string, unknown]> = []
    const { client } = pair({
      describe: async () => info,
      start: async (p) => (calls.push(["start", p]), {}),
      createSession: async (p) => (calls.push(["createSession", p]), { sessionID: "ses_cc1" }),
      prompt: async (p) => (calls.push(["prompt", p]), {}),
      local: async (p) => (calls.push(["local", p]), {}),
      stop: async () => (calls.push(["stop", undefined]), {}),
    })
    clients.push(client)
    expect(await client.describe()).toEqual(info)
    const start = { hubURL: "http://127.0.0.1:1", token: "tok", directory: "/w", env: { HTTPS_PROXY: "http://127.0.0.1:2" }, model: { format: "anthropic" as const, baseURL: "http://127.0.0.1:3" } }
    expect(await client.start(start)).toEqual({})
    expect(await client.createSession({ directory: "/w", prompt: "hi" })).toEqual({ sessionID: "ses_cc1" })
    expect(await client.prompt({ sessionID: "ses_cc1", text: "BASH:ls" })).toEqual({})
    expect(await client.local({ sessionID: "ses_cc1", action: "interrupt" })).toEqual({})
    expect(await client.stop()).toEqual({})
    expect(calls).toEqual([
      ["start", start],
      ["createSession", { directory: "/w", prompt: "hi" }],
      ["prompt", { sessionID: "ses_cc1", text: "BASH:ls" }],
      ["local", { sessionID: "ses_cc1", action: "interrupt" }],
      ["stop", undefined],
    ])
  })

  test("a method without a handler fails with code unsupported", async () => {
    const { client } = pair({ describe: async () => info })
    clients.push(client)
    const error = await client.local({ sessionID: "s", action: "approve" }).catch((e) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect(error).toMatchObject({ code: "unsupported", method: "local" })
    await expect(client.call("nope")).rejects.toMatchObject({ code: "unsupported", method: "nope" })
    // Inherited object members are not methods.
    await expect(client.call("toString")).rejects.toMatchObject({ code: "unsupported" })
  })

  test("a throwing handler fails with code failed and its message; a DriverError keeps its code", async () => {
    const { client } = pair({
      describe: async () => {
        throw new Error("boom")
      },
      prompt: async () => {
        throw new DriverError("not_ready", "harness still starting")
      },
    })
    clients.push(client)
    await expect(client.describe()).rejects.toMatchObject({ code: "failed", message: "boom" })
    await expect(client.prompt({ sessionID: "s", text: "x" })).rejects.toMatchObject({ code: "not_ready", message: "harness still starting" })
  })

  test("events reach the client in order; nextEvent waits for a match", async () => {
    const { client, served } = pair({ describe: async () => info })
    clients.push(client)
    const waiting = client.nextEvent((e) => e.event === "session.created")
    served.emit("log", { line: "starting" })
    served.emit("session.created", { sessionID: "ses_x" })
    expect(await waiting).toEqual({ event: "session.created", data: { sessionID: "ses_x" } })
    expect(client.events.map((e) => e.event)).toEqual(["log", "session.created"])
    await expect(client.nextEvent((e) => e.event === "never", 30)).rejects.toThrow("timed out")
  })

  test("non-JSON lines are kept as noise by the client and ignored by the driver", async () => {
    const { client, toDriver, fromDriver } = pair({ describe: async () => info })
    clients.push(client)
    fromDriver.write("harness banner\n")
    toDriver.write("{not json\n")
    expect(await client.describe()).toEqual(info)
    expect(client.noise).toEqual(["harness banner"])
  })

  test("a call times out", async () => {
    const { client } = pair({ describe: () => new Promise(() => {}) })
    clients.push(client)
    await expect(client.call("describe", undefined, 30)).rejects.toMatchObject({ code: "timeout", method: "describe" })
  })
})

describe("spawnDriver", () => {
  let dir = ""
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  test("drives a child process over stdio and shuts it down", async () => {
    dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "testkit-driver-"))
    const script = path.join(dir, "driver.ts")
    const testkit = path.join(import.meta.dir, "..", "src", "index.ts")
    writeFileSync(
      script,
      [
        `import { serveDriver } from ${JSON.stringify(testkit)}`,
        `console.log("banner from the harness")`,
        `console.error("stderr line " + process.env.DRIVER_FLAG)`,
        `const d = serveDriver({ describe: async () => (d.emit("described", {}), ${JSON.stringify(info)}) })`,
      ].join("\n"),
    )
    const client = spawnDriver([process.execPath, script], { env: { ...process.env, DRIVER_FLAG: "on" } as Record<string, string> })
    expect(await client.describe()).toEqual(info)
    expect(await client.nextEvent((e) => e.event === "described")).toEqual({ event: "described", data: {} })
    expect(client.noise).toEqual(["banner from the harness"])
    const exit = await client.close()
    expect(exit).toEqual({ code: 0, signal: null })
    expect(client.stderr()).toContain("stderr line on")
  })

  test("close() kills a driver that does not exit after shutdown", async () => {
    dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "testkit-driver-"))
    const script = path.join(dir, "stuck.ts")
    writeFileSync(script, `process.stdin.resume(); setInterval(() => {}, 1000)`)
    const client = spawnDriver([process.execPath, script])
    const exit = await client.close(100)
    expect(exit.signal).toBe("SIGKILL")
  })
})
