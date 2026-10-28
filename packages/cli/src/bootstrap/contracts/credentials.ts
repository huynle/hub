// Machine enrollment and the credential store. One machine identity (machineID + machine token, from the existing
// device-code flow in packages/spoke-sdk/src/enroll.ts against POST /spoke/enroll and /spoke/enroll/poll) is shared
// by every spoke and `hub node` on the machine. The token lives only in the CredentialStore; everything else
// (status output, plans, journals, logs, generated Ansible) sees an EnrollmentStatus, which has no field for it.
import type { EnrollPoll, EnrollStart } from "../../../../protocol/src/index.ts"
import { findSecrets } from "./secrets.ts"
import { Checker, header, hubURL, instant, isInsecureHubURL, oneOf, pointer, shape, text, type Result } from "./validate.ts"

/**
 * unconfigured: no machine credential. configured: a credential is stored but not checked. verified: the hub
 * accepted it just now. revoked: the hub rejected it (re-enroll). offline: the hub could not be reached to check.
 * insecure (v1.1): a credential is stored for a plain-http hub that is not on loopback. It is reported (with a
 * warning) and never sent there to be checked; a new enrollment over plain http to such a hub stays refused.
 */
export const ENROLLMENT_STATES = ["unconfigured", "configured", "verified", "revoked", "offline", "insecure"] as const
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number]

export const ENROLLMENT_SCHEMA = "hub.enrollment-status"

/** Secret-free: what `hubctl machine status` prints. */
export interface EnrollmentStatus {
  readonly schema: typeof ENROLLMENT_SCHEMA
  readonly version: 1
  readonly state: EnrollmentState
  readonly server?: string
  readonly machineID?: string
  readonly machineName?: string
  readonly checkedAt?: number
  /** One line for people; never a credential. */
  readonly detail?: string
}

/** The stored identity. Only the CredentialStore reads or writes it; never serialize it anywhere else. */
export interface MachineCredential {
  readonly server: string
  readonly machineID: string
  readonly machineName?: string
  readonly token: string
}

/**
 * Where the machine credential lives (today: the 0600 spoke config.json, see src/config.ts). Implementations must
 * write atomically with owner-only permissions and merge losslessly: keys they do not know are preserved.
 */
export interface CredentialStore {
  /** The file (or keychain item) it uses, for status output. */
  readonly location: string
  read(): Promise<MachineCredential | undefined>
  write(credential: MachineCredential): Promise<void>
  /** Removes the credential only, keeping the rest of the config. */
  clear(): Promise<void>
}

/** The device-code flow (implemented by spoke-sdk startEnrollment / pollEnrollment). */
export interface MachineEnrollment {
  start(server: string, machineName: string, signal?: AbortSignal): Promise<EnrollStart>
  poll(server: string, start: EnrollStart, signal?: AbortSignal): Promise<Exclude<EnrollPoll, { status: "pending" }> | { status: "cancelled" }>
}

/** The result of asking the hub whether the stored credential is still good. */
export interface CredentialProbe {
  readonly reachable: boolean
  /** Set when reachable: did the hub accept the credential? */
  readonly accepted?: boolean
}

const MACHINE_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const MACHINE_NAME = /^[A-Za-z0-9._ -]{1,64}$/

export function enrollmentStatusFrom(credential: MachineCredential | undefined, probe: CredentialProbe | undefined, now: number): EnrollmentStatus {
  const base = { schema: ENROLLMENT_SCHEMA, version: 1 } as const
  if (!credential) return { ...base, state: "unconfigured" }
  // v1.1: a plain-http, non-loopback hub is never probed, so no probe result can make it verified.
  const insecure = isInsecureHubURL(credential.server)
  if (insecure) probe = undefined
  const state: EnrollmentState = insecure ? "insecure" : !probe ? "configured" : !probe.reachable ? "offline" : probe.accepted ? "verified" : "revoked"
  return {
    ...base,
    state,
    server: credential.server,
    machineID: credential.machineID,
    ...(credential.machineName ? { machineName: credential.machineName } : {}),
    ...(probe ? { checkedAt: now } : {}),
  }
}

export function validateEnrollmentStatus(value: unknown): Result<EnrollmentStatus> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "state"], ["server", "machineID", "machineName", "checkedAt", "detail"])
  if (!r) return c.result(value)
  header(c, "", r, ENROLLMENT_SCHEMA, 1)
  oneOf(c, "/state", r.state, ENROLLMENT_STATES)
  if (r.server !== undefined) {
    if (r.state === "insecure") {
      if (!isInsecureHubURL(r.server)) c.add("/server", "inconsistent", "insecure names a plain-http hub that is not on loopback")
    } else hubURL(c, "/server", r.server)
  }
  if (r.state === "insecure" && r.checkedAt !== undefined) c.add(pointer("", "checkedAt"), "inconsistent", "an insecure hub is never checked")
  if (r.machineID !== undefined) text(c, "/machineID", r.machineID, 128, MACHINE_ID)
  if (r.machineName !== undefined) text(c, "/machineName", r.machineName, 64, MACHINE_NAME)
  if (r.checkedAt !== undefined) instant(c, "/checkedAt", r.checkedAt)
  if (r.detail !== undefined) text(c, "/detail", r.detail)
  if (r.state === "unconfigured" && (r.server !== undefined || r.machineID !== undefined)) c.add("", "inconsistent", "an unconfigured machine has no server or machine ID")
  if (r.state !== "unconfigured" && typeof r.state === "string" && (r.server === undefined || r.machineID === undefined)) c.add("", "inconsistent", `${r.state} needs the server and machine ID`)
  if ((r.state === "verified" || r.state === "revoked") && r.checkedAt === undefined) c.add("/checkedAt", "inconsistent", `${r.state} records when it was checked`)
  for (const p of findSecrets(value)) c.add(p, "secret", "status never carries credentials")
  return c.result(value)
}
