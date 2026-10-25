// Placement (design §6.2, §9; decision znbg8xa5): which of the user's nodes takes a launch.
// - matchNode is pure: over a snapshot of candidates it applies the hard constraints (the user's own machines only,
//   not draining, the runtime kind, the harness (host: always; other runtimes when they list harnesses), the
//   runtime profile, the workspace under one of the node's roots, and for host launches a connected service spoke
//   announcing "launch"), then the placement's machine and labels (mode require: hard; prefer: ranking only), then
//   free slots (capacity minus used minus reservations). The best node has the preference, then most free slots,
//   then the lowest machine ID. A launch that cannot be placed waits for capacity (a fitting node is full) or for a
//   match (no node fits; the reason names each node's first problem).
// - Admission (per user, hub.json agents.launches): admit() refuses a new launch with rate_limited while maxQueued
//   launches are queued or perHour were recorded this clock hour (Counters, one key per hour); it consumes
//   nothing, so the engine calls recordLaunch() only when the store really created a launch (not for an
//   idempotent retry). Two racing creates can both pass admit: perHour is a soft cap by that margin.
// - place(user) is one pass under the user's fenced lease (Locks `placement:<user>`), so two processes never place
//   the same user's launches; the lease is renewed (and its fence checked) before every write and released at
//   the end. A pass first returns launches left placing by a dead holder to the queue, then walks queued launches
//   oldest first: while fewer than maxActive are placing/provisioning/running, each is matched against the
//   user's nodes and moved queued → placing → provisioning on the machine. A launch that cannot be placed now is
//   reported as waiting and does not hold back later ones; earlier launches always pick first. Reservations are
//   launches provisioning or running on a machine that its node does not report (yet); slots taken in the pass
//   count at once. Reasons go on the launch only when it moves; waiting reasons are returned for the engine.
// - PlacementLoop runs passes: kick(user) when something changed (a launch queued or ended, a node connected or
//   reported capacity, a service spoke came), coalescing kicks during a pass into one more, plus a sweep over
//   users() every intervalMs for whatever a kick missed (e.g. another process held the lease). Each placed launch
//   goes to onPlaced (the launch engine starts provisioning); failures go to onError and never stop the loop.
// - Node and spoke info come through PlacementNodes / PlacementSpokes, which the launch engine adapts from the
//   NodeRegistry and the Registry; memory is not matched (a spec has no memory need yet).
import type { NodeCapacity, NodeRuntimeInfo } from "../../protocol"
import type { Clock, Counters, Locks, Timers } from "../backend/types"
import type { HubLaunches } from "../config"
import { AgentError } from "./errors"
import type { LaunchSpec } from "./launch-spec"
import { type Launch, type LaunchState, type LaunchStore, LaunchTransitionError } from "./launch-store"

/** A connected node as placement sees it (the launch engine adapts the NodeRegistry to this). */
export interface PlacementNode {
  readonly machineID: string
  /** The machine's name (placement.machine matches it or the ID). */
  readonly name?: string
  /** The user owning the machine. */
  readonly owner: string
  readonly runtimes: readonly NodeRuntimeInfo[]
  readonly labels: Readonly<Record<string, string>>
  readonly capacity: NodeCapacity
  readonly used: NodeCapacity
  readonly workspaceRoots: readonly string[]
  readonly draining: boolean
  /** The launches the node reports carrying (they count in `used`). */
  readonly launchIDs: readonly string[]
}

/** A node with what the matcher needs besides its own report. */
export interface Candidate extends PlacementNode {
  /** The machine has a connected service spoke announcing the "launch" feature (needed for host launches). */
  readonly launchService: boolean
  /** Slots taken by launches placed on it that the node does not report yet. */
  readonly reserved: number
}

export type Match =
  | { readonly ok: true; readonly node: PlacementNode; readonly preferred: boolean }
  | { readonly ok: false; readonly wait: "capacity" | "no_match"; readonly reason: string }

const label = (node: PlacementNode) => node.name ?? node.machineID

const underRoot = (repo: string, root: string): boolean => {
  const base = root.replace(/\/+$/, "")
  return repo === base || repo.startsWith(`${base}/`)
}

