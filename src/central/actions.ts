// The shared action executor (design §5, §11.4): answer a permission or form, prompt a session (steer while its
// tree runs, else a locked turn) and stop it. The console routes and the agent act verbs both call these; each
// returns an outcome instead of an HTTP response, so every caller maps it to its own errors (the console answers
// gone with 409, the agent API with 410) and adds its own checks (grants, audit) around the same execution.
import type { FormAnswer, PermissionDecision, PromptImage, ResultFor, TurnResult } from "../protocol"
import { randomUUID } from "node:crypto"
import { MemoryKv } from "./backend/memory-kv"
import type { Kv, Locks } from "./backend/types"
import { BusyError, type Registry } from "./registry"
import type { SpokeHub } from "./spoke-ws"

/** The registry calls the executor needs (a fake in tests). */
export type ActionRegistry = Pick<
  Registry,
  "permissionTargets" | "dropPermission" | "formTargets" | "dropForm" | "owner" | "running" | "exposed" | "beginTurn" | "cancelTurns"
>
export type ActionSpokes = Pick<SpokeHub, "request">

export interface ActionDeps {
  readonly registry: ActionRegistry
  readonly spokes: ActionSpokes
  /** The user prompted the session: its message hop chain starts over (never fails). */
  readonly humanTurn: (sessionID: string) => Promise<void>
  /** Where requests answered through the hub are recorded (default: this process; Valkey in a cluster). */
  readonly kv?: Kv
  /**
   * Cluster mode: a turn also holds the session's lease in the shared Locks (turn:<sessionID>, for ttlMs at most),
   * so two pods never start turns in the same session within the cluster view's publish window.
   */
  readonly turns?: { readonly locks: Locks; readonly owner: string; readonly ttlMs: number }
}

/** The action ran. */
export interface Done {
  readonly outcome: "done"
}
/** The request or form is not pending any more: answered elsewhere, expired or ended. */
export interface Gone {
  readonly outcome: "gone"
}
/** No connected process owns the session. */
export interface Offline {
  readonly outcome: "offline"
}

export interface PermissionInput {
  /** Root of the session tree whose status holds the pending request. */
  readonly rootID: string
  readonly requestID: string
  readonly decision: PermissionDecision
  /** Why (a reject's reason, for spokes announcing "permissionMessage"; the caller checks the feature). */
  readonly message?: string
}

export type FormInput =
  | { readonly rootID: string; readonly formID: string; readonly answer: FormAnswer; readonly cancel?: undefined }
  | { readonly rootID: string; readonly formID: string; readonly cancel: true; readonly answer?: undefined }

export interface PromptInput {
  readonly sessionID: string
  /** Validated and trimmed by the caller. */
  readonly text: string
  /** Validated by the caller; omit (or empty) for none. */
  readonly images?: readonly PromptImage[]
  /** True for the user's own prompts; agent prompts never reset the hop chain (decision wvqeuis0 §8). */
  readonly resetHops: boolean
}

/** Typed input steered into the running tree. */
export interface Steered extends Done {
  readonly mode: "steer"
  readonly inboxID: string
}
/** A new turn holds the session's lock until `result` settles (a stop ends it at once as interrupted). */
export interface TurnStarted extends Done {
  readonly mode: "turn"
  readonly result: Promise<TurnResult>
}

export interface Stopped extends Done {
  /** The spoke's answer, as it gave it. */
  readonly result: ResultFor["stop"]
}

export interface Actions {
  answerPermission(input: PermissionInput): Promise<Done | Gone>
  answerForm(input: FormInput): Promise<Done | Gone>
  /** Throws BusyError when another turn holds the lock. */
  prompt(input: PromptInput): Promise<Offline | Steered | TurnStarted>
  stop(sessionID: string): Promise<Offline | Stopped>
}

const DONE: Done = { outcome: "done" }
const GONE: Gone = { outcome: "gone" }
const OFFLINE: Offline = { outcome: "offline" }
const STOPPED: TurnResult = { outcome: "interrupted", message: "Stopped", reply: "" }

/** How long a request answered through the hub stays answered when its harness never reports the reply. */
const ANSWERED_MS = 10 * 60_000
const answeredKey = (requestID: string) => `action:answered:${requestID}`

