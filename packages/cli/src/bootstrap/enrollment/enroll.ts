// `machine enroll`: the canonical device-code enrollment of this machine. It needs no harness. It reuses the spoke
// SDK's flow (POST /spoke/enroll, then /spoke/enroll/poll until the user approves on the hub) and stores the one
// machine identity every spoke and `hub node` here share (ConfigCredentialStore, the spoke's config.json).
//
// Policy:
// - The hub URL is https (plain http only for a loopback hub); redirects are refused, never followed.
// - The approval link shown is on the hub's own origin (approvalURL).
// - The wait is bounded by the hub's expiry and by maxWaitMs; `signal` cancels it.
// - The hub hands out the credential once: the store is checked before the code is redeemed, an approving poll in
//   flight is never aborted, a failed save is retried, and when it still fails the credential stays in memory
//   only (retryPersist) and the output names the machine ID so the user can revoke it. It is never written
//   anywhere else and never printed.
// - v1.1: the outcomes have their own codes: enrollment_denied (exit 5), enrollment_expired and cancelled (exit 4),
//   the same exits as before.
import { hostname } from "node:os"
import type { EnrollStart } from "../../../../protocol/src/index.ts"
import { EnrollmentRefused, pollEnrollment, startEnrollment } from "../../../../spoke-sdk/src/enroll.ts"
import type { CredentialStore, MachineCredential, MachineEnrollment } from "../contracts/index.ts"
import { approvalURL, checkServerURL, isUserCode } from "./policy.ts"
import { failure, line, success, type MachineResult } from "./result.ts"
import { CredentialStoreError, type SharingMode, type StoreContents } from "./store.ts"
import { probeCredential, statusOf, storeFailure } from "./status.ts"

/** The longest a single enrollment waits for approval, whatever the hub says (the hub's own expiry is 10 minutes). */
export const ENROLL_MAX_WAIT_MS = 15 * 60_000
const MIN_INTERVAL_MS = 500
const MAX_INTERVAL_MS = 30_000
const PERSIST_ATTEMPTS = 3
const PERSIST_DELAY_MS = 250
const MACHINE_NAME = /^[A-Za-z0-9._ -]{1,64}$/
const COMMAND = "machine enroll"

/** What to show the user while waiting: the code to confirm and where to approve it. Never a credential. */
export interface EnrollPrompt {
  readonly userCode: string
  readonly approveURL: string
  readonly expiresAt: number
  /** A local hub approved this first machine by itself. */
  readonly autoApproved: boolean
  /** Set when the hub's own approval link was not used. */
  readonly warning?: string
}

export type EnrollStore = CredentialStore & { preflight?(): Promise<void>; inspect?(): StoreContents; sharingMode?(): SharingMode; enableSharing?(): boolean }

/** Why an enrolled machine's OpenCode spoke stays disconnected: the user's explicit `mode: "off"`. */
export function sharingOffWarning(location: string): string {
  return `sharing is off for this machine (mode is "off" in ${location}), so the OpenCode spoke will not connect; turn it on with /hub → Mode in OpenCode, or set "mode" to "always"`
}

/**
 * The sharing notes of an enrolled machine. With `repair`, a config with no `mode` at all (written by an older
 * hubctl) gets the default; an explicit mode is never changed. Best effort: a store that cannot say adds nothing.
 */
function sharingNotes(store: EnrollStore, repair: boolean): string[] {
  try {
    if (repair && store.enableSharing?.()) return [`turned sharing on for this machine (mode "always" in ${store.location}), so the OpenCode spoke connects`]
    return store.sharingMode?.() === "off" ? [sharingOffWarning(store.location)] : []
  } catch {
    return []
  }
}

export interface MachineEnrollOptions {
  readonly server: string
  /** Default: defaultMachineName(hostname()). */
  readonly machineName?: string
  readonly store: EnrollStore
  /** Replace an existing machine identity (otherwise enrolling twice is a no-op, and another hub is refused). */
  readonly reenroll?: boolean
  /** Check the new credential with the hub afterwards (default true). */
  readonly verify?: boolean
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly onPrompt?: (prompt: EnrollPrompt) => void
  readonly maxWaitMs?: number
  /** Floor of the poll interval the hub asks for (default 500 ms). */
  readonly minIntervalMs?: number
  readonly persistAttempts?: number
  readonly persistDelayMs?: number
  readonly probeTimeoutMs?: number
  /** The device-code flow (default: the spoke SDK's, with redirects refused and redeem-safe polling). */
  readonly enrollment?: MachineEnrollment
}

