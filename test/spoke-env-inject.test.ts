import { describe, expect, test } from "bun:test"
import path from "node:path"
import { applyHubEnv, envInjector, hubBinDir, ShellCorrelator, stripInheritedHubEnv } from "../src/spoke/env-inject"

function clock(start = 1_000) {
  const c = { now: start }
  return { c, now: () => c.now }
}

const shellCall = (sessionID: string, command: string, id = `call_${sessionID}_${command}`) => ({
  tool: "shell",
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id,
  input: { command } as unknown,
})

describe("ShellCorrelator", () => {
  test("matches a shell to the session whose shell tool call announced the same command, once", () => {
    const k = new ShellCorrelator()
    k.record(shellCall("ses_a", "ls -la"))
    expect(k.match("ls -la")).toBe("ses_a")
    expect(k.match("ls -la")).toBeUndefined()
  })

  test("unknown commands and non-shell tools match nothing", () => {
    const k = new ShellCorrelator()
    k.record({ ...shellCall("ses_a", "ls"), tool: "read" })
    k.record({ ...shellCall("ses_b", "pwd"), input: undefined })
    expect(k.match("ls")).toBeUndefined()
    expect(k.match("pwd")).toBeUndefined()
    expect(k.size).toBe(0)
  })

  test("also accepts the bash tool name", () => {
    const k = new ShellCorrelator()
    k.record({ ...shellCall("ses_a", "ls"), tool: "bash" })
    expect(k.match("ls")).toBe("ses_a")
  })

  test("reads the command when the shell is created, so later input rewrites by other hooks still match", () => {
    const k = new ShellCorrelator()
    const event = shellCall("ses_a", "ls")
    k.record(event)
    ;(event.input as { command: string }).command = "ls --color=never"
    expect(k.match("ls")).toBeUndefined()
    expect(k.match("ls --color=never")).toBe("ses_a")
  })

  test("the same command pending from two sessions is ambiguous: matches nothing and fails closed", () => {
    const k = new ShellCorrelator()
    k.record(shellCall("ses_a", "make test"))
    k.record(shellCall("ses_b", "make test"))
    expect(k.match("make test")).toBeUndefined()
    // Both pending entries are dropped, so the second shell cannot be given the wrong session either.
    expect(k.match("make test")).toBeUndefined()
    expect(k.size).toBe(0)
  })

  test("the same command twice from one session is not ambiguous", () => {
    const k = new ShellCorrelator()
    k.record(shellCall("ses_a", "make", "call_1"))
    k.record(shellCall("ses_a", "make", "call_2"))
    expect(k.match("make")).toBe("ses_a")
    expect(k.match("make")).toBe("ses_a")
    expect(k.match("make")).toBeUndefined()
  })

  test("pending entries expire after the TTL", () => {
    const { c, now } = clock()
    const k = new ShellCorrelator({ ttlMs: 30_000, now })
    k.record(shellCall("ses_a", "ls"))
    k.record(shellCall("ses_b", "pwd"))
    c.now += 29_999
    expect(k.match("ls")).toBe("ses_a")
    c.now += 1
    expect(k.match("pwd")).toBeUndefined()
    expect(k.size).toBe(0)
  })

  test("an expired entry does not make a fresh one ambiguous", () => {
    const { c, now } = clock()
    const k = new ShellCorrelator({ ttlMs: 30_000, now })
    k.record(shellCall("ses_a", "ls"))
    c.now += 30_000
    k.record(shellCall("ses_b", "ls"))
    expect(k.match("ls")).toBe("ses_b")
  })

  test("is bounded: the oldest entries are dropped beyond max", () => {
    const k = new ShellCorrelator({ max: 3 })
    for (const n of [1, 2, 3, 4, 5]) k.record(shellCall(`ses_${n}`, `cmd ${n}`))
    expect(k.size).toBe(3)
    expect(k.match("cmd 1")).toBeUndefined()
    expect(k.match("cmd 2")).toBeUndefined()
    expect(k.match("cmd 5")).toBe("ses_5")
  })

  test("done(callID) forgets a call whose shell was never created (e.g. the tool failed early)", () => {
    const k = new ShellCorrelator()
    k.record(shellCall("ses_a", "ls", "call_a"))
    k.done("call_a")
    k.record(shellCall("ses_b", "ls", "call_b"))
    expect(k.match("ls")).toBe("ses_b")
  })
})

