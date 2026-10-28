// Bootstrap contracts, version 1 (frozen). The types, validators and pure decision rules every bootstrap layer
// shares: discovery, planning and preview, profiles, artifact authentication, the executable contract, enrollment
// status, the transaction journal and lock, harness adapters, and the output envelope. See
// docs/bootstrap-contracts.md for the threat model and the requirement → check mapping.
//
// Changing a contract means a new schema version (and a migration where documents persist); never an in-place
// change of meaning.
export const CONTRACT_VERSION = 1

export * from "./validate.ts"
export * from "./canonical.ts"
export * from "./secrets.ts"
export * from "./platform.ts"
export * from "./paths.ts"
export * from "./exec.ts"
export * from "./harness.ts"
export * from "./actions.ts"
export * from "./discovery.ts"
export * from "./profile.ts"
export * from "./plan.ts"
export * from "./artifact.ts"
export * from "./credentials.ts"
export * from "./journal.ts"
export * from "./envelope.ts"
