// `hub node`'s program: read the machine's credentials from the spoke's config.json (read-only) and the node's
// settings from node.json, then run the daemon until the signal aborts. With node.json `openshell.enabled` the node
// also offers the openshell runtime (sandboxes through the openshell CLI): it checks the CLI, asks the gateway for
// its backends and sweeps this machine's sandboxes from an earlier run into the hello; an unusable CLI is logged and
// the node runs with the host runtime only. Exit codes: 0 after a clean stop, 1 when
// the machine is not enrolled, EXIT_CONFIG (78, EX_CONFIG) when node.json gives the node nothing to do; the
// service units do not restart on 78.
import { homedir } from "node:os"
import type { NodeLaunchReport } from "../../protocol/src/index.ts"
import { OpenShellCli } from "../../runtime-openshell/src/cli.ts"
import type { Runtime } from "../../runtime-sdk/src/index.ts"
import { nodeConfigPath, readNodeConfig, readSpokeCredentials, type NodeConfig, type SpokeCredentials } from "./config.ts"
import { NodeDaemon, NODE_VERSION } from "./daemon.ts"
import { HostRuntime } from "./host.ts"
import { createOpenShellRuntime, openshellBackends, PROBE_TIMEOUT_MS, sweepSandboxes } from "./openshell.ts"

export const EXIT_CONFIG = 78

type Env = Readonly<Record<string, string | undefined>>

export interface RunNodeOptions {
  readonly env?: Env
  readonly home?: string
  /** One line per event (default stderr). Never given the token. */
  readonly log?: (line: string) => void
  /** Aborting stops the daemon; runNode then resolves 0. */
  readonly signal: AbortSignal
  /** The openshell executable (default "openshell" on PATH). */
  readonly openshellBinary?: string
}

interface OpenShellSetup {
  readonly runtime: Runtime
  readonly backends: readonly string[]
  readonly recovered: readonly NodeLaunchReport[]
}

/** The openshell runtime, its backends and the sandboxes an earlier run left; undefined when the CLI is unusable. */
async function setupOpenShell(config: NodeConfig, credentials: SpokeCredentials, options: RunNodeOptions, env: Env, log: (line: string) => void): Promise<OpenShellSetup | undefined> {
  const openshell = config.openshell!
  const client = new OpenShellCli({ ...(options.openshellBinary ? { binary: options.openshellBinary } : {}), ...(openshell.gateway ? { gateway: openshell.gateway } : {}), env })
  try {
    await client.version({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (cause) {
    log(`openshell is enabled in node.json but the openshell CLI is not available (${(cause as Error).message}); offering the host runtime only`)
    return undefined
  }
  const runtime = createOpenShellRuntime({ client, roots: config.workspaceRoots, hubURL: credentials.server, openshell, ...(credentials.machineID ? { machineID: credentials.machineID } : {}) })
  const backends = await openshellBackends(client)
  let recovered: NodeLaunchReport[] = []
  if (credentials.machineID) {
    const sweep = await sweepSandboxes(client, credentials.machineID)
    for (const problem of sweep.problems) log(problem)
    recovered = sweep.launches
  } else log("config.json has no machine ID, so sandboxes from an earlier run cannot be found")
  log(`openshell: profiles ${runtime.info().profiles?.join(", ")}; backends ${backends.join(", ") || "unknown"}; ${recovered.length} sandbox(es) from an earlier run`)
  return { runtime, backends, recovered }
}

export async function runNode(options: RunNodeOptions): Promise<number> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const log = options.log ?? ((line: string) => process.stderr.write(`[hub node] ${line}\n`))

  const credentials = readSpokeCredentials(env, home)
  if (!credentials) {
    log("this machine is not enrolled with a hub (config.json has no machine token); enrol it with the OpenCode plugin's /hub dialog first")
    return 1
  }
  const file = nodeConfigPath(env, home)
  const { config, problems } = readNodeConfig(file)
  for (const problem of problems) log(`${file}: ${problem}`)
  if (config.workspaceRoots.length === 0) {
    log(`${file} lists no workspaceRoots, so this node can prepare no workspaces; add e.g. {"workspaceRoots": ["${home}/projects"]}`)
    return EXIT_CONFIG
  }

  if (options.signal.aborted) return 0
  const openshell = config.openshell?.enabled ? await setupOpenShell(config, credentials, options, env, log) : undefined
  const runtimes: Runtime[] = [new HostRuntime({ roots: config.workspaceRoots }), ...(openshell ? [openshell.runtime] : [])]

  const daemon = new NodeDaemon({
    config,
    credentials,
    runtimes,
    ...(openshell ? { backends: { openshell: openshell.backends }, recovered: openshell.recovered } : {}),
    onState: (state, error) => {
      if (state === "connected") log(`connected to ${credentials.server}`)
      else if (state === "unsupported") log(`${error ?? "the hub does not serve nodes"}; retrying later`)
      else if (state === "revoked") log("this machine was revoked on the hub; stopping")
      else if (state === "error" && error) log(`not connected: ${error}`)
    },
  })
  log(`hub node ${NODE_VERSION}: ${config.slots} slots, roots ${config.workspaceRoots.join(", ")}`)
  daemon.start()
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) return resolve()
    options.signal.addEventListener("abort", () => resolve(), { once: true })
  })
  daemon.stop()
  log("stopped")
  return 0
}
