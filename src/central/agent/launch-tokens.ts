// Launch-bound tokens (phase 5, decision #6): the credential a harness inside a sandbox (OpenShell) uses to
// connect back to /spoke/ws for exactly one launch. The node passes it into the sandbox it provisions; it is
// accepted only while that launch is provisioning or running.
//
// Format: `hlt1.<b64url(payload JSON)>.<b64url(HMAC-SHA256(secret of kid, "hlt1." + payload part))>`, where the
// payload is {uid, mid, lid, exp (ms since the epoch), kid, ue (user epoch), me (machine epoch), aud (the hub's
// public URL)}. Signed with the same TokenKeys as session tokens (hst1); the prefix is part of the signed text,
// so neither kind can pass for the other.
//
// The verifier depends only on a LaunchLookup (state and machine of a user's launch), not on the launch engine.
// Tokens and secrets are never logged and never appear in this object's JSON or inspect output.
import { createHmac } from "node:crypto"
import type { Store } from "../store"
import type { TokenKeys } from "../token-keys"
import type { LaunchState } from "./launch-store"

export const LAUNCH_TOKEN_PREFIX = "hlt1"
/** How long a launch token is valid. */
export const LAUNCH_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000
/** The launch states in which a launch token is minted and accepted. */
export const LAUNCH_TOKEN_STATES: readonly LaunchState[] = ["provisioning", "running"]

/** What the tokens need to know about a launch (implemented by the launch store). */
export interface LaunchView {
  readonly state: LaunchState
  /** The machine (node) it is placed on. */
  readonly machineID?: string
}

/** Looks up a user's launch (undefined when the user has no such launch). */
export interface LaunchLookup {
  launch(userID: string, launchID: string): Promise<LaunchView | undefined> | LaunchView | undefined
}

export interface LaunchTokensOptions {
  readonly keys: TokenKeys
  readonly store: Store
  readonly launches: LaunchLookup
  /** The hub's public URL: the tokens' audience. */
  readonly publicURL: string
  readonly now?: () => number
  readonly lifetimeMs?: number
}

export interface MintedLaunchToken {
  readonly token: string
  /** Expiry, ms since the epoch. */
  readonly exp: number
}

interface Claims {
  readonly uid: string
  readonly mid: string
  readonly lid: string
  readonly exp: number
  readonly kid: string
  readonly ue: number
  readonly me: number
  readonly aud: string
}

const sign = (secret: Buffer, payload: string): Buffer => createHmac("sha256", secret).update(`${LAUNCH_TOKEN_PREFIX}.${payload}`).digest()

export class LaunchTokens {
  readonly lifetimeMs: number
  readonly #keys: TokenKeys
  readonly #store: Store
  readonly #launches: LaunchLookup
  readonly #aud: string
  readonly #now: () => number

  constructor(options: LaunchTokensOptions) {
    this.#keys = options.keys
    this.#store = options.store
    this.#launches = options.launches
    this.#aud = options.publicURL
    this.#now = options.now ?? Date.now
    this.lifetimeMs = options.lifetimeMs ?? LAUNCH_TOKEN_LIFETIME_MS
  }

  /** The owner of an enrolled, unrevoked machine whose user exists and is enabled. */
  #owner(machineID: string): string | undefined {
    const machine = this.#store.machines().find((m) => m.id === machineID)
    if (!machine || machine.revoked) return undefined
    const user = this.#store.user(machine.ownerID)
    return user && !user.disabled ? user.id : undefined
  }

  /** Whether the user's launch is provisioning or running on the machine. */
  async #live(userID: string, launchID: string, machineID: string): Promise<boolean> {
    const launch = await this.#launches.launch(userID, launchID)
    return launch !== undefined && LAUNCH_TOKEN_STATES.includes(launch.state) && launch.machineID === machineID
  }

  /**
   * A token for a launch of the machine's owner that is provisioning or running on that machine (undefined when
   * the machine is unknown, revoked or its owner disabled, or the launch is someone else's, elsewhere or not live).
   */
  async mint(machineID: string, launchID: string): Promise<MintedLaunchToken | undefined> {
    const uid = this.#owner(machineID)
    if (!uid || !(await this.#live(uid, launchID, machineID))) return undefined
    const { kid, secret } = this.#keys.active()
    const exp = this.#now() + this.lifetimeMs
    const claims: Claims = {
      uid,
      mid: machineID,
      lid: launchID,
      exp,
      kid,
      ue: this.#store.userEpoch(uid),
      me: this.#store.machineEpoch(machineID),
      aud: this.#aud,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return { token: `${LAUNCH_TOKEN_PREFIX}.${payload}.${sign(secret, payload).toString("base64url")}`, exp }
  }
}
