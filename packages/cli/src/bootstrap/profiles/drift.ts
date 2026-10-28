// Managed-field drift detection. Hub owns exactly the fields its plans set: each merge-config pointer, its mcp
// registration, and the files it writes (write-file, install-service). Nothing else in a config is hub's.
//
// For each managed field, detection compares three states:
//   applied   what the last apply set: the applied plan's value, counted only when its journal entry is "done"
//   desired   what the fresh plan (for the current profile) sets
//   current   what is there: the snapshot's file digests, plus observed values for config fields. When a file's
//             digest still equals what the journal says hub left, the applied values are known to be current.
// and gives one status:
//   in-sync       current equals desired
//   missing       absent and hub never set it: hub may set it
//   outdated      still exactly hub's applied value, but hub now wants another: hub may update it
//   user-changed  anything else (changed, removed, or a value the user had before hub): reported, never overwritten
//   retired       hub set it before but no longer manages it: left in place, reported
//   unobserved    the current state is unknown (no observation, file not discovered): reported, never repaired
//
// detectDrift is pure and never writes. Reports carry digests of current values, never the values themselves, so a
// user's secret in a field hub happens to manage cannot leak into a report. driftRepairs turns a report into the
// minimal lossless actions for the repairable fields only, pinned to the file's current digest.
import {
  canonicalJSON,
  Checker,
  digestOf,
  ok,
  planDigest,
  resolvePathRef,
  validateDiscoverySnapshot,
  validateJournal,
  validateSetupPlan,
  type Action,
  type DiscoverySnapshot,
  type FileState,
  type HarnessID,
  type Json,
  type PathRef,
  type Precondition,
  type Result,
  type SetupPlan,
  type TransactionJournal,
} from "../contracts/index.ts"

export type ManagedFieldType = "config-value" | "array-entry" | "mcp-registration" | "file"

/** One field hub owns, as a plan sets it. */
export interface ManagedField {
  /** "<root>:<rel>#<pointer>" for config fields, "<root>:<rel>" for files, "mcp:<harness>/<name>" for registrations. */
  readonly key: string
  readonly type: ManagedFieldType
  readonly actionID: string
  readonly path: PathRef
  /** Config fields: the RFC 6901 pointer as the plan sets it ("/x/-" appends to the array at "/x"). */
  readonly pointer?: string
  /** Config fields: the value hub sets. */
  readonly value?: Json
  /** Files: the content digest hub writes. */
  readonly sha256?: string
  readonly registration?: { readonly harness: HarnessID; readonly name: string }
}

export type DriftStatus = "in-sync" | "missing" | "outdated" | "user-changed" | "retired" | "unobserved"

export interface FieldDrift {
  readonly key: string
  readonly actionID: string
  readonly path: PathRef
  readonly pointer?: string
  readonly status: DriftStatus
  /** Whether hub may change it (missing, or outdated and replaceable by a set). */
  readonly repairable: boolean
  /** Digest of the current value or file; null when absent; omitted when unobserved. Never the value itself. */
  readonly currentDigest?: string | null
}

export interface DriftReport {
  /** Desired fields in plan order, then retired ones. */
  readonly fields: readonly FieldDrift[]
  /** The fields the user changed: reported, never overwritten. */
  readonly userChanged: readonly FieldDrift[]
  /** Files hub wrote that changed since (by anyone; user edits to unmanaged fields show up only here). */
  readonly changedSinceApply: readonly PathRef[]
  readonly inSync: boolean
  /** Always zero: detection never writes. */
  readonly writes: 0
}

/**
 * What a reader saw (data, read by the caller; this module never reads). For an append pointer ("/plugin/-"),
 * observe the array it appends to ("/plugin").
 */
export type ObservedField =
  | { readonly path: PathRef; readonly pointer: string; readonly state: "absent" }
  | { readonly path: PathRef; readonly pointer: string; readonly state: "value"; readonly value: Json }

export interface ObservedRegistration {
  readonly harness: HarnessID
  readonly name: string
  /** ours: this hubctl's mcp subcommand. foreign: a server with that name that is not hubctl's. */
  readonly state: "ours" | "absent" | "foreign"
}

export interface Observation {
  readonly fields?: readonly ObservedField[]
  readonly registrations?: readonly ObservedRegistration[]
}

export interface DriftInput {
  /** The plan for the current profile and snapshot. */
  readonly desired: SetupPlan
  readonly snapshot: DiscoverySnapshot
  /** The last apply: its plan and journal (only entries that are "done" count as hub's). */
  readonly applied?: { readonly plan: SetupPlan; readonly journal: TransactionJournal }
  readonly observed?: Observation
}