export function createActions({ registry, spokes, humanTurn, kv = new MemoryKv(), turns }: ActionDeps): Actions {
  /** Takes the session's cluster-wide turn lease (BusyError when another pod's turn holds it); resolves its release. */
  const shareTurn = async (sessionID: string): Promise<() => void> => {
    if (!turns) return () => {}
    const key = `turn:${sessionID}`
    const holder = `${turns.owner}:${randomUUID()}`
    if (!(await turns.locks.acquire(key, holder, turns.ttlMs))) throw new BusyError()
    return () => void turns.locks.release(key, holder).catch(() => false)
  }
  return {
    async answerPermission({ rootID, requestID, decision, message }) {
      if ((await kv.get(answeredKey(requestID))) !== undefined) return GONE
      const targets = registry.permissionTargets(rootID, requestID)
      if (!targets.length) return GONE
      // Requests answered through the hub (on any pod) are gone for a second answer, even before (or without)
      // permission.replied; claimed before sending, so two pods racing never both send it.
      if (!(await kv.set(answeredKey(requestID), "1", { px: ANSWERED_MS, nx: true }))) return GONE
      // Try every process that saw the request: only the one (and the location) running the session holds it.
      let failure: unknown
      for (const target of targets) {
        try {
          const result = await spokes.request(target.connID, { op: "permission", sessionID: target.sessionID, requestID, decision, ...(message !== undefined ? { message } : {}) })
          if (!result?.gone) return DONE
        } catch (cause) {
          // Older spokes pass OpenCode's "Permission request not found" through as an error.
          if (!/not found/i.test(cause instanceof Error ? cause.message : String(cause))) failure ??= cause
        }
      }
      // Nobody took it: the claim goes, so a later answer (here or on another pod) is tried again.
      await kv.del(answeredKey(requestID))
      if (failure) throw failure
      registry.dropPermission(requestID)
      return GONE
    },

    async answerForm(input) {
      const targets = registry.formTargets(input.rootID, input.formID)
      if (!targets.length) return GONE
      let failure: unknown
      for (const target of targets) {
        const req = input.cancel
          ? { op: "form" as const, sessionID: target.sessionID, formID: input.formID, cancel: true as const }
          : { op: "form" as const, sessionID: target.sessionID, formID: input.formID, answer: input.answer }
        try {
          const result = await spokes.request(target.connID, req)
          if (!result?.gone) return DONE
        } catch (cause) {
          failure ??= cause
        }
      }
      if (failure) throw failure
      registry.dropForm(input.formID)
      return GONE
    },

    async prompt({ sessionID, text, images, resetHops }) {
      const connID = registry.owner(sessionID)
      if (!connID) return OFFLINE
      const attached = images?.length ? { images: [...images] } : {}
      if (resetHops) await humanTurn(sessionID)
      // While anything in the tree runs, typed input redirects the current work instead of queueing.
      if (registry.running(sessionID)) {
        const { inboxID } = await spokes.request(connID, { op: "steer", sessionID, text, ...attached })
        return { outcome: "done", mode: "steer", inboxID }
      }
      // A stop or interrupt releases the lock and ends the turn at once, even if the spoke never answers.
      let cancel = () => {}
      const stopped = new Promise<TurnResult>((resolve) => {
        cancel = () => resolve(STOPPED)
      })
      const releaseLocal = registry.beginTurn(sessionID, () => cancel())
      let releaseShared: () => void
      try {
        releaseShared = await shareTurn(sessionID)
      } catch (cause) {
        releaseLocal()
        throw cause
      }
      const release = () => {
        releaseLocal()
        releaseShared()
      }
      const voiceStyle = registry.exposed(sessionID) === true
      let result: Promise<TurnResult>
      try {
        result = Promise.race([spokes.request(connID, { op: "turn", sessionID, text, voiceStyle, ...attached }), stopped])
      } catch (cause) {
        release()
        throw cause
      }
      // The lock is held until the turn ends, whether anyone waits for it or not.
      void result.then(release, release)
      return { outcome: "done", mode: "turn", result }
    },

    async stop(sessionID) {
      const connID = registry.owner(sessionID)
      if (!connID) return OFFLINE
      const result = await spokes.request(connID, { op: "stop", sessionID })
      registry.cancelTurns(sessionID)
      return { outcome: "done", result }
    },
  }
}
