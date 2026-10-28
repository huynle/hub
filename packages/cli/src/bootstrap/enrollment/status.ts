// `machine status`: what the credential store holds and, unless told not to, whether the hub still accepts it.
// The check is a GET /spoke/ws with the machine token and no WebSocket upgrade: the hub authenticates before it
// upgrades, so it answers 426 (Expected a WebSocket upgrade) to a token it accepts and 401 to one it rejects. No
// central change is needed; nothing is opened. The token goes only to a hub URL that passes checkServerURL, never
// across a redirect, and never into the output.
import { enrollmentStatusFrom, validateEnrollmentStatus, type CredentialProbe, type CredentialStore, type EnrollmentStatus, type MachineCredential } from "../contracts/index.ts"
import { checkServerURL } from "./policy.ts"
import { failure, line, success, type MachineResult } from "./result.ts"
import { CredentialStoreError, type StoreContents } from "./store.ts"

export const PROBE_TIMEOUT_MS = 10_000

export interface ProbeOptions {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface ProbeResult extends CredentialProbe {
  /** One line for people (HTTP status or error kind); never the response body or a credential. */
  readonly detail: string
}

function reason(cause: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "cancelled"
  const e = cause as { name?: string; code?: string } | undefined
  if (e?.name === "TimeoutError") return "timed out"
  return e?.code ?? e?.name ?? "error"
}

/** Asks the hub whether it accepts the credential. Undefined: not checked (the hub URL fails the policy). */
export async function probeCredential(credential: MachineCredential, options: ProbeOptions = {}): Promise<ProbeResult | undefined> {
  const server = checkServerURL(credential.server)
  if (!server) return undefined
  const doFetch = options.fetch ?? fetch
  const signals = [AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]
  let response: Response
  try {
    response = await doFetch(`${server}/spoke/ws`, {
      method: "GET",
      headers: { authorization: `Bearer ${credential.token}` },
      redirect: "manual",
      signal: AbortSignal.any(signals),
    })
  } catch (cause) {
    return { reachable: false, detail: `could not reach ${server}: ${reason(cause, options.signal)}` }
  }
  void response.body?.cancel().catch(() => {})
  if (response.status === 426) return { reachable: true, accepted: true, detail: `${server} accepts this machine` }
  if (response.status === 401 || response.status === 403) return { reachable: true, accepted: false, detail: `${server} rejected the machine credential (revoked or unknown)` }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { reachable: false, detail: `${server} redirected the check (HTTP ${response.status}); redirects are not followed` }
  }
  return { reachable: false, detail: `${server} could not check the credential (HTTP ${response.status})` }
}

/** A store that can also tell an incomplete entry (a token without a machine ID) from an empty one. */
export type InspectableStore = CredentialStore & { inspect?(): StoreContents }

export interface MachineStatusOptions extends ProbeOptions {
  readonly store: InspectableStore
  /** Check the credential with the hub (default true); false reports `configured` without any network access. */
  readonly verify?: boolean
  readonly now?: () => number
}

const COMMAND = "machine status"
const MACHINE_NAME = /^[A-Za-z0-9._ -]{1,64}$/

export function storeFailure(command: "machine status" | "machine enroll", cause: unknown, location: string): MachineResult {
  if (cause instanceof CredentialStoreError && (cause.reason === "not_object" || cause.reason === "symlink")) {
    return failure(command, "conflict", cause.message, { hint: `Fix ${location} by hand; hubctl does not replace it` })
  }
  return failure(command, "internal", cause instanceof CredentialStoreError ? cause.message : `Cannot read ${location}`)
}

/** The secret-free status of a credential, with an optional probe result. Drops a machine name the contract refuses. */
export function statusOf(credential: MachineCredential | undefined, probe: ProbeResult | undefined, now: number, detail?: string): EnrollmentStatus {
  const named = credential?.machineName && !MACHINE_NAME.test(credential.machineName) ? { ...credential, machineName: undefined } : credential
  const status = enrollmentStatusFrom(named, probe, now)
  const text = detail ?? probe?.detail
  return text ? { ...status, detail: line(text) } : status
}

export async function machineStatus(options: MachineStatusOptions): Promise<MachineResult> {
  const now = options.now ?? Date.now
  const { store } = options
  let credential: MachineCredential | undefined
  let contents: StoreContents | undefined
  try {
    credential = await store.read()
    contents = store.inspect?.()
  } catch (cause) {
    return storeFailure(COMMAND, cause, store.location)
  }
  if (!credential) {
    const detail = contents?.state === "incomplete" ? `${store.location} has no machine ID for its credential; run hubctl machine enroll --reenroll` : undefined
    return success(COMMAND, statusOf(undefined, undefined, now(), detail))
  }
  if (!checkServerURL(credential.server)) {
    return failure(COMMAND, "invalid", `The stored hub URL ${line(credential.server, 300)} is not https (plain http is allowed only for a loopback hub), so it was not checked`, {
      hint: "Enroll again with an https hub URL: hubctl machine enroll --server https://<hub> --reenroll",
    })
  }
  const probe = options.verify === false ? undefined : await probeCredential(credential, options)
  const status = statusOf(credential, probe, now())
  if (!validateEnrollmentStatus(status).ok) return failure(COMMAND, "internal", `${store.location} holds a machine identity this hubctl cannot report`)
  if (status.state === "revoked") return failure(COMMAND, "revoked", "The hub rejected this machine's credential", { data: status, hint: "Enroll the machine again: hubctl machine enroll --reenroll" })
  if (status.state === "offline") return failure(COMMAND, "offline", `Could not check the credential with ${credential.server}`, { data: status })
  return success(COMMAND, status)
}
