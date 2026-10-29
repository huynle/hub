// Harness adapters: how the bootstrap discovers, plans for and verifies each agent harness. An installed binary is
// not a healthy harness: readiness needs real probes (the binary runs and reports its version on the host, not a
// container shim; its model provider answers; its spoke is connected to the hub), each fresh and passing. Presence
// alone never counts. Adapters are pure planners: they return typed Actions and run probes through the context the
// applier gives them; they never get a shell.
import type { Action } from "./actions.ts"
import type { DiscoverySnapshot, HarnessPresence } from "./discovery.ts"
import type { Profile } from "./profile.ts"

/** Supported harnesses, in the order the bootstrap offers, installs and verifies them. */
export const HARNESS_ORDER = ["opencode", "claude-code", "codex"] as const
export type HarnessID = (typeof HARNESS_ORDER)[number]

/** Sandboxed runtimes: opt-in, discovery and verification only (never installed or configured by the bootstrap). */
export const RUNTIME_IDS = ["openshell"] as const
export type RuntimeID = (typeof RUNTIME_IDS)[number]

/**
 * Upstream authenticity evidence a pinned harness download may carry beyond hub's signed digest pin. It is always
 * optional extra evidence (recorded as verified, unavailable or deferred); the pin itself is mandatory.
 *   gpg-manifest        Claude Code's GPG-signed per-release manifest.json
 *   macos-notarization  Apple notarization / codesign of the macOS binary
 *   sigstore            a sigstore bundle published next to the asset (Codex, where available)
 */
export const EVIDENCE_KINDS = ["gpg-manifest", "macos-notarization", "sigstore"] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** Which evidence each harness's upstream can offer. OpenCode offers none: only hub's pinned digest vouches for it. */
export const HARNESS_EVIDENCE: Readonly<Record<HarnessID, readonly EvidenceKind[]>> = Object.freeze({
  opencode: [],
  "claude-code": ["gpg-manifest", "macos-notarization"],
  // v1.1 (HBS-13): Codex's macOS binaries are codesigned; the Codex source records only sigstore so far, so a pin may
  // list macos-notarization only once the source checks it.
  codex: ["sigstore", "macos-notarization"],
})

/**
 * presence: found on PATH / at a known location (never sufficient). version-exec: executed on the host and printed
 * a version. provider-auth: a real request to its model provider succeeded with the configured credentials.
 * api-health: the harness's local server answered its health endpoint. spoke-connected: the hub sees its spoke.
 */
export const PROBE_KINDS = ["presence", "version-exec", "provider-auth", "api-health", "spoke-connected"] as const
export type ProbeKind = (typeof PROBE_KINDS)[number]
/** Probes that exercise the harness for real; a verify-harness action may only ask for these. */
export const REAL_PROBES: readonly Exclude<ProbeKind, "presence">[] = ["version-exec", "provider-auth", "api-health", "spoke-connected"]

export interface Probe {
  readonly kind: ProbeKind
  readonly ok: boolean
  readonly observedAt: number
  /** One line for people (a version string, an HTTP status); never a credential. */
  readonly detail?: string
}

export interface HarnessVerification {
  readonly harness: HarnessID
  readonly probes: readonly Probe[]
}

/** What each harness must pass before it is ready. */
export const REQUIRED_PROBES: Readonly<Record<HarnessID, readonly ProbeKind[]>> = Object.freeze({
  opencode: ["version-exec", "provider-auth", "spoke-connected"],
  "claude-code": ["version-exec", "provider-auth", "spoke-connected"],
  codex: ["version-exec", "provider-auth", "spoke-connected"],
})

/** How old a probe may be and still count. */
export const PROBE_MAX_AGE_MS = 15 * 60_000
const CLOCK_SKEW_MS = 60_000

/** Every required probe was run, passed, and is fresh; any failing or stale required probe means not ready. */
export function isHarnessReady(verification: HarnessVerification, now: number): boolean {
  const required = REQUIRED_PROBES[verification.harness]
  if (!required) return false
  return required.every((kind) => {
    const probes = verification.probes.filter((p) => p.kind === kind)
    return probes.length > 0 && probes.every((p) => p.ok && p.observedAt <= now + CLOCK_SKEW_MS && now - p.observedAt <= PROBE_MAX_AGE_MS)
  })
}

/**
 * v1.2: what a probe that is not passing means. `integrity`: the install itself is wrong (the binary is missing, does
 * not run, is not the pinned version, is a container shim, its local API does not answer), so apply rolls back.
 * `user`: the install is fine but waits on the user (their provider login, a spoke they start), which only the
 * installed harness lets them do, so apply commits it as "installed, not ready" unless --require-ready is given.
 * The class belongs to the probe kind, never to a probe's detail, so it cannot be argued from harness output.
 */
export const PROBE_CLASSES = ["integrity", "user"] as const
export type ProbeClass = (typeof PROBE_CLASSES)[number]
export const PROBE_CLASS: Readonly<Record<ProbeKind, ProbeClass>> = Object.freeze({
  presence: "integrity",
  "version-exec": "integrity",
  "api-health": "integrity",
  "provider-auth": "user",
  "spoke-connected": "user",
})