const pathKey = (p: PathRef) => `${p.root}:${p.rel}`
const samePath = (a: PathRef, b: PathRef) => a.root === b.root && a.rel === b.rel
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b)

/** Every field a plan sets, in plan order. */
export function managedFields(plan: SetupPlan): ManagedField[] {
  return plan.actions.flatMap((action): ManagedField[] => {
    switch (action.kind) {
      case "merge-config":
        return action.set.map((s) => ({
          key: `${pathKey(action.path)}#${s.pointer}`,
          type: s.pointer.endsWith("/-") ? "array-entry" : "config-value",
          actionID: action.id,
          path: action.path,
          pointer: s.pointer,
          value: s.value,
        }))
      case "register-mcp-server":
        return [{ key: `mcp:${action.harness}/${action.name}`, type: "mcp-registration", actionID: action.id, path: action.path, registration: { harness: action.harness, name: action.name } }]
      case "write-file":
      case "install-service":
        return [{ key: pathKey(action.path), type: "file", actionID: action.id, path: action.path, sha256: action.sha256 }]
      default:
        return []
    }
  })
}

/** The file's digest as discovered: null when it does not exist, undefined when discovery did not look at it. */
function discoveredDigest(snapshot: DiscoverySnapshot, path: PathRef): string | null | undefined {
  const abs = resolvePathRef(path, snapshot.roots)
  if (!abs.ok) return undefined
  const found = snapshot.configs.find((c) => c.path === abs.value)
  return found ? found.sha256 : undefined
}

function validate(input: DriftInput): Result<DriftInput> {
  const c = new Checker()
  c.merge("/desired", validateSetupPlan(input.desired))
  c.merge("/snapshot", validateDiscoverySnapshot(input.snapshot))
  if (input.applied) {
    c.merge("/applied/plan", validateSetupPlan(input.applied.plan))
    c.merge("/applied/journal", validateJournal(input.applied.journal))
  }
  if (c.issues.length > 0) return c.result(input)
  const host = input.snapshot.host.fingerprint
  if (input.desired.hostFingerprint !== host) c.add("/desired/hostFingerprint", "inconsistent", "the plan is for another host")
  if (input.applied) {
    if (input.applied.journal.hostFingerprint !== host || input.applied.plan.hostFingerprint !== host) c.add("/applied/journal/hostFingerprint", "inconsistent", "that history is another host's")
    if (input.applied.journal.planDigest !== planDigest(input.applied.plan)) c.add("/applied/journal/planDigest", "inconsistent", "the journal records another plan")
  }
  return c.result(input)
}

type Current = { readonly known: false } | { readonly known: true; readonly absent: true } | { readonly known: true; readonly absent: false; readonly value: Json }
const UNKNOWN: Current = { known: false }
const ABSENT: Current = { known: true, absent: true }
const present = (value: Json): Current => ({ known: true, absent: false, value })

