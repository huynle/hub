// The node daemon: its hello (runtimes, labels, capacity, use, roots, launches), the hub's ops routed to the right
// runtime with progress frames, slots held from prepare to cleanup, cancel, draining, and capacity frames.
import { describe, expect, test } from "bun:test"
import type { LaunchArtifacts, NodeRequest, PreparedWorkspace } from "../../protocol/src/index.ts"
import type { CleanupResult, PrepareInput, RunHandle, Runtime, RuntimeContext, StartInput, StartResult, StopMode, StopResult } from "../../runtime-sdk/src/index.ts"
import type { NodeConnectionOptions } from "../src/connection.ts"
import { NodeDaemon } from "../src/daemon.ts"

const workspace: PreparedWorkspace = { repo: "/w/r", directory: "/w/r/.worktrees/b", mode: "worktree", branch: "b", reused: false }

class FakeRuntime implements Runtime {
  readonly kind = "host"
  calls: string[] = []
  gate?: Promise<void>
  failPrepare = false
  info() {
    return { kind: "host", harnesses: ["opencode"] }
  }
  async prepare(input: PrepareInput, ctx: RuntimeContext = {}): Promise<PreparedWorkspace> {
    this.calls.push(`prepare ${input.launchID}`)
    ctx.progress?.("creating worktree b")
    if (this.gate)
      await new Promise<void>((resolve, reject) => {
        this.gate!.then(resolve)
        ctx.signal?.addEventListener("abort", () => reject(new Error("prepare cancelled")))
      })
    if (this.failPrepare) throw new Error("base nosuch is not a commit")
    return workspace
  }
  async collect(handle: RunHandle): Promise<LaunchArtifacts> {
    this.calls.push(`collect ${handle.launchID}`)
    return { branch: "b", head: "abcdef0", dirty: false }
  }
  async cleanup(handle: RunHandle, policy: string): Promise<CleanupResult> {
    this.calls.push(`cleanup ${handle.launchID} ${policy}`)
    return { removed: true }
  }
}

function setup(slots = 2) {
  const runtime = new FakeRuntime()
  const sent: unknown[] = []
  let options!: NodeConnectionOptions
  let started = false
  const daemon = new NodeDaemon({
    config: { workspaceRoots: ["/w"], labels: { gpu: "no" }, slots, memoryMB: 1024 },
    credentials: { server: "https://hub.example.com", token: "mt" },
    runtimes: [runtime],
    instanceID: "inst-1",
    platform: { os: "darwin", arch: "arm64" },
    connect: (o) => {
      options = o
      return {
        start: () => (started = true),
        stop: () => (started = false),
        send: (f) => (sent.push(f), true),
      }
    },
  })
  const handle = (req: NodeRequest) => options.handle(req)
  const prepare = (launchID: string) => handle({ op: "prepare", launchID, runtime: { kind: "host" }, harness: "opencode", workspace: { repo: "/w/r", mode: "worktree", branch: "b" } })
  return { daemon, runtime, sent, handle, prepare, hello: () => options.hello(), options: () => options, started: () => started }
}

