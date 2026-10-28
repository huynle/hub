// Bootstrap profiles: versioned profile documents, the built-in catalog, profile → desired state, an audit-only
// verification mode, managed-field drift, rollback history and upgrade/downgrade planning. Everything here is a
// pure function over the contract documents (packages/cli/src/bootstrap/contracts): snapshots, plans, journals and
// verified manifests in, reports and typed actions out. Nothing here reads or writes the machine.
export * from "./versions.ts"
export * from "./catalog.ts"
export * from "./desired.ts"
export * from "./audit.ts"
export * from "./drift.ts"
export * from "./history.ts"
export * from "./upgrade.ts"