export function detectDrift(input: DriftInput): Result<DriftReport> {
  const checked = validate(input)
  if (!checked.ok) return checked
  const { desired, snapshot, observed = {} } = input

  // Hub's applied fields: only actions whose journal entry is done.
  const done = new Set((input.applied?.journal.entries ?? []).filter((e) => e.status === "done").map((e) => e.actionID))
  const applied = new Map<string, ManagedField>()
  if (input.applied) for (const f of managedFields(input.applied.plan)) if (done.has(f.actionID)) applied.set(f.key, f)

  // What hub left in each file (the newest done entry per path).
  const left = new Map<string, { path: PathRef; after: FileState }>()
  for (const e of input.applied?.journal.entries ?? []) if (e.status === "done" && e.path && e.after) left.set(pathKey(e.path), { path: e.path, after: e.after })
  const untouched = (path: PathRef) => {
    const was = left.get(pathKey(path))
    const now = discoveredDigest(snapshot, path)
    return was !== undefined && now !== undefined && (was.after.exists ? now === was.after.sha256 : now === null)
  }
  const changedSinceApply = [...left.values()].filter(({ path }) => discoveredDigest(snapshot, path) !== undefined && !untouched(path)).map(({ path }) => path)

  const observedAt = (path: PathRef, pointer: string): Current => {
    const o = observed.fields?.find((f) => samePath(f.path, path) && f.pointer === pointer)
    if (!o) return UNKNOWN
    return o.state === "absent" ? ABSENT : present(o.value)
  }

  const judge = (f: ManagedField, a: ManagedField | undefined): Omit<FieldDrift, "key" | "actionID" | "path" | "pointer"> => {
    const userOr = (missing: boolean, currentDigest: string | null) => (missing ? { status: "missing" as const, repairable: true, currentDigest } : { status: "user-changed" as const, repairable: false, currentDigest })
    switch (f.type) {
      case "file": {
        const now = discoveredDigest(snapshot, f.path)
        if (now === undefined) return { status: "unobserved", repairable: false }
        if (now === f.sha256) return { status: "in-sync", repairable: false, currentDigest: now }
        if (a && now === a.sha256) return { status: "outdated", repairable: true, currentDigest: now }
        return userOr(now === null && !a, now)
      }
      case "config-value": {
        let cur = observedAt(f.path, f.pointer!)
        if (!cur.known && a && untouched(f.path)) cur = present(a.value!)
        if (!cur.known) return { status: "unobserved", repairable: false }
        if (cur.absent) return userOr(!a, null)
        const currentDigest = digestOf(cur.value)
        if (same(cur.value, f.value)) return { status: "in-sync", repairable: false, currentDigest }
        if (a && same(cur.value, a.value)) return { status: "outdated", repairable: true, currentDigest }
        return { status: "user-changed", repairable: false, currentDigest }
      }
      case "array-entry": {
        let cur = observedAt(f.path, f.pointer!.slice(0, -2))
        if (!cur.known && a && untouched(f.path)) cur = present([a.value!])
        if (!cur.known) return { status: "unobserved", repairable: false }
        if (cur.absent) return userOr(!a, null)
        const currentDigest = digestOf(cur.value)
        if (!Array.isArray(cur.value)) return { status: "user-changed", repairable: false, currentDigest }
        const has = (v: unknown) => (cur.value as Json[]).some((item) => same(item, v))
        if (has(f.value)) return { status: "in-sync", repairable: false, currentDigest }
        // An append cannot replace hub's older entry, so an outdated entry is reported, not appended next to it.
        if (a && has(a.value)) return { status: "outdated", repairable: false, currentDigest }
        return userOr(!a, currentDigest)
      }
      case "mcp-registration": {
        const reg = f.registration!
        const o = observed.registrations?.find((r) => r.harness === reg.harness && r.name === reg.name)
        const state = o?.state ?? (a && untouched(f.path) ? "ours" : undefined)
        if (state === undefined) return { status: "unobserved", repairable: false }
        if (state === "ours") return { status: "in-sync", repairable: false, currentDigest: digestOf(state) }
        return userOr(state === "absent" && !a, digestOf(state))
      }
    }
  }

  const describe = (f: ManagedField) => ({ key: f.key, actionID: f.actionID, path: f.path, ...(f.pointer !== undefined ? { pointer: f.pointer } : {}) })
  const wanted = managedFields(desired)
  const fields: FieldDrift[] = [
    ...wanted.map((f) => ({ ...describe(f), ...judge(f, applied.get(f.key)) })),
    ...[...applied.values()].filter((a) => !wanted.some((f) => f.key === a.key)).map((a): FieldDrift => ({ ...describe(a), status: "retired", repairable: false })),
  ]
  return ok({ fields, userChanged: fields.filter((f) => f.status === "user-changed"), changedSinceApply, inSync: fields.every((f) => f.status === "in-sync"), writes: 0 })
}

/** The file's current state as a merge precondition, or undefined when discovery did not see the file. */
function preconditionNow(snapshot: DiscoverySnapshot, path: PathRef): Precondition | undefined {
  const now = discoveredDigest(snapshot, path)
  if (now === undefined) return undefined
  return now === null ? { exists: false } : { exists: true, sha256: now }
}

/**
 * The actions that bring hub's repairable fields back to the desired state, and nothing else: a merge sets only
 * its repairable pointers (losslessly, pinned to the file's current digest), a registration or file is redone only
 * when it is repairable. Fields the user changed are never in it.
 */
export function driftRepairs(report: DriftReport, desired: SetupPlan, snapshot: DiscoverySnapshot): Action[] {
  const repairable = new Set(report.fields.filter((f) => f.repairable).map((f) => f.key))
  return desired.actions.flatMap((action): Action[] => {
    const fields = managedFields({ ...desired, actions: [action] })
    switch (action.kind) {
      case "merge-config": {
        const set = action.set.filter((_, i) => repairable.has(fields[i]!.key))
        const precondition = preconditionNow(snapshot, action.path)
        return set.length > 0 && precondition ? [{ ...action, set, precondition }] : []
      }
      case "register-mcp-server": {
        const precondition = preconditionNow(snapshot, action.path)
        return repairable.has(fields[0]!.key) && precondition ? [{ ...action, precondition }] : []
      }
      case "write-file":
      case "install-service":
        return repairable.has(fields[0]!.key) ? [action] : []
      default:
        return []
    }
  })
}
