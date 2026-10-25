// The node's openshell wiring (design §6.3, §6.4): node.json's `openshell` section turned into an OpenShellRuntime,
// the backends the hello reports for it (the gateway's compute drivers, e.g. "vm"; best effort) and the startup
// sweep: sandboxes labelled hub.machine=<this machine> in the OpenShell workspace `hub` are launches an earlier run
// left (a crash, a restart), reported in the hello so the hub reconciles them. Only sandboxes whose name is the
// deterministic name of their hub.launch label count: anything else (e.g. `demo`) is not the node's.
import { token } from "../../protocol/src/wire.ts"
import type { NodeLaunchReport } from "../../protocol/src/index.ts"
import type { OpenShellClient, Sandbox } from "../../runtime-openshell/src/cli.ts"
import { labelValue, OpenShellRuntime, sandboxName } from "../../runtime-openshell/src/runtime.ts"
import type { OpenShellNodeConfig } from "./config.ts"

/** How long the startup probes (gateway info, the sweep) may take each. */
export const PROBE_TIMEOUT_MS = 15_000
const BACKENDS_MAX = 32

export interface CreateOpenShellRuntimeOptions {
  readonly client: OpenShellClient
  readonly roots: readonly string[]
  /** The hub URL as the node knows it (config.json `server`). */
  readonly hubURL: string
  readonly openshell: OpenShellNodeConfig
  readonly machineID?: string
}

export function createOpenShellRuntime(options: CreateOpenShellRuntimeOptions): OpenShellRuntime {
  const { client, roots, hubURL, openshell, machineID } = options
  return new OpenShellRuntime({
    client,
    roots,
    hubURL,
    profiles: openshell.profiles,
    harnesses: ["opencode"],
    ...(openshell.image ? { image: openshell.image } : {}),
    ...(machineID ? { machineID } : {}),
  })
}

const probe = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The gateway's compute drivers as hello backends; [] when the client cannot tell or the gateway does not answer. */
export async function openshellBackends(client: Pick<OpenShellClient, "gatewayInfo">): Promise<string[]> {
  if (typeof client.gatewayInfo !== "function") return []
  try {
    const { computeDrivers } = await client.gatewayInfo(probe())
    return [...new Set(computeDrivers.filter((d) => token(d, 64)))].slice(0, BACKENDS_MAX)
  } catch {
    return []
  }
}

/** A sandbox's launch phase for the hello: running while it is (or is becoming) Ready, else stopped. */
function launchPhase(sandbox: Sandbox): NodeLaunchReport["phase"] {
  return sandbox.phase === "Ready" || sandbox.phase === "Provisioning" || sandbox.phase === "Starting" ? "running" : "stopped"
}

/** This machine's sandboxes in the hub workspace, as launches; a failing list is a problem line, not an error. */
export async function sweepSandboxes(client: OpenShellClient, machineID: string): Promise<{ launches: NodeLaunchReport[]; problems: string[] }> {
  let sandboxes: Sandbox[]
  try {
    sandboxes = await client.list({ "hub.machine": labelValue(machineID) }, probe())
  } catch (cause) {
    return { launches: [], problems: [`could not list this machine's OpenShell sandboxes: ${errorText(cause)}`] }
  }
  const launches: NodeLaunchReport[] = []
  for (const sandbox of sandboxes) {
    const launchID = sandbox.labels["hub.launch"]
    if (!launchID || sandboxName(launchID) !== sandbox.name) continue
    if (sandbox.labels["hub.machine"] !== labelValue(machineID) || sandbox.phase === "Deleting") continue
    launches.push({ launchID, phase: launchPhase(sandbox), sandbox: sandbox.name })
  }
  return { launches, problems: [] }
}