/** v1.2: pass (present, passing, fresh); pending (a user probe that is not passing); fail (anything else). */
export type ProbeStatus = "pass" | "pending" | "fail"
/** v1.2: ready (every probe passes); pending (only user probes do not); failed (an integrity probe does not). */
export type ReadinessState = "ready" | "pending" | "failed"

export interface ProbeReadiness {
  readonly kind: ProbeKind
  readonly class: ProbeClass
  readonly status: ProbeStatus
  readonly detail?: string
}

export interface HarnessReadiness {
  readonly harness: HarnessID
  readonly state: ReadinessState
  readonly probes: readonly ProbeReadiness[]
  /** What the user does next, in order (empty when ready); never a command hubctl runs. */
  readonly nextSteps: readonly string[]
}

/** v1.2: the user's next step for each pending user probe. */
export const PENDING_STEPS: Readonly<Record<HarnessID, Readonly<Partial<Record<ProbeKind, string>>>>> = Object.freeze({
  opencode: {
    "provider-auth": "sign in to a model provider on this machine: run `opencode auth login`",
    "spoke-connected": "start OpenCode (`opencode`) so the hub plugin connects its spoke",
  },
  "claude-code": {
    "provider-auth": "log in to Claude Code on this machine: run `claude auth login`",
    "spoke-connected": "start the claude-code spoke (`hub claude-code daemon`, or activate the hub services)",
  },
  codex: {
    "provider-auth": "log in to Codex on this machine: run `codex login`",
    "spoke-connected": "start the Codex spoke (`hub codex-spoke serve`, or activate the hub services)",
  },
})
export const VERIFY_STEP = "then check readiness with `hubctl setup verify`"

const fresh = (p: Probe, now: number) => p.ok && p.observedAt <= now + CLOCK_SKEW_MS && now - p.observedAt <= PROBE_MAX_AGE_MS

/**
 * v1.2: classifies a verification. Every REQUIRED_PROBES kind and every kind in `also` (the probes a verify-harness
 * action asks for) must be present; a missing one is a failure (an adapter reports every probe it owes). `ready`
 * implies isHarnessReady.
 */
export function harnessReadiness(verification: HarnessVerification, now: number, also: readonly ProbeKind[] = []): HarnessReadiness {
  const required = REQUIRED_PROBES[verification.harness] ?? []
  const kinds = [...required, ...also.filter((k) => !required.includes(k))]
  const probes: ProbeReadiness[] = kinds.map((kind) => {
    const found = verification.probes.filter((p) => p.kind === kind)
    const cls = PROBE_CLASS[kind]
    if (found.length === 0) return { kind, class: cls, status: "fail", detail: "not run" }
    const bad = found.find((p) => !fresh(p, now))
    const detail = (bad ?? found[found.length - 1]!).detail
    const status: ProbeStatus = !bad ? "pass" : cls === "user" ? "pending" : "fail"
    return { kind, class: cls, status, ...(detail !== undefined ? { detail } : {}) }
  })
  const state: ReadinessState = probes.some((p) => p.status === "fail") ? "failed" : probes.some((p) => p.status === "pending") ? "pending" : "ready"
  const steps = state === "pending" ? probes.flatMap((p) => (p.status === "pending" ? (PENDING_STEPS[verification.harness]?.[p.kind] ?? []) : [])) : []
  return { harness: verification.harness, state, probes, nextSteps: state === "pending" ? [...steps, VERIFY_STEP] : [] }
}

/** What an adapter may use: typed, injected capabilities only (the applier implements them). */
export interface AdapterContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: string
  readonly arch: string
  readonly now: () => number
  readonly signal?: AbortSignal
}

export interface PlanInput {
  readonly snapshot: DiscoverySnapshot
  readonly profile: Profile
}

export interface HarnessAdapter {
  readonly id: HarnessID
  /** Presence and configuration only; health stays "unverified" until verify runs real probes. */
  discover(context: AdapterContext): Promise<HarnessPresence>
  /** Deterministic: the same snapshot and profile always give the same actions. */
  plan(input: PlanInput): readonly Action[]
  /** Runs the real probes (REQUIRED_PROBES) and reports each, passing or not. */
  verify(context: AdapterContext): Promise<HarnessVerification>
}

export interface AdapterRegistry {
  register(adapter: HarnessAdapter): void
  get(id: HarnessID): HarnessAdapter | undefined
  /** Registered adapters in HARNESS_ORDER. */
  list(): readonly HarnessAdapter[]
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<HarnessID, HarnessAdapter>()
  return {
    register(adapter) {
      if (!(HARNESS_ORDER as readonly string[]).includes(adapter.id)) throw new Error(`unknown harness ${String(adapter.id)} (one of ${HARNESS_ORDER.join(", ")})`)
      if (adapters.has(adapter.id)) throw new Error(`harness ${adapter.id} is already registered`)
      adapters.set(adapter.id, adapter)
    },
    get: (id) => adapters.get(id),
    list: () => HARNESS_ORDER.flatMap((id) => adapters.get(id) ?? []),
  }
}