/** Why the node can never take the launch as it is now (undefined: it can, given a free slot). */
function hardProblem(spec: LaunchSpec, node: Candidate): string | undefined {
  if (node.draining) return "is draining"
  const kind = spec.runtime.kind
  const runtime = node.runtimes.find((r) => r.kind === kind)
  if (!runtime) return `has no ${kind} runtime`
  if ((kind === "host" || runtime.harnesses !== undefined) && !runtime.harnesses?.includes(spec.harness)) return `has no ${spec.harness} harness`
  if (spec.runtime.profile !== undefined && !runtime.profiles?.includes(spec.runtime.profile)) return `has no ${spec.runtime.profile} profile`
  if (!node.workspaceRoots.some((root) => underRoot(spec.workspace.repo, root))) return `does not serve ${spec.workspace.repo}`
  if (kind === "host" && !node.launchService) return "has no connected service spoke with launch"
  return undefined
}

/** Why the node does not match the placement's machine and labels (undefined: it does). */
function placementProblem(spec: LaunchSpec, node: PlacementNode): string | undefined {
  const { machine, labels } = spec.placement
  if (machine !== undefined && machine !== node.machineID && machine !== node.name) return `is not ${machine}`
  for (const [key, value] of Object.entries(labels)) if (node.labels[key] !== value) return `lacks label ${key}=${value}`
  return undefined
}

const freeSlots = (node: Candidate) => node.capacity.slots - node.used.slots - node.reserved

/** Picks the user's node for a launch from a snapshot of candidates, or says why it must wait. Pure. */
export function matchNode(userID: string, spec: LaunchSpec, candidates: readonly Candidate[]): Match {
  const own = candidates.filter((node) => node.owner === userID)
  if (own.length === 0) return { ok: false, wait: "no_match", reason: "No node is connected" }
  const require = spec.placement.mode === "require"
  const problems: string[] = []
  const full: Candidate[] = []
  const free: { node: Candidate; preferred: boolean }[] = []
  for (const node of own) {
    const placement = placementProblem(spec, node)
    const problem = hardProblem(spec, node) ?? (require ? placement : undefined)
    if (problem) problems.push(`${label(node)} ${problem}`)
    else if (freeSlots(node) <= 0) full.push(node)
    else free.push({ node, preferred: placement === undefined })
  }
  if (free.length > 0) {
    free.sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) ||
        freeSlots(b.node) - freeSlots(a.node) ||
        (a.node.machineID < b.node.machineID ? -1 : a.node.machineID > b.node.machineID ? 1 : 0),
    )
    const best = free[0]!
    return { ok: true, node: best.node, preferred: best.preferred }
  }
  if (full.length > 0) return { ok: false, wait: "capacity", reason: `Waiting for a free slot on ${full.map(label).join(", ")}` }
  return { ok: false, wait: "no_match", reason: `No node fits: ${problems.join("; ")}` }
}


// ---- admission and the placement pass ---------------------------------------------------------------------

/** Per-user launch caps (hub.json agents.launches). */
export interface LaunchCaps {
  /** Launches waiting to be placed. */
  readonly maxQueued: number
  /** Launches placed and not ended (placing, provisioning, running). */
  readonly maxActive: number
  /** New launches per clock hour. */
  readonly perHour: number
}

export const DEFAULT_LAUNCH_CAPS: LaunchCaps = { maxQueued: 50, maxActive: 4, perHour: 60 }
export const PLACEMENT_LEASE_MS = 15_000
const HOUR_MS = 3_600_000
/** retryAfter (seconds) when the queue is full: placement frees it as nodes do. */
const QUEUE_RETRY_S = 60
const ACTIVE: readonly LaunchState[] = ["placing", "provisioning", "running"]

/** The user's connected nodes (the launch engine adapts the NodeRegistry). */
export interface PlacementNodes {
  nodes(userID: string): readonly PlacementNode[] | Promise<readonly PlacementNode[]>
}

/** The service spokes (the launch engine adapts the Registry). */
export interface PlacementSpokes {
  /** Whether the machine has a connected service spoke announcing the "launch" feature. */
  launchService(userID: string, machineID: string): boolean | Promise<boolean>
}

export interface PlacementDeps {
  readonly store: LaunchStore
  readonly nodes: PlacementNodes
  readonly spokes: PlacementSpokes
  readonly counters: Counters
  readonly locks: Locks
  /** This process (pod) as lease owner. */
  readonly owner: string
  readonly caps?: HubLaunches
  readonly now?: Clock
  readonly leaseMs?: number
}