describe("NodeDaemon", () => {
  test("connects with the machine credentials and says hello as a node", () => {
    const { daemon, hello, options, started } = setup()
    daemon.start()
    expect(started()).toBe(true)
    expect(options().server).toBe("https://hub.example.com")
    expect(options().token).toBe("mt")
    const h = hello()
    expect(h).toMatchObject({
      instanceID: "inst-1",
      runtimes: [{ kind: "host", harnesses: ["opencode"] }],
      labels: { os: "darwin", arch: "arm64", gpu: "no" },
      capacity: { slots: 2, memoryMB: 1024 },
      used: { slots: 0 },
      workspaceRoots: ["/w"],
      draining: false,
      launches: [],
    })
    expect(h.nodeVersion).toMatch(/^\d+\.\d+\.\d+/)
    daemon.stop()
    expect(started()).toBe(false)
  })

  test("prepare runs the runtime, reports progress, holds a slot until cleanup, and sends capacity", async () => {
    const { daemon, runtime, sent, handle, prepare, hello } = setup()
    daemon.start()
    expect(await prepare("l1")).toEqual({ workspace })
    expect(sent).toContainEqual({ t: "progress", launchID: "l1", phase: "preparing", message: "creating worktree b" })
    expect(sent).toContainEqual({ t: "progress", launchID: "l1", phase: "prepared" })
    expect(sent).toContainEqual({ t: "capacity", capacity: { slots: 2, memoryMB: 1024 }, used: { slots: 1 }, draining: false })
    expect(hello().used).toEqual({ slots: 1 })
    expect(hello().launches).toEqual([{ launchID: "l1", phase: "prepared", directory: workspace.directory }])
    expect(await handle({ op: "collect", launchID: "l1", workspace })).toEqual({ artifacts: { branch: "b", head: "abcdef0", dirty: false } })
    expect(await handle({ op: "cleanup", launchID: "l1", workspace, policy: "remove" })).toEqual({ removed: true })
    expect(runtime.calls).toEqual(["prepare l1", "collect l1", "cleanup l1 remove"])
    expect(hello().used).toEqual({ slots: 0 })
    expect(hello().launches).toEqual([])
    expect(sent.at(-1)).toEqual({ t: "capacity", capacity: { slots: 2, memoryMB: 1024 }, used: { slots: 0 }, draining: false })
  })

  test("refuses a prepare without a free slot, a duplicate prepare and an unknown runtime", async () => {
    const { daemon, prepare, handle } = setup(1)
    daemon.start()
    await prepare("l1")
    await expect(prepare("l2")).rejects.toThrow(/slot/)
    await expect(prepare("l1")).rejects.toThrow(/already/)
    await expect(handle({ op: "prepare", launchID: "l3", runtime: { kind: "openshell" }, harness: "opencode", workspace: { repo: "/w/r", mode: "clone", remote: "https://x/y.git" } })).rejects.toThrow(/runtime/)
  })

  test("a failed prepare frees the slot and reports failed", async () => {
    const { daemon, runtime, sent, prepare, hello } = setup()
    daemon.start()
    runtime.failPrepare = true
    await expect(prepare("l1")).rejects.toThrow("base nosuch is not a commit")
    expect(sent).toContainEqual({ t: "progress", launchID: "l1", phase: "failed", message: "base nosuch is not a commit" })
    expect(hello().used).toEqual({ slots: 0 })
  })

  test("cancel stops a running prepare; with nothing running it says so", async () => {
    const { daemon, runtime, handle, prepare, sent, hello } = setup()
    daemon.start()
    runtime.gate = new Promise(() => {})
    const pending = prepare("l1")
    await Bun.sleep(5)
    expect(await handle({ op: "cancel", launchID: "l1" })).toEqual({ cancelled: true })
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(sent).toContainEqual({ t: "progress", launchID: "l1", phase: "cancelled" })
    expect(hello().used).toEqual({ slots: 0 })
    expect(await handle({ op: "cancel", launchID: "l9" })).toEqual({ cancelled: false })
  })

  test("collect and cleanup work for a launch an earlier run prepared (the handle carries the workspace)", async () => {
    const { daemon, handle, runtime } = setup()
    daemon.start()
    expect(await handle({ op: "cleanup", launchID: "old", workspace, policy: "keep" })).toEqual({ removed: true })
    expect(runtime.calls).toEqual(["cleanup old keep"])
  })

  test("a draining node refuses new launches and reports it", async () => {
    const { daemon, prepare, sent, hello } = setup()
    daemon.start()
    daemon.drain()
    expect(hello().draining).toBe(true)
    expect(sent.at(-1)).toMatchObject({ t: "capacity", draining: true })
    await expect(prepare("l1")).rejects.toThrow(/draining/)
  })

  test("a launch's progress messages are trimmed to the protocol's limit", async () => {
    const { daemon, runtime, sent, prepare } = setup()
    daemon.start()
    runtime.failPrepare = true
    runtime.prepare = async () => {
      throw new Error(`x${"y".repeat(2000)}\nline two`)
    }
    await expect(prepare("l1")).rejects.toThrow()
    const failed = sent.find((f) => (f as { phase?: string }).phase === "failed") as { message: string }
    expect(failed.message.length).toBeLessThanOrEqual(500)
    expect(failed.message).not.toContain("\n")
  })
})

