// `hub node`'s program: read the machine's credentials from the spoke's config.json (read-only) and the node's
// settings from node.json, then run the daemon until the signal aborts. Exit codes: 0 after a clean stop, 1 when
// the machine is not enrolled, EXIT_CONFIG (78, EX_CONFIG) when node.json gives the node nothing to do; the
// service units do not restart on 78.
import { homedir } from "node:os"
import { nodeConfigPath, readNodeConfig, readSpokeCredentials } from "./config.ts"
import { NodeDaemon, NODE_VERSION } from "./daemon.ts"

export const EXIT_CONFIG = 78

type Env = Readonly<Record<string, string | undefined>>

export interface RunNodeOptions {
  readonly env?: Env
  readonly home?: string
  /** One line per event (default stderr). Never given the token. */
  readonly log?: (line: string) => void
  /** Aborting stops the daemon; runNode then resolves 0. */
  readonly signal: AbortSignal
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

  const daemon = new NodeDaemon({
    config,
    credentials,
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