/** A launch the pass placed: it is now provisioning on the node's machine. */
export interface Placed {
  readonly userID: string
  readonly launch: Launch
  readonly node: PlacementNode
  readonly preferred: boolean
  /** The placement lease's fencing token for this pass. */
  readonly fence: number
}

export interface Waiting {
  readonly launchID: string
  /** capacity: a fitting node is full; no_match: no node fits; active: the user's maxActive is reached. */
  readonly wait: "capacity" | "no_match" | "active"
  readonly reason: string
}

/** One pass. leased false: another holder has the user's lease, or it was lost mid-pass (placed: before that). */
export interface PassResult {
  readonly leased: boolean
  readonly placed: Placed[]
  readonly waiting: Waiting[]
}

export const placementLeaseKey = (userID: string) => `placement:${userID}`

export class Placement {
  readonly caps: LaunchCaps
  private readonly now: Clock
  private readonly leaseMs: number

  constructor(private readonly deps: PlacementDeps) {
    this.caps = { ...DEFAULT_LAUNCH_CAPS, ...deps.caps }
    this.now = deps.now ?? Date.now
    this.leaseMs = deps.leaseMs ?? PLACEMENT_LEASE_MS
  }

  /** Throws rate_limited when the user may not add a launch now (maxQueued, perHour). Consumes nothing. */
  async admit(userID: string): Promise<void> {
    const queued = (await this.deps.store.list(userID, { states: ["queued"] })).length
    if (queued >= this.caps.maxQueued) {
      throw new AgentError("rate_limited", `${queued} launches are queued (the most per user)`, {
        hint: "Wait for queued launches to be placed, or stop some",
        extra: { retryAfter: QUEUE_RETRY_S },
      })
    }
    const { key, endsAt } = this.hour(userID)
    const count = await this.deps.counters.get(key)
    if (count >= this.caps.perHour) {
      throw new AgentError("rate_limited", `${count} launches this hour (the most per user)`, {
        extra: { retryAfter: Math.ceil((endsAt - this.now()) / 1000) },
      })
    }
  }

  /** Counts a new launch against perHour (call it when the store created one, not for an idempotent retry). */
  async recordLaunch(userID: string): Promise<void> {
    const { key, endsAt } = this.hour(userID)
    await this.deps.counters.incr(key, endsAt - this.now())
  }

  /** One placement pass for the user under the user's lease: queued launches in order onto fitting nodes. */
  async place(userID: string): Promise<PassResult> {
    const { locks, owner, store } = this.deps
    const key = placementLeaseKey(userID)
    const lease = await locks.acquire(key, owner, this.leaseMs)
    const placed: Placed[] = []
    const waiting: Waiting[] = []
    if (!lease) return { leased: false, placed, waiting }
    const held = async () => (await locks.renew(key, owner, this.leaseMs))?.fence === lease.fence
    const lost = (): PassResult => ({ leased: false, placed, waiting: [] })
    try {
      let launches = await store.list(userID)
      // Under the lease, a launch still placing was left by a holder that died mid-pass.
      for (const launch of launches.filter((l) => l.state === "placing")) {
        if (!(await held())) return lost()
        await skipGone(store.transition(userID, launch.id, "queued", { reason: "Placement interrupted; queued again", from: ["placing"] }))
      }
      launches = await store.list(userID)
      const queued = launches.filter((l) => l.state === "queued")
      if (queued.length === 0) return { leased: true, placed, waiting }
      let active = launches.filter((l) => ACTIVE.includes(l.state)).length
      const candidates = await this.candidates(userID, launches)
      for (const launch of queued) {
        if (active >= this.caps.maxActive) {
          waiting.push({ launchID: launch.id, wait: "active", reason: `Waiting: ${active} launches are active (the most per user)` })
          continue
        }
        const match = matchNode(userID, launch.spec, candidates)
        if (!match.ok) {
          waiting.push({ launchID: launch.id, wait: match.wait, reason: match.reason })
          continue
        }
        const name = match.node.name ?? match.node.machineID
        if (!(await held())) return lost()
        const placing = await skipGone(store.transition(userID, launch.id, "placing", { reason: `Placing on ${name}`, from: ["queued"] }))
        if (!placing) continue
        if (!(await held())) return lost()
        const provisioning = await store.transition(userID, launch.id, "provisioning", {
          reason: `Placed on ${name}${match.preferred ? "" : " (preferred placement not available)"}`,
          machineID: match.node.machineID,
          from: ["placing"],
        })
        const index = candidates.findIndex((c) => c.machineID === match.node.machineID)
        candidates[index] = { ...candidates[index]!, reserved: candidates[index]!.reserved + 1 }
        active++
        placed.push({ userID, launch: provisioning, node: match.node, preferred: match.preferred, fence: lease.fence })
      }
      return { leased: true, placed, waiting }
    } finally {
      await locks.release(key, owner)
    }
  }