const sandboxed: PreparedWorkspace = { repo: "/w/r", directory: "/sandbox/work", mode: "clone", branch: "b", reused: false, runtime: { kind: "openshell", sandbox: "hub-abc", profile: "default" } }

class FakeSandboxRuntime implements Runtime {
  readonly kind = "openshell"
  calls: string[] = []
  failStart = false
  info() {
    return { kind: "openshell", harnesses: ["opencode"], profiles: ["default"] }
  }
  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    this.calls.push(`prepare ${input.launchID}`)
    return sandboxed
  }
  async start(ws: PreparedWorkspace, input: StartInput): Promise<StartResult> {
    this.calls.push(`start ${input.launchID} ${input.hub.url}`)
    if (this.failStart) throw new Error("sandbox hub-abc is gone")
    return { launchID: input.launchID, workspace: ws, started: true }
  }
  async stop(handle: RunHandle, mode: StopMode): Promise<StopResult> {
    this.calls.push(`stop ${handle.launchID} ${mode}`)
    return { stopped: true }
  }
  async collect(handle: RunHandle): Promise<LaunchArtifacts> {
    this.calls.push(`collect ${handle.launchID}`)
    return { branch: "b", head: "abcdef1", dirty: false }
  }
  async cleanup(handle: RunHandle, policy: string): Promise<CleanupResult> {
    this.calls.push(`cleanup ${handle.launchID} ${policy}`)
    return { removed: true }
  }
}

function setupBoth(extra: Partial<ConstructorParameters<typeof NodeDaemon>[0]> = {}) {
  const host = new FakeRuntime()
  const sandbox = new FakeSandboxRuntime()
  const sent: unknown[] = []
  let options!: NodeConnectionOptions
  const daemon = new NodeDaemon({
    config: { workspaceRoots: ["/w"], labels: {}, slots: 4 },
    credentials: { server: "https://hub.example.com", token: "mt" },
    runtimes: [host, sandbox],
    instanceID: "inst-1",
    platform: { os: "darwin", arch: "arm64" },
    connect: (o) => {
      options = o
      return { start: () => {}, stop: () => {}, send: (f) => (sent.push(f), true) }
    },
    ...extra,
  })
  daemon.start()
  const handle = (req: NodeRequest) => options.handle(req)
  return { daemon, host, sandbox, sent, handle, hello: () => options.hello() }
}

const start = (launchID: string, ws: PreparedWorkspace): NodeRequest => ({ op: "start", launchID, workspace: ws, harness: "opencode", hub: { url: "http://127.0.0.1:4096", token: "lt" } })

