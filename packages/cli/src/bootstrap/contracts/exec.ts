// The executable contract. `hub` and `hubctl` are two names for one command surface: the name never changes what a
// caller may do (credentials, scopes and grants do). The CLI runs either as a standalone compiled binary (a signed
// hubctl with the Bun runtime and its assets embedded) or as a script under a runtime (the npm package, or the
// OpenCode binary acting as bun). Services always start it with an argv word list built here, never a shell string,
// and their unit templates are embedded assets so a standalone binary needs nothing beside it on disk.
import path from "node:path"
import { isAbsolutePath } from "./validate.ts"

export const COMMAND_ALIASES = ["hub", "hubctl"] as const
export type CommandAlias = (typeof COMMAND_ALIASES)[number]

/** The single command surface both names resolve to; undefined for any other program name. */
export function commandSurface(argv0: string): "hub-cli" | undefined {
  return (COMMAND_ALIASES as readonly string[]).includes(path.basename(argv0)) ? "hub-cli" : undefined
}

export type ProgramLayout =
  /** A compiled hubctl: the executable is the whole program. */
  | { readonly kind: "standalone"; readonly executable: string }
  /** A script (hub-cli.js) run by a runtime (bun, node, or OpenCode with BUN_BE_BUN=1). */
  | { readonly kind: "script"; readonly runtime: string; readonly entry: string }

/** Where `bun build --compile` mounts the embedded entry (POSIX and Windows forms). */
const EMBEDDED_PREFIXES = ["/$bunfs/", "B:/~BUN/", "B:\\~BUN\\"]

/** This process's layout from process.execPath and the (real path of) process.argv[1]. */
export function programLayout(program: { readonly execPath: string; readonly entry: string }): ProgramLayout {
  if (EMBEDDED_PREFIXES.some((p) => program.entry.startsWith(p))) return { kind: "standalone", executable: program.execPath }
  return { kind: "script", runtime: program.execPath, entry: program.entry }
}

export const SERVICE_IDS = ["node", "claude-code", "codex-spoke"] as const
export type ServiceID = (typeof SERVICE_IDS)[number]

/** The subcommand each long-running service runs (after the program words). */
export const SERVICE_COMMANDS: Readonly<Record<ServiceID, readonly string[]>> = Object.freeze({
  node: ["node", "run"],
  "claude-code": ["claude-code", "daemon"],
  "codex-spoke": ["codex-spoke", "serve"],
})

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** The argv a service unit starts: absolute program words, then the service's subcommand. Throws on unsafe paths. */
export function serviceArgv(layout: ProgramLayout, service: ServiceID): string[] {
  const program = layout.kind === "standalone" ? [layout.executable] : [layout.runtime, layout.entry]
  for (const word of program) if (!isAbsolutePath(word) || CONTROL.test(word)) throw new Error(`service argv needs absolute, single-line paths, not ${JSON.stringify(word)}`)
  const command = SERVICE_COMMANDS[service]
  if (!command) throw new Error(`unknown service ${String(service)}`)
  return [...program, ...command]
}

export type AssetKind = "launchd-plist" | "systemd-unit"

export interface EmbeddedAsset {
  readonly kind: AssetKind
  readonly service: ServiceID
  readonly manager: "launchd" | "systemd-user"
  /** The repository file it is embedded from (the template the source install reads today). */
  readonly source: string
  /** The file name it is installed as. */
  readonly installAs: string
}

/** Every service template a standalone hubctl must carry inside the binary. */
export const EMBEDDED_ASSETS: Readonly<Record<string, EmbeddedAsset>> = Object.freeze({
  "service/launchd/node": { kind: "launchd-plist", service: "node", manager: "launchd", source: "scripts/io.github.huynle.hub-node.plist", installAs: "io.github.huynle.hub-node.plist" },
  "service/systemd-user/node": { kind: "systemd-unit", service: "node", manager: "systemd-user", source: "scripts/hub-node.service", installAs: "hub-node.service" },
  "service/launchd/claude-code": { kind: "launchd-plist", service: "claude-code", manager: "launchd", source: "scripts/io.github.huynle.hub-claude-code.plist", installAs: "io.github.huynle.hub-claude-code.plist" },
  "service/systemd-user/claude-code": { kind: "systemd-unit", service: "claude-code", manager: "systemd-user", source: "scripts/hub-claude-code.service", installAs: "hub-claude-code.service" },
  "service/launchd/codex-spoke": { kind: "launchd-plist", service: "codex-spoke", manager: "launchd", source: "scripts/io.github.huynle.hub-codex-spoke.plist", installAs: "io.github.huynle.hub-codex-spoke.plist" },
  "service/systemd-user/codex-spoke": { kind: "systemd-unit", service: "codex-spoke", manager: "systemd-user", source: "scripts/hub-codex-spoke.service", installAs: "hub-codex-spoke.service" },
})
