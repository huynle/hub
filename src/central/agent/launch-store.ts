// Launches per user (design §6.1, §9; decision znbg8xa5), stored in the StateStore collection "launches" under
// their id. The launch engine (P4-T8) drives them; this module owns the records, the state machine and idempotency.
// - States: queued → placing → provisioning → running → ended{outcome}. placing may fall back to queued (no node
//   could take it yet); every live state may end; ended is final. Each step records its reason and time (history,
//   bounded: the first step and the latest ones). An illegal step throws LaunchTransitionError (code gone when the
//   launch already ended, else invalid) and changes nothing; writes are version-checked, so of two racing steps
//   only one applies.
// - provisioning needs the machine, running the session; ended needs an outcome (idle, needs_user, failed,
//   timeout, stopped, lost), and only ended may carry one.
// - Idempotency: a spec with a key claims it in the StateStore (namespace `launch-keys:<userID>`, owner the launch
//   id) before the launch is stored. The same key with an equivalent body returns the existing launch (even an
//   ended one, until it is pruned); a different body is invalid with a hint. A claim whose launch never appeared
//   (its creator crashed) blocks the key for RESERVATION_MS, then is taken over.
// - Pruning: ended launches older than endedKeepMs, and all but the newest endedMax ended ones, are removed and
//   their keys released. Live launches are never pruned.
import { randomBytes } from "node:crypto"
import type { Clock, StateStore } from "../backend/types"
import { AgentError } from "./errors"
import { type LaunchSpec, launchBodyKey } from "./launch-spec"
import { updateVersioned } from "./versioned"

export const LAUNCHES = "launches"
export const REASON_MAX = 500
export const HISTORY_MAX = 20
export const ENDED_KEEP_MS = 7 * 86_400_000
export const ENDED_MAX = 500
/** How long a key claim without its launch (a creator that may still be writing) blocks the key. */
export const RESERVATION_MS = 60_000
/** Reads of a key holder's launch: its creator may be between the claim and the write, so a miss is re-read. */
const READS = 5
/** Claim attempts (a stale claim is taken over between them). */
const CLAIMS = 3

export const LAUNCH_STATES = ["queued", "placing", "provisioning", "running", "ended"] as const
export type LaunchState = (typeof LAUNCH_STATES)[number]
export const LAUNCH_OUTCOMES = ["idle", "needs_user", "failed", "timeout", "stopped", "lost"] as const
export type LaunchOutcome = (typeof LAUNCH_OUTCOMES)[number]

/** The states each state may move to. */
const NEXT: Record<LaunchState, readonly LaunchState[]> = {
  queued: ["placing", "ended"],
  placing: ["provisioning", "queued", "ended"],
  provisioning: ["running", "ended"],
  running: ["ended"],
  ended: [],
}

export interface LaunchStep {
  readonly state: LaunchState
  readonly reason: string
  readonly at: number
  readonly outcome?: LaunchOutcome
}

export interface Launch {
  readonly id: string
  /** The user it belongs to. */
  readonly owner: string
  readonly spec: LaunchSpec
  /** Who launched it, as the caller describes them (e.g. `app:<token id>`, `ses_…`, `user`). */
  readonly by?: string
  readonly state: LaunchState
  readonly reason: string
  /** When it entered its state. */
  readonly at: number
  readonly outcome?: LaunchOutcome
  readonly machineID?: string
  readonly sessionID?: string
  readonly name?: string
  readonly artifacts?: Readonly<Record<string, unknown>>
  readonly created: number
  readonly history: readonly LaunchStep[]
}

export interface TransitionInput {
  readonly reason: string
  readonly outcome?: LaunchOutcome
  readonly machineID?: string
  readonly sessionID?: string
  readonly name?: string
  readonly artifacts?: Readonly<Record<string, unknown>>
  /** Apply only when the launch is in one of these states (else LaunchTransitionError). */
  readonly from?: readonly LaunchState[]
}

export interface LaunchFilter {
  /** Every label must match the spec's. */
  readonly labels?: Readonly<Record<string, string>>
  readonly states?: readonly LaunchState[]
}

export interface LaunchStoreDeps {
  readonly state: StateStore
  readonly now?: Clock
  readonly newID?: () => string
  readonly endedKeepMs?: number
  readonly endedMax?: number
}

/** A step the state machine does not allow (or not from the current state); the launch is unchanged. */
export class LaunchTransitionError extends AgentError {
  constructor(
    readonly from: LaunchState,
    readonly to: LaunchState,
  ) {
    super(from === "ended" ? "gone" : "invalid", from === "ended" ? "The launch already ended" : `A launch cannot go from ${from} to ${to}`)
    this.name = "LaunchTransitionError"
  }
}

/** Control characters become spaces; trimmed and bounded. */
const cleanReason = (reason: unknown): string => {
  const text = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, REASON_MAX).trim() : ""
  if (!text) throw new Error("A launch transition needs a reason")
  return text
}

/** The first step (how it began) and the latest ones. */
const bounded = (history: readonly LaunchStep[]): LaunchStep[] =>
  history.length <= HISTORY_MAX ? [...history] : [history[0]!, ...history.slice(history.length - HISTORY_MAX + 1)]

