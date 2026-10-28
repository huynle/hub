// The node-services adapter: a persistent launch node (`hub node`) and the harness spokes' user services, planned
// from the embedded unit templates, loaded only with explicit consent through fixed-argv calls to the user's
// service manager, and proved by one bounded verification launch.
//
//   render.ts    the units, from EMBEDDED_ASSETS with serviceArgv (golden-tested for systemd --user and launchd)
//   validate.ts  narrow node settings (roots, slots, labels) and the same-runtime-context rule
//   plan.ts      the typed actions (node.json merge, install-service, activate-service, launch-session)
//   control.ts   ServiceControl over systemctl --user / launchctl, and the activate-service executor
//   launch.ts    the bounded launch verification and the launch-session executor
import type { ExecutorMap } from "../../transaction/executor.ts"
import { activateServiceExecutor, type NodeServiceControl } from "./control.ts"
import { launchSessionExecutor, type LaunchProbe } from "./launch.ts"

export * from "./render.ts"
export * from "./validate.ts"
export * from "./plan.ts"
export * from "./control.ts"
export * from "./launch.ts"

/** The executors this adapter adds to builtinExecutors (pass the same control as BuiltinDeps.services). */
export function nodeServiceExecutors(deps: { readonly control?: NodeServiceControl; readonly probe?: LaunchProbe }): Pick<ExecutorMap, "activate-service" | "launch-session"> {
  return { "activate-service": activateServiceExecutor(deps.control), "launch-session": launchSessionExecutor(deps.probe) }
}
