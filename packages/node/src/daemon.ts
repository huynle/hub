// The node daemon (design §6.3): one NodeConnection to the hub and the runtimes it offers. It serves the hub's
// prepare → (start → stop) → collect → cleanup (and cancel) for each launch, reports progress frames, and holds a
// slot per launch from prepare until cleanup (or a failed or cancelled prepare), sending a capacity frame whenever
// use changes. prepare goes to the runtime the request names; every later op to the runtime the prepared workspace
// names (workspace.runtime, absent = host). It announces the "sandbox" feature (start and stop) only when one of its
// runtimes starts harnesses (openshell); the host runtime answers start and stop with started/stopped false.
// It keeps launches in memory only: the later ops carry the prepared workspace, so a restarted node can still
// serve them. There is no remote exec channel: these ops are all the hub can ask.
import { randomUUID } from "node:crypto"
import { arch as osArch, platform as osPlatform } from "node:os"
import {
  NODE_FEATURES,
  NODE_MESSAGE_MAX,
  preparedWorkspaceRuntime,
  type NodeCapacity,
  type NodeHello,
  type NodeLaunchPhase,
  type NodeLaunchReport,
  type NodeRequest,
  type NodeResultFor,
  type NodeRuntimeInfo,
  type PreparedWorkspace,
} from "../../protocol/src/index.ts"
import { RuntimeError, type Runtime } from "../../runtime-sdk/src/index.ts"
import pkg from "../package.json" with { type: "json" }
import type { NodeConfig, SpokeCredentials } from "./config.ts"
import { NodeConnection, type NodeConnectionOptions, type NodeConnectionState } from "./connection.ts"
import { HostRuntime } from "./host.ts"

export const NODE_VERSION: string = pkg.version

/** What the daemon needs of a connection (NodeConnection, or a fake in tests). */
export interface ConnectionLike {
  start(): void
  stop(): void
  send(frame: Parameters<NodeConnection["send"]>[0]): boolean
}

export interface NodeDaemonOptions {
  readonly config: NodeConfig
  readonly credentials: SpokeCredentials
  /** Default: the host runtime over the config's roots. */
  readonly runtimes?: readonly Runtime[]
  readonly instanceID?: string
  /** The os and arch labels (default this machine's). */
  readonly platform?: { readonly os: string; readonly arch: string }
  readonly connect?: (options: NodeConnectionOptions) => ConnectionLike
  readonly onState?: (state: NodeConnectionState, error?: string) => void
  /** Backends per runtime kind (e.g. openshell: the gateway's compute drivers), added to the hello's runtimes. */
  readonly backends?: Readonly<Record<string, readonly string[]>>
  /** Launches found at startup (an earlier run's sandboxes): reported in the hello, each holding a slot until cleanup. */
  readonly recovered?: readonly NodeLaunchReport[]
}

interface Tracked {
  phase: NodeLaunchPhase
  directory?: string
  sandbox?: string
  abort?: AbortController
}