describe("NodeDaemon with a sandbox runtime", () => {
  test("announces the sandbox feature only when a runtime can start and stop harnesses", () => {
    expect(setup().daemon.hello().features ?? []).not.toContain("sandbox")
    expect(setupBoth().hello().features).toContain("sandbox")
  })

  test("adds the runtime's backends to its hello entry", () => {
    const { hello } = setupBoth({ backends: { openshell: ["vm"] } })
    expect(hello().runtimes).toEqual([
      { kind: "host", harnesses: ["opencode"] },
      { kind: "openshell", harnesses: ["opencode"], profiles: ["default"], backends: ["vm"] },
    ])
  })

  test("prepare goes to the request's runtime; collect, cleanup, start and stop to the workspace's runtime", async () => {
    const { handle, host, sandbox, hello } = setupBoth()
    expect(await handle({ op: "prepare", launchID: "s1", runtime: { kind: "openshell" }, harness: "opencode", workspace: { repo: "/w/r", mode: "clone", remote: "https://x/y.git" } })).toEqual({ workspace: sandboxed })
    expect(hello().launches).toEqual([{ launchID: "s1", phase: "prepared", directory: "/sandbox/work", sandbox: "hub-abc" }])
    expect(await handle(start("s1", sandboxed))).toEqual({ started: true })
    expect(hello().launches[0]?.phase).toBe("running")
    expect(await handle({ op: "stop", launchID: "s1", workspace: sandboxed, mode: "kill" })).toEqual({ stopped: true })
    expect(hello().launches[0]?.phase).toBe("stopped")
    await handle({ op: "collect", launchID: "s1", workspace: sandboxed })
    await handle({ op: "cleanup", launchID: "s1", workspace: sandboxed, policy: "remove" })
    expect(sandbox.calls).toEqual(["prepare s1", "start s1 http://127.0.0.1:4096", "stop s1 kill", "collect s1", "cleanup s1 remove"])
    expect(host.calls).toEqual([])
    await handle({ op: "collect", launchID: "h1", workspace })
    expect(host.calls).toEqual(["collect h1"])
  })

  test("start and stop progress frames; a failed start reports failed and keeps the launch", async () => {
    const { handle, sandbox, sent, hello } = setupBoth()
    await handle({ op: "prepare", launchID: "s1", runtime: { kind: "openshell" }, harness: "opencode", workspace: { repo: "/w/r", mode: "clone", remote: "https://x/y.git" } })
    await handle(start("s1", sandboxed))
    expect(sent).toContainEqual({ t: "progress", launchID: "s1", phase: "starting" })
    expect(sent).toContainEqual({ t: "progress", launchID: "s1", phase: "running" })
    await handle({ op: "stop", launchID: "s1", workspace: sandboxed })
    expect(sandbox.calls.at(-1)).toBe("stop s1 graceful")
    expect(sent).toContainEqual({ t: "progress", launchID: "s1", phase: "stopping" })
    expect(sent).toContainEqual({ t: "progress", launchID: "s1", phase: "stopped" })
    sandbox.failStart = true
    await handle({ op: "prepare", launchID: "s2", runtime: { kind: "openshell" }, harness: "opencode", workspace: { repo: "/w/r", mode: "clone", remote: "https://x/y.git" } })
    await expect(handle(start("s2", sandboxed))).rejects.toThrow("gone")
    expect(sent).toContainEqual({ t: "progress", launchID: "s2", phase: "failed", message: "sandbox hub-abc is gone" })
    expect(hello().used).toEqual({ slots: 2 })
  })

  test("the host runtime does not start or stop harnesses: started/stopped false with a reason", async () => {
    const { handle, host } = setupBoth()
    expect(await handle(start("h1", workspace))).toEqual({ started: false, reason: expect.stringContaining("host") })
    expect(await handle({ op: "stop", launchID: "h1", workspace })).toEqual({ stopped: false, reason: expect.stringContaining("host") })
    expect(host.calls).toEqual([])
  })

  test("a workspace naming a runtime this node lacks is refused", async () => {
    const { daemon, handle } = setup()
    daemon.start()
    await expect(handle({ op: "collect", launchID: "s1", workspace: sandboxed })).rejects.toThrow(/openshell/)
    await expect(handle(start("s1", sandboxed))).rejects.toThrow(/openshell/)
  })
})

describe("NodeDaemon: launches found at startup (orphan sandboxes)", () => {
  const recovered = [
    { launchID: "o1", phase: "running" as const, sandbox: "hub-o1" },
    { launchID: "o2", phase: "stopped" as const, sandbox: "hub-o2" },
  ]

  test("reports them in its hello and holds a slot for each until cleanup", async () => {
    const { handle, hello, sent } = setupBoth({ recovered })
    expect(hello().launches).toEqual(recovered)
    expect(hello().used).toEqual({ slots: 2 })
    const ws: PreparedWorkspace = { ...sandboxed, runtime: { kind: "openshell", sandbox: "hub-o1" } }
    await handle({ op: "cleanup", launchID: "o1", workspace: ws, policy: "remove" })
    expect(hello().launches).toEqual([recovered[1]!])
    expect(sent.at(-1)).toMatchObject({ t: "capacity", used: { slots: 1 } })
  })

  test("a prepare for a recovered launch is refused as a duplicate", async () => {
    const { handle } = setupBoth({ recovered })
    await expect(handle({ op: "prepare", launchID: "o1", runtime: { kind: "openshell" }, harness: "opencode", workspace: { repo: "/w/r", mode: "clone", remote: "https://x/y.git" } })).rejects.toThrow(/already/)
  })
})