const byCreation = (a: Launch, b: Launch) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class LaunchStore {
  private readonly now: Clock
  private readonly newID: () => string
  private readonly endedKeepMs: number
  private readonly endedMax: number

  constructor(private readonly deps: LaunchStoreDeps) {
    this.now = deps.now ?? Date.now
    this.newID = deps.newID ?? (() => `l_${randomBytes(8).toString("hex")}`)
    this.endedKeepMs = deps.endedKeepMs ?? ENDED_KEEP_MS
    this.endedMax = deps.endedMax ?? ENDED_MAX
  }

  /**
   * Stores a new queued launch, or (same key, equivalent body) returns the existing one with created false.
   * Throws invalid (key reused with another body) or rate_limited (the key's launch is still being created).
   */
  async create(userID: string, spec: LaunchSpec, options: { readonly by?: string } = {}): Promise<{ launch: Launch; created: boolean }> {
    const id = this.newID()
    if (spec.key !== undefined) {
      const existing = await this.claimKey(userID, spec.key, id)
      if (existing) {
        if (launchBodyKey(existing.spec) !== launchBodyKey(spec)) {
          throw new AgentError("invalid", `Launch key ${spec.key} was used for a different launch (${existing.id})`, {
            hint: "Use a new key for a different launch, or resend the original body to get that launch",
          })
        }
        return { launch: existing, created: false }
      }
    }
    const at = this.now()
    const launch: Launch = {
      id,
      owner: userID,
      spec,
      ...(options.by !== undefined ? { by: options.by } : {}),
      state: "queued",
      reason: "Queued",
      at,
      created: at,
      history: [{ state: "queued", reason: "Queued", at }],
    }
    const written = await this.deps.state.put(userID, LAUNCHES, id, launch, { ifVersion: 0 })
    if (!written.ok) throw new Error(`launch id ${id} already exists`)
    return { launch, created: true }
  }

  async get(userID: string, id: string): Promise<Launch | undefined> {
    return (await this.deps.state.get<Launch>(userID, LAUNCHES, id))?.value
  }

  /** The user's launches by creation, filtered. */
  async list(userID: string, filter: LaunchFilter = {}): Promise<Launch[]> {
    const launches = (await this.deps.state.list<Launch>(userID, LAUNCHES)).map((entry) => entry.value)
    return launches
      .filter((launch) => !filter.states || filter.states.includes(launch.state))
      .filter((launch) => !filter.labels || Object.entries(filter.labels).every(([key, value]) => launch.spec.labels[key] === value))
      .sort(byCreation)
  }

  /** Moves the launch to `to`; throws not_found, LaunchTransitionError, or Error for a malformed step. */
  async transition(userID: string, id: string, to: LaunchState, input: TransitionInput): Promise<Launch> {
    const reason = cleanReason(input.reason)
    const at = this.now()
    const next = await updateVersioned<Launch>(this.deps.state, userID, LAUNCHES, id, (current) => {
      if (!current) throw new AgentError("not_found", `No launch ${id}`)
      if (!NEXT[current.state].includes(to) || (input.from && !input.from.includes(current.state))) throw new LaunchTransitionError(current.state, to)
      checkDetails(to, input)
      const step: LaunchStep = { state: to, reason, at, ...(input.outcome !== undefined ? { outcome: input.outcome } : {}) }
      return {
        ...current,
        state: to,
        reason,
        at,
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.machineID !== undefined ? { machineID: input.machineID } : {}),
        ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
        history: bounded([...current.history, step]),
      }
    })
    return next!
  }

  /** Removes ended launches past endedKeepMs or beyond the newest endedMax; resolves with the removed ids. */
  async prune(userID: string): Promise<string[]> {
    const { state } = this.deps
    const ended = (await state.list<Launch>(userID, LAUNCHES)).filter((entry) => entry.value.state === "ended")
    ended.sort((a, b) => b.value.at - a.value.at || byCreation(b.value, a.value))
    const cutoff = this.now() - this.endedKeepMs
    const removed: string[] = []
    for (const [index, entry] of ended.entries()) {
      if (index < this.endedMax && entry.value.at > cutoff) continue
      const deleted = await state.delete(userID, LAUNCHES, entry.key, { ifVersion: entry.version })
      if (!deleted.ok) continue
      if (entry.value.spec.key !== undefined) await state.release(keyNamespace(userID), entry.value.spec.key, entry.value.id)
      removed.push(entry.value.id)
    }
    return removed
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private async launchOf(userID: string, id: string): Promise<Launch | undefined> {
    for (let read = 0; read < READS; read++) {
      const launch = await this.get(userID, id)
      if (launch) return launch
    }
    return undefined
  }

  /** Claims the key for `id`: undefined when claimed (create it), else the launch that holds it. */
  private async claimKey(userID: string, key: string, id: string): Promise<Launch | undefined> {
    const { state } = this.deps
    const namespace = keyNamespace(userID)
    for (let attempt = 0; attempt < CLAIMS; attempt++) {
      const claimed = await state.claim(namespace, key, id)
      if (claimed.ok) return undefined
      const holder = claimed.conflict
      const existing = await this.launchOf(userID, holder.owner)
      if (existing) return existing
      if (this.now() - holder.at < RESERVATION_MS) {
        throw new AgentError("rate_limited", `Launch key ${key} is being created`, { extra: { retryAfter: 1 } })
      }
      // Its creator crashed between the claim and the write: take the key over.
      await state.release(namespace, key, holder.owner)
    }
    throw new AgentError("rate_limited", `Launch key ${key} is contended`, { extra: { retryAfter: 1 } })
  }
}

const keyNamespace = (userID: string) => `launch-keys:${userID}`

function checkDetails(to: LaunchState, input: TransitionInput): void {
  if (to === "ended") {
    if (!LAUNCH_OUTCOMES.includes(input.outcome as LaunchOutcome)) throw new Error(`Ending a launch needs an outcome: ${LAUNCH_OUTCOMES.join(", ")}`)
  } else if (input.outcome !== undefined) throw new Error("Only an ended launch has an outcome")
  if (to === "provisioning" && !input.machineID) throw new Error("Provisioning a launch needs its machine")
  if (to === "running" && !input.sessionID) throw new Error("A running launch needs its session")
}
