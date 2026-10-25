// Placement (design §6.2, §9; decision znbg8xa5): which of the user's nodes takes a launch.
// - matchNode is pure: over a snapshot of candidates it applies the hard constraints (the user's own machines only,
//   not draining, the runtime kind, the harness (host: always; other runtimes when they list harnesses), the
//   runtime profile, the workspace under one of the node's roots, and for host launches a connected service spoke
//   announcing "launch"), then the placement's machine and labels (mode require: hard; prefer: ranking only), then
//   free slots (capacity minus used minus reservations). The best node has the preference, then most free slots,
//   then the lowest machine ID. A launch that cannot be placed waits for capacity (a fitting node is full) or for a
//   match (no node fits; the reason names each node's first problem).
import type { NodeCapacity, NodeRuntimeInfo } from "../../protocol"
import type { LaunchSpec } from "./launch-spec"

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