describe("applyHubEnv", () => {
  const bin = "/home/u/.local/state/hub/bin"

  test("strips inherited HUB_URL and HUB_SESSION_TOKEN when the session has no token", () => {
    const env: Record<string, string | undefined> = { HUB_URL: "http://outer", HUB_SESSION_TOKEN: "outer-token", HOME: "/home/u", PATH: "/usr/bin" }
    applyHubEnv(env, undefined, bin)
    expect("HUB_URL" in env).toBe(false)
    expect("HUB_SESSION_TOKEN" in env).toBe(false)
    expect(env.HOME).toBe("/home/u")
    expect(env.PATH).toBe(`${bin}${path.delimiter}/usr/bin`)
  })

  test("sets the session's HUB_URL and HUB_SESSION_TOKEN over inherited ones", () => {
    const env: Record<string, string | undefined> = { HUB_URL: "http://outer", HUB_SESSION_TOKEN: "outer-token", PATH: "/usr/bin" }
    applyHubEnv(env, { url: "https://hub.example", token: "tok-a" }, bin)
    expect(env.HUB_URL).toBe("https://hub.example")
    expect(env.HUB_SESSION_TOKEN).toBe("tok-a")
  })

  test("without a hub URL only the token is set", () => {
    const env: Record<string, string | undefined> = { HUB_URL: "http://outer" }
    applyHubEnv(env, { token: "tok-a" }, bin)
    expect("HUB_URL" in env).toBe(false)
    expect(env.HUB_SESSION_TOKEN).toBe("tok-a")
  })

  test("puts the hub bin dir first on PATH exactly once", () => {
    const d = path.delimiter
    const env: Record<string, string | undefined> = { PATH: `/usr/bin${d}${bin}${d}/bin${d}${bin}` }
    applyHubEnv(env, undefined, bin)
    expect(env.PATH).toBe(`${bin}${d}/usr/bin${d}/bin`)
    applyHubEnv(env, undefined, bin)
    expect(env.PATH).toBe(`${bin}${d}/usr/bin${d}/bin`)
  })

  test("a missing PATH gets the bin dir plus the system defaults", () => {
    const env: Record<string, string | undefined> = {}
    applyHubEnv(env, undefined, bin)
    expect(env.PATH).toBe([bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter))
  })
})

describe("stripInheritedHubEnv", () => {
  test("removes HUB_URL and HUB_SESSION_TOKEN and keeps the rest", () => {
    const env: Record<string, string | undefined> = { HUB_URL: "u", HUB_SESSION_TOKEN: "t", HUB_SPOKE_CONFIG: "/c", HOME: "/h" }
    stripInheritedHubEnv(env)
    expect(env).toEqual({ HUB_SPOKE_CONFIG: "/c", HOME: "/h" })
  })
})

describe("hubBinDir", () => {
  test("is bin under the hub state dir ($HUB_STATE_DIR or ~/.local/state/hub)", () => {
    expect(hubBinDir({ HUB_STATE_DIR: "/s/hub" }, "/home/u")).toBe(path.join("/s/hub", "bin"))
    expect(hubBinDir({}, "/home/u")).toBe(path.join("/home/u", ".local", "state", "hub", "bin"))
  })
})

describe("envInjector", () => {
  function setup(tokens: Record<string, string>, hubURL?: string) {
    const correlator = new ShellCorrelator()
    const injector = envInjector({
      correlator,
      binDir: "/bin/hub",
      identity: (sessionID) => (tokens[sessionID] ? { token: tokens[sessionID], ...(hubURL ? { url: hubURL } : {}) } : undefined),
    })
    return { correlator, injector }
  }
  const shell = (command: string, env: Record<string, string | undefined> = {}) => ({ command, cwd: "/w", timeout: 0, shell: "/bin/sh", env })

  test("a shell tool call's shell gets its session's identity", () => {
    const { injector } = setup({ ses_a: "tok-a" }, "https://hub.example")
    injector.toolBefore(shellCall("ses_a", "hub whoami"))
    const inv = shell("hub whoami", { HUB_SESSION_TOKEN: "outer", PATH: "/usr/bin" })
    injector.shellBefore(inv)
    expect(inv.env.HUB_SESSION_TOKEN).toBe("tok-a")
    expect(inv.env.HUB_URL).toBe("https://hub.example")
    expect(inv.env.PATH).toBe(`/bin/hub${path.delimiter}/usr/bin`)
  })

  test("an unmatched shell (e.g. a user ! command) is only stripped and gets PATH", () => {
    const { injector } = setup({ ses_a: "tok-a" }, "https://hub.example")
    const inv = shell("ls", { HUB_SESSION_TOKEN: "outer", HUB_URL: "http://outer", PATH: "/usr/bin" })
    injector.shellBefore(inv)
    expect(inv.env.HUB_SESSION_TOKEN).toBeUndefined()
    expect(inv.env.HUB_URL).toBeUndefined()
    expect(inv.env.PATH).toBe(`/bin/hub${path.delimiter}/usr/bin`)
  })

  test("a matched session without a token gets no identity", () => {
    const { injector } = setup({})
    injector.toolBefore(shellCall("ses_a", "ls"))
    const inv = shell("ls", { HUB_SESSION_TOKEN: "outer" })
    injector.shellBefore(inv)
    expect("HUB_SESSION_TOKEN" in inv.env).toBe(false)
  })

  test("ignores the OPENCODE_SESSION_ID in the base env (it is the server's inherited one, set for the tool only later)", () => {
    const { injector } = setup({ ses_outer: "tok-outer" })
    const inv = shell("ls", { OPENCODE_SESSION_ID: "ses_outer" })
    injector.shellBefore(inv)
    expect(inv.env.HUB_SESSION_TOKEN).toBeUndefined()
  })

  test("toolAfter forgets the call", () => {
    const { injector, correlator } = setup({ ses_a: "tok-a" })
    const call = shellCall("ses_a", "ls")
    injector.toolBefore(call)
    injector.toolAfter(call)
    expect(correlator.size).toBe(0)
  })

  test("never throws, even on odd input", () => {
    const { injector } = setup({ ses_a: "tok-a" })
    expect(() => injector.toolBefore({ tool: "shell", sessionID: "ses_a", id: "x", input: null } as any)).not.toThrow()
    expect(() => injector.shellBefore({ command: "ls" } as any)).not.toThrow()
  })
})