/** A message fit for a progress frame: one line of printable text, at most NODE_MESSAGE_MAX characters. */
export function progressText(text: string): string | undefined {
  const line = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim()
  return line ? line.slice(0, NODE_MESSAGE_MAX) : undefined
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export class NodeDaemon {
  private readonly launches = new Map<string, Tracked>()
  private readonly runtimes: readonly Runtime[]
  private readonly instanceID: string
  private readonly labels: Readonly<Record<string, string>>
  private draining = false
  private connection?: ConnectionLike

  constructor(private readonly options: NodeDaemonOptions) {
    this.runtimes = options.runtimes ?? [new HostRuntime({ roots: options.config.workspaceRoots })]
    this.instanceID = options.instanceID ?? randomUUID()
    const platform = options.platform ?? { os: osPlatform(), arch: osArch() }
    this.labels = { os: platform.os, arch: platform.arch, ...options.config.labels }
    for (const r of options.recovered ?? [])
      this.launches.set(r.launchID, { phase: r.phase, ...(r.directory ? { directory: r.directory } : {}), ...(r.sandbox ? { sandbox: r.sandbox } : {}) })
  }

  start(): void {
    if (this.connection) return
    const connectionOptions: NodeConnectionOptions = {
      server: this.options.credentials.server,
      token: this.options.credentials.token,
      hello: () => this.hello(),
      handle: (req) => this.handle(req),
      ...(this.options.onState ? { onState: this.options.onState } : {}),
    }
    this.connection = (this.options.connect ?? ((o) => new NodeConnection(o)))(connectionOptions)
    this.connection.start()
  }

  stop(): void {
    for (const launch of this.launches.values()) launch.abort?.abort()
    this.connection?.stop()
    this.connection = undefined
  }

  /** Takes no new launches (running ones finish); the hub learns it from a capacity frame. */
  drain(): void {
    this.draining = true
    this.sendCapacity()
  }

  hello(): Omit<NodeHello, "t" | "v" | "role"> {
    const features = NODE_FEATURES.filter((f) => f !== "sandbox" || this.servesSandbox())
    return {
      instanceID: this.instanceID,
      nodeVersion: NODE_VERSION,
      ...(features.length ? { features } : {}),
      runtimes: this.runtimes.map((r) => this.runtimeInfo(r)),
      labels: this.labels,
      capacity: this.capacity(),
      used: this.used(),
      workspaceRoots: [...this.options.config.workspaceRoots],
      draining: this.draining,
      launches: [...this.launches].map(
        ([launchID, t]): NodeLaunchReport => ({ launchID, phase: t.phase, ...(t.directory ? { directory: t.directory } : {}), ...(t.sandbox ? { sandbox: t.sandbox } : {}) }),
      ),
    }
  }

  async handle(req: NodeRequest): Promise<NodeResultFor[NodeRequest["op"]]> {
    switch (req.op) {
      case "prepare":
        return this.prepare(req)
      case "collect": {
        const runtime = this.workspaceRuntime(req.workspace)
        const before = this.launches.get(req.launchID)?.phase
        this.phase(req.launchID, "collecting")
        try {
          const artifacts = await runtime.collect({ launchID: req.launchID, workspace: req.workspace })
          this.phase(req.launchID, "collected")
          return { artifacts }
        } catch (cause) {
          const tracked = this.launches.get(req.launchID)
          if (tracked && before) tracked.phase = before
          throw cause
        }
      }
      case "cleanup": {
        const runtime = this.workspaceRuntime(req.workspace)
        this.phase(req.launchID, "cleaning")
        try {
          const result = await runtime.cleanup({ launchID: req.launchID, workspace: req.workspace }, req.policy)
          this.progress(req.launchID, "cleaned", result.removed ? undefined : result.reason)
          return result
        } finally {
          this.release(req.launchID)
        }
      }
      case "cancel": {
        const tracked = this.launches.get(req.launchID)
        if (!tracked?.abort || tracked.phase !== "preparing") return { cancelled: false }
        tracked.abort.abort()
        return { cancelled: true }
      }
      case "start":
        return this.startLaunch(req)
      case "stop":
        return this.stopLaunch(req)
    }
  }

  private async startLaunch(req: Extract<NodeRequest, { op: "start" }>): Promise<NodeResultFor["start"]> {
    const runtime = this.workspaceRuntime(req.workspace)
    if (!runtime.start) return { started: false, reason: `the ${runtime.kind} runtime does not start harnesses (its sessions run in the machine's harness service)` }
    const before = this.launches.get(req.launchID)?.phase
    this.phase(req.launchID, "starting")
    try {
      const result = await runtime.start(req.workspace, { launchID: req.launchID, harness: req.harness, hub: req.hub, ...(req.env ? { env: req.env } : {}) }, {
        progress: (message) => this.progress(req.launchID, "starting", message),
      })
      this.phase(req.launchID, "running")
      return { started: result.started, ...(result.reason ? { reason: result.reason } : {}) }
    } catch (cause) {
      const tracked = this.launches.get(req.launchID)
      if (tracked && before) tracked.phase = before
      this.progress(req.launchID, "failed", errorText(cause))
      throw cause
    }
  }

  private async stopLaunch(req: Extract<NodeRequest, { op: "stop" }>): Promise<NodeResultFor["stop"]> {
    const runtime = this.workspaceRuntime(req.workspace)
    if (!runtime.stop) return { stopped: false, reason: `the ${runtime.kind} runtime runs no harness of its own to stop` }
    const before = this.launches.get(req.launchID)?.phase
    this.phase(req.launchID, "stopping")
    try {
      const result = await runtime.stop({ launchID: req.launchID, workspace: req.workspace }, req.mode ?? "graceful")
      this.phase(req.launchID, result.stopped ? "stopped" : (before ?? "stopped"))
      return { stopped: result.stopped, ...(result.reason ? { reason: result.reason } : {}) }
    } catch (cause) {
      const tracked = this.launches.get(req.launchID)
      if (tracked && before) tracked.phase = before
      throw cause
    }
  }

  private async prepare(req: Extract<NodeRequest, { op: "prepare" }>): Promise<NodeResultFor["prepare"]> {
    if (this.draining) throw new RuntimeError("this node is draining and takes no new launches")
    if (this.launches.has(req.launchID)) throw new RuntimeError(`launch ${req.launchID} is already on this node`)
    const runtime = this.runtimeFor(req.runtime.kind)
    if (this.used().slots >= this.options.config.slots) throw new RuntimeError(`no free slot on this node (${this.options.config.slots} in use)`)
    const abort = new AbortController()
    this.launches.set(req.launchID, { phase: "preparing", abort })
    this.sendCapacity()
    this.progress(req.launchID, "preparing")
    try {
      const workspace = await runtime.prepare(
        { launchID: req.launchID, harness: req.harness, runtime: req.runtime, workspace: req.workspace },
        { signal: abort.signal, progress: (message) => this.progress(req.launchID, "preparing", message) },
      )
      if (abort.signal.aborted) throw new RuntimeError("prepare cancelled")
      this.launches.set(req.launchID, { phase: "prepared", directory: workspace.directory, ...(workspace.runtime?.sandbox ? { sandbox: workspace.runtime.sandbox } : {}) })
      this.progress(req.launchID, "prepared")
      return { workspace }
    } catch (cause) {
      this.progress(req.launchID, abort.signal.aborted ? "cancelled" : "failed", abort.signal.aborted ? undefined : errorText(cause))
      this.release(req.launchID)
      throw abort.signal.aborted ? new RuntimeError("prepare cancelled") : cause
    }
  }

  private runtimeFor(kind: string): Runtime {
    const runtime = this.runtimes.find((r) => r.kind === kind)
    if (!runtime) throw new RuntimeError(`runtime ${kind || "(none)"} is not available on this node`)
    return runtime
  }

  /** The runtime that owns a prepared workspace: the one it names (absent: host). */
  private workspaceRuntime(workspace: PreparedWorkspace): Runtime {
    return this.runtimeFor(preparedWorkspaceRuntime(workspace).kind)
  }

  /** Whether a runtime here starts and stops harnesses itself (the "sandbox" feature). */
  private servesSandbox(): boolean {
    return this.runtimes.some((r) => typeof r.start === "function" && typeof r.stop === "function")
  }

  private runtimeInfo(runtime: Runtime): NodeRuntimeInfo {
    const info = runtime.info()
    const backends = this.options.backends?.[runtime.kind]
    return backends?.length ? { ...info, backends: [...backends] } : info
  }

  private capacity(): NodeCapacity {
    const { slots, memoryMB } = this.options.config
    return { slots, ...(memoryMB !== undefined ? { memoryMB } : {}) }
  }

  private used(): NodeCapacity {
    return { slots: this.launches.size }
  }

  private phase(launchID: string, phase: NodeLaunchPhase): void {
    const tracked = this.launches.get(launchID)
    if (tracked) tracked.phase = phase
    this.progress(launchID, phase)
  }

  private release(launchID: string): void {
    if (this.launches.delete(launchID)) this.sendCapacity()
  }

  private progress(launchID: string, phase: NodeLaunchPhase, message?: string): void {
    const text = message === undefined ? undefined : progressText(message)
    this.connection?.send({ t: "progress", launchID, phase, ...(text ? { message: text } : {}) })
  }

  private sendCapacity(): void {
    this.connection?.send({ t: "capacity", capacity: this.capacity(), used: this.used(), draining: this.draining })
  }
}
