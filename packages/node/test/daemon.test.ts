// The node daemon: its hello (runtimes, labels, capacity, use, roots, launches), the hub's ops routed to the right
// runtime with progress frames, slots held from prepare to cleanup, cancel, draining, and capacity frames.
import { describe, expect, test } from "bun:test"
import type { LaunchArtifacts, NodeRequest, PreparedWorkspace } from "../../protocol/src/index.ts"
import type { CleanupResult, PrepareInput, RunHandle, Runtime, RuntimeContext } from "../../runtime-sdk/src/index.ts"
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
