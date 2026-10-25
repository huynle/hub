// `hub node` (design §6.3): the per-machine daemon. It connects out to the hub's /spoke/ws with the machine's
// token and a node hello, and serves prepare → collect → cleanup (and cancel) for each launch through its runtimes.
// Run it with `bun packages/node/src/main.ts` (or the units in scripts/); embed it with runNode or NodeDaemon.
export { DEFAULT_SLOTS, NODE_CONFIG_FILE, nodeConfigPath, normalizeNodeConfig, readNodeConfig, readSpokeCredentials } from "./config.ts"
export type { NodeConfig, NodeConfigResult, OpenShellNodeConfig, SpokeCredentials } from "./config.ts"
export { NodeConnection, UNSUPPORTED_RETRY_MS, wsURL } from "./connection.ts"
export type { NodeConnectionOptions, NodeConnectionState } from "./connection.ts"
export { NODE_VERSION, NodeDaemon, progressText } from "./daemon.ts"
export type { NodeDaemonOptions } from "./daemon.ts"
export { ALLOWED_PROTOCOLS, GitError, gitEnv, runGit } from "./git.ts"
export { HostRuntime, LAUNCH_MARKER, launchBranch, resolveUnderRoots } from "./host.ts"
export type { HostRuntimeOptions } from "./host.ts"
export { EXIT_CONFIG, runNode } from "./run.ts"
export { createOpenShellRuntime, openshellBackends, PROBE_TIMEOUT_MS, sweepSandboxes } from "./openshell.ts"
export type { CreateOpenShellRuntimeOptions } from "./openshell.ts"
