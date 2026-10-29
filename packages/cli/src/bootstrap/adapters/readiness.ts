// The readiness gate every verify-harness executor shares (contract v1.2, docs/bootstrap-contracts.md §10). The
// executor classifies its verification with harnessReadiness and reports it through onReadiness; then:
//
//   ready      the step passes
//   failed     an integrity probe failed (the install is broken): harness_not_ready, so the apply rolls back
//   pending    only user probes wait (provider login, spoke): harness_not_ready with requireReady (the default,
//              and `hubctl setup apply --require-ready`); without it the step passes and the harness is reported
//              "installed, not ready". It is never advertised as ready: only `ready` offers a capability.
import type { HarnessReadiness } from "../contracts/index.ts"

export interface ReadinessGate {
  /** Fail unless ready (default true). false: a harness only waiting on the user passes as installed, not ready. */
  readonly requireReady?: boolean
  /** Sees the classified readiness of every verification (for the apply report); cannot change it. */
  readonly onReadiness?: (readiness: HarnessReadiness) => void
}

/** Whether a verify-harness step that is not ready may still pass: only when it waits on the user alone. */
export const passesAsPending = (readiness: HarnessReadiness, gate: ReadinessGate): boolean => readiness.state === "pending" && gate.requireReady === false