export interface MachineEnrollResult extends MachineResult {
  /**
   * Only when the hub approved the machine but its credential could not be saved: saves it again (no new code is
   * redeemed). The credential lives in this closure only; it is not part of the result's data.
   */
  readonly retryPersist?: () => Promise<MachineEnrollResult>
}

/** A machine name the hub and the status contract accept, from a hostname. */
export function defaultMachineName(host: string): string {
  const name = host
    .replace(/\.local$/i, "")
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .trim()
    .slice(0, 64)
  return name || "machine"
}

/** The spoke SDK's device-code flow under the enrollment policy. */
export function deviceCodeEnrollment(options: { fetch?: typeof fetch; now?: () => number } = {}): MachineEnrollment {
  const base = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}), redirect: "error" as const }
  return {
    start: (server, machineName, signal) => startEnrollment(server, machineName, { ...base, ...(signal ? { signal } : {}) }),
    poll: (server, start, signal) => pollEnrollment(server, start, { ...base, ...(signal ? { signal } : {}), keepRedeemed: true }),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errnoOf = (cause: unknown) => (cause instanceof CredentialStoreError ? cause.errno : (cause as NodeJS.ErrnoException | undefined)?.code)

function validStart(value: EnrollStart): boolean {
  return isUserCode(value.userCode) && Number.isFinite(value.expiresAt) && Number.isFinite(value.intervalMs)
}

export async function machineEnroll(options: MachineEnrollOptions): Promise<MachineEnrollResult> {
  const now = options.now ?? Date.now
  const { store, signal } = options
  const server = checkServerURL(options.server)
  if (!server) {
    return failure(COMMAND, "usage", `The hub URL must be https (plain http only for a loopback hub), without user info, query or fragment: ${line(String(options.server), 200)}`)
  }
  const machineName = options.machineName ?? defaultMachineName(hostname())
  if (!MACHINE_NAME.test(machineName)) return failure(COMMAND, "usage", "The machine name must be 1–64 letters, digits, spaces, dots, dashes or underscores")
  const cancelled = () => failure(COMMAND, "cancelled", "Enrollment cancelled; nothing was stored", { hint: "Run hubctl machine enroll again" })
  if (signal?.aborted) return cancelled()

  let existing: MachineCredential | undefined
  try {
    existing = await store.read()
  } catch (cause) {
    return storeFailure(COMMAND, cause, store.location)
  }
  if (existing && !options.reenroll) {
    if (checkServerURL(existing.server) !== server) {
      return failure(COMMAND, "needs_user", `This machine is already enrolled with ${line(existing.server, 200)} as ${existing.machineID}`, {
        hint: `Pass --reenroll to replace its identity with a new one from ${server}`,
      })
    }
    const probe = options.verify === false ? undefined : await probeCredential(existing, probeOptions(options))
    const status = statusOf(existing, probe?.reachable ? probe : undefined, now())
    if (status.state === "revoked") return failure(COMMAND, "revoked", "The hub rejected this machine's stored credential", { data: status, hint: "Pass --reenroll to enroll it again" })
    return success(COMMAND, status, [`already enrolled as ${existing.machineID}; pass --reenroll to replace this machine's identity`, ...sharingNotes(store, true)])
  }

  try {
    await store.preflight?.()
  } catch (cause) {
    return storeFailure(COMMAND, cause, store.location)
  }

  const flow = options.enrollment ?? deviceCodeEnrollment({ ...(options.fetch ? { fetch: options.fetch } : {}), now })
  let start: EnrollStart
  try {
    start = await flow.start(server, machineName, signal)
  } catch (cause) {
    if (signal?.aborted) return cancelled()
    if (cause instanceof EnrollmentRefused) return failure(COMMAND, "internal", `${server} redirected the enrollment request; enrollment does not follow redirects`, { hint: "Use the hub's final https URL" })
    const message = cause instanceof Error ? cause.message : ""
    if (/invalid enrollment reply/i.test(message)) return failure(COMMAND, "internal", `${server} sent an invalid enrollment reply`)
    return failure(COMMAND, "offline", `Could not start enrollment with ${server}${/HTTP \d{3}/.test(message) ? ` (${/HTTP \d{3}/.exec(message)![0]})` : ""}`)
  }
  if (!validStart(start)) return failure(COMMAND, "internal", `${server} sent an invalid enrollment reply`)

  const link = approvalURL(server, start.approveURL, start.userCode)
  const warnings = link.warning ? [link.warning] : []
  const expiresAt = Math.min(start.expiresAt, now() + (options.maxWaitMs ?? ENROLL_MAX_WAIT_MS))
  options.onPrompt?.({ userCode: start.userCode, approveURL: link.url, expiresAt, autoApproved: start.autoApproved === true, ...(link.warning ? { warning: link.warning } : {}) })

  const intervalMs = Math.min(Math.max(start.intervalMs, options.minIntervalMs ?? MIN_INTERVAL_MS), MAX_INTERVAL_MS)
  let outcome: Awaited<ReturnType<MachineEnrollment["poll"]>>
  try {
    outcome = await flow.poll(server, { ...start, expiresAt, intervalMs }, signal)
  } catch (cause) {
    if (cause instanceof EnrollmentRefused) return failure(COMMAND, "internal", `${server} redirected the enrollment poll; enrollment does not follow redirects`, { warnings })
    return failure(COMMAND, "offline", `Enrollment with ${server} failed`, { warnings })
  }
  if (outcome.status === "cancelled") return cancelled()
  if (outcome.status === "denied") return failure(COMMAND, "enrollment_denied", `The enrollment of ${machineName} was denied on the hub`, { warnings })
  if (outcome.status !== "approved") return failure(COMMAND, "enrollment_expired", "The enrollment code expired before it was approved; nothing was stored", { hint: "Run hubctl machine enroll again and approve the code on the hub", warnings })

  const credential: MachineCredential = { server, machineID: outcome.machineID, machineName, token: outcome.machineToken }
  return persist(credential, options, warnings, options.persistAttempts ?? PERSIST_ATTEMPTS)
}

const probeOptions = (options: MachineEnrollOptions) => ({
  ...(options.fetch ? { fetch: options.fetch } : {}),
  ...(options.signal ? { signal: options.signal } : {}),
  ...(options.probeTimeoutMs ? { timeoutMs: options.probeTimeoutMs } : {}),
})

/** Saves a redeemed credential (retrying), then reports its status. Never aborted: the code cannot be redeemed again. */
async function persist(credential: MachineCredential, options: MachineEnrollOptions, warnings: string[], attempts: number): Promise<MachineEnrollResult> {
  const now = options.now ?? Date.now
  let last: unknown
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      await options.store.write(credential)
      last = undefined
      break
    } catch (cause) {
      last = cause
      if (attempt < attempts) await sleep(options.persistDelayMs ?? PERSIST_DELAY_MS)
    }
  }
  if (last !== undefined) {
    const errno = errnoOf(last)
    const result = failure(COMMAND, "internal", `The hub approved this machine as ${credential.machineID}, but its credential could not be saved to ${options.store.location}${errno ? ` (${errno})` : ""}`, {
      hint: `Fix the problem and retry while this command runs; otherwise revoke machine ${credential.machineID} on the hub and run hubctl machine enroll again`,
      warnings,
    })
    return { ...result, retryPersist: () => persist(credential, options, warnings, 1) }
  }
  warnings = [...warnings, ...sharingNotes(options.store, false)]
  if (options.verify === false) return success(COMMAND, statusOf(credential, undefined, now()), warnings)
  const probe = await probeCredential(credential, probeOptions(options))
  if (probe && !probe.reachable) return success(COMMAND, statusOf(credential, undefined, now()), [...warnings, `enrolled, but not verified: ${probe.detail}`])
  const status = statusOf(credential, probe, now())
  if (status.state === "revoked") return failure(COMMAND, "revoked", "The hub rejected the credential it just issued", { data: status, warnings })
  return success(COMMAND, status, warnings)
}