  /** The user's nodes with their service spoke and reservations (placed launches the node does not report yet). */
  private async candidates(userID: string, launches: readonly Launch[]): Promise<Candidate[]> {
    const nodes = (await this.deps.nodes.nodes(userID)).filter((node) => node.owner === userID)
    return Promise.all(
      nodes.map(async (node) => ({
        ...node,
        launchService: await this.deps.spokes.launchService(userID, node.machineID),
        reserved: launches.filter((l) => l.machineID === node.machineID && ACTIVE.includes(l.state) && !node.launchIDs.includes(l.id)).length,
      })),
    )
  }

  private hour(userID: string): { key: string; endsAt: number } {
    const bucket = Math.floor(this.now() / HOUR_MS)
    return { key: `launches:hour:${userID}:${bucket}`, endsAt: (bucket + 1) * HOUR_MS }
  }
}

/** A step that lost a race with the launch ending (or moving on): undefined, not an error. */
async function skipGone<T>(step: Promise<T>): Promise<T | undefined> {
  try {
    return await step
  } catch (cause) {
    if (cause instanceof LaunchTransitionError) return undefined
    throw cause
  }
}


// ---- the loop ---------------------------------------------------------------------------------------------

export const PLACEMENT_SWEEP_MS = 5_000

export interface PlacementLoopDeps {
  readonly placement: Pick<Placement, "place">
  /** The users that may have launches to place (e.g. the store's users). */
  readonly users: () => Promise<readonly string[]>
  /** The engine takes a placed (provisioning) launch from here. */
  readonly onPlaced: (placed: Placed) => void | Promise<void>
  readonly onError?: (cause: unknown, userID?: string) => void
  readonly timers?: Timers
  readonly intervalMs?: number
}

const defaultTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

/** Runs placement passes: on kick(user) (a launch queued or ended, a node's capacity changed) and on a sweep. */
export class PlacementLoop {
  private readonly runs = new Map<string, { again: boolean; done: Promise<void> }>()
  private readonly timers: Timers
  private readonly intervalMs: number
  private readonly onError: (cause: unknown, userID?: string) => void
  private timer: unknown
  private running = false

  constructor(private readonly deps: PlacementLoopDeps) {
    this.timers = deps.timers ?? defaultTimers
    this.intervalMs = deps.intervalMs ?? PLACEMENT_SWEEP_MS
    this.onError = deps.onError ?? ((cause, userID) => console.error(`[hub] placement failed${userID ? ` for ${userID}` : ""}:`, cause))
  }

  /** A pass for the user; a kick during a pass makes one more pass after it. Resolves when they are done. */
  kick(userID: string): Promise<void> {
    const current = this.runs.get(userID)
    if (current) {
      current.again = true
      return current.done
    }
    const run = { again: false, done: Promise.resolve() }
    this.runs.set(userID, run)
    run.done = (async () => {
      try {
        do {
          run.again = false
          await this.pass(userID)
        } while (run.again)
      } finally {
        this.runs.delete(userID)
      }
    })()
    return run.done
  }

  /** Sweeps every intervalMs (idempotent). */
  start(): void {
    this.running = true
    if (this.timer === undefined) this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }

  /** A pass for every user, one after another. */
  async sweep(): Promise<void> {
    let users: readonly string[]
    try {
      users = await this.deps.users()
    } catch (cause) {
      this.onError(cause)
      return
    }
    for (const userID of users) await this.kick(userID)
  }

  private schedule(): void {
    this.timer = this.timers.set(() => {
      this.timer = undefined
      void this.sweep().finally(() => {
        if (this.running && this.timer === undefined) this.schedule()
      })
    }, this.intervalMs)
  }

  private async pass(userID: string): Promise<void> {
    let result: PassResult
    try {
      result = await this.deps.placement.place(userID)
    } catch (cause) {
      this.onError(cause, userID)
      return
    }
    for (const placed of result.placed) {
      try {
        await this.deps.onPlaced(placed)
      } catch (cause) {
        this.onError(cause, userID)
      }
    }
  }
}
