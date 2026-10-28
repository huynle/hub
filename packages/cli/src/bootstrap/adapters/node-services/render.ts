// Renders the per-user service units of `hub node` and the harness spokes (`hub claude-code daemon`, `hub
// codex-spoke serve`) from the templates embedded in hubctl (EMBEDDED_ASSETS, release/assets.ts), never from
// scripts/ on disk, with the executable contract's argv (serviceArgv): a word list of absolute, single-line paths,
// one launchd <string> per word, or one systemd ExecStart= word per word (quoted and escaped). A unit carries only
// the service's own settings (where its config, state and harness binary are), each single-line, absolute and
// never a credential: the machine token stays in the CredentialStore, which the service reads at run time.
//
// Rendering is pure: the same input always gives the same bytes, so a plan can pin the unit's digest
// (install-service.sha256) and apply can render it again and compare.
import {
  Checker,
  EMBEDDED_ASSETS,
  isAbsolutePath,
  isSecretValue,
  pointer,
  serviceArgv,
  SERVICE_COMMANDS,
  sha256Hex,
  type PathRef,
  type ProgramLayout,
  type Result,
  type ServiceID,
  type ServiceManagerID,
} from "../../contracts/index.ts"
import { EMBEDDED_TEXT } from "../../release/assets.ts"

/** The settings each service may carry into its unit (as `hub <service> install` carries them today). */
export const SERVICE_ENVIRONMENT: Readonly<Record<ServiceID, readonly string[]>> = Object.freeze({
  node: ["HUB_SPOKE_CONFIG", "XDG_CONFIG_HOME", "HUB_CLAUDE_BIN", "HUB_CODEX_BIN"],
  "claude-code": ["HUB_SPOKE_CONFIG", "XDG_CONFIG_HOME", "HUB_STATE_DIR", "HUB_CLAUDE_SOCKET", "HUB_CLAUDE_BIN"],
  "codex-spoke": ["HUB_SPOKE_CONFIG", "XDG_CONFIG_HOME", "HUB_STATE_DIR", "CODEX_HOME", "HUB_CODEX_BIN", "HUB_CODEX_DAEMON_SOCKET"],
})

/** The named root each manager's units live in. */
export const UNIT_ROOT: Readonly<Record<ServiceManagerID, "launch-agents" | "systemd-user">> = Object.freeze({ launchd: "launch-agents", "systemd-user": "systemd-user" })

export interface RenderInput {
  readonly service: ServiceID
  readonly manager: ServiceManagerID
  /** How the service starts hubctl (programLayout of the hubctl that plans and applies). */
  readonly layout: ProgramLayout
  /** The home directory as the service sees it (the execution context's view). */
  readonly home: string
  /** Settings to carry, from SERVICE_ENVIRONMENT[service] only. */
  readonly environment?: Readonly<Record<string, string>>
  /** The command that writes the unit by hand ("hub node"): its header then names its install/uninstall (default: hubctl setup). */
  readonly writtenBy?: string
}

export interface RenderedUnit {
  /** The EMBEDDED_ASSETS id it was rendered from. */
  readonly asset: string
  readonly service: ServiceID
  readonly manager: ServiceManagerID
  /** Where it is installed: the manager's root and the asset's file name. */
  readonly path: PathRef
  /** The launchd label or the systemd unit name (what the service manager calls it). */
  readonly name: string
  readonly argv: readonly string[]
  readonly text: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

export const assetIDFor = (service: ServiceID, manager: ServiceManagerID): string => `service/${manager}/${service}`

/** The launchd label or systemd unit name of a service under a manager. */
export function serviceName(service: ServiceID, manager: ServiceManagerID): string {
  const file = EMBEDDED_ASSETS[assetIDFor(service, manager)]!.installAs
  return manager === "launchd" ? file.replace(/\.plist$/, "") : file
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

/** A word for a systemd command line or assignment: % and $ escaped, quoted when not plain (as node.ts does). */
const sd = (word: string) => {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$")
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(escaped) ? escaped : `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/** A home usable inside a systemd assignment without quoting (Environment=PATH=<home>/...). */
const SYSTEMD_HOME = /^\/[A-Za-z0-9_./@+,:-]*$/
const PLACEHOLDER = /__[A-Z]+__/

const header = (asset: string, by?: string) =>
  by ? `Written by ${by} install from the embedded asset ${asset}; ${by} uninstall removes it.` : `Written by hubctl setup from the embedded asset ${asset}; hubctl removes it only while it is unchanged.`

function checkEnvironment(c: Checker, service: ServiceID, environment: Readonly<Record<string, string>>): [string, string][] {
  const allowed = SERVICE_ENVIRONMENT[service]
  const out: [string, string][] = []
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key]!
    const at = pointer("/environment", key)
    if (!allowed.includes(key)) c.add(at, "invalid_value", `the ${service} service does not carry ${key}`)
    else if (typeof value === "string" && isSecretValue(value)) c.add(at, "secret", "service units never carry credentials")
    else if (!isAbsolutePath(value)) c.add(at, "invalid_value", `${key} must be an absolute, single-line path`)
    else out.push([key, value])
  }
  return out
}

function renderSystemd(c: Checker, asset: string, template: string, argv: readonly string[], command: readonly string[], home: string, env: [string, string][], by?: string): string {
  const execLine = /^ExecStart=(.*)$/m
  const found = template.match(execLine)?.[1]
  if (found !== "__ARGV__" && found !== `__RUNTIME__ __ENTRY__ ${command.join(" ")}`) c.add("/asset", "inconsistent", `${asset} does not start the ${command.join(" ")} command`)
  const body = template.slice(Math.max(0, template.indexOf("[Unit]")))
  const extra = env.map(([key, value]) => `\nEnvironment=${sd(`${key}=${value}`)}`).join("")
  return `# ${header(asset, by)}\n${body}`
    .replace(execLine, () => `ExecStart=${argv.map(sd).join(" ")}`)
    .replaceAll("__HOME__", home.replaceAll("%", "%%"))
    .replace(/(Environment=PATH=[^\n]*)/, (line) => `${line}${extra}`)
}

function renderLaunchd(c: Checker, asset: string, template: string, argv: readonly string[], command: readonly string[], home: string, env: [string, string][], by?: string): string {
  const programArguments = /(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(\n\s*<\/array>)/
  const match = template.match(programArguments)
  const words = [...(match?.[2] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  const expected = [["__ARGV__"], ["__RUNTIME__", "__ENTRY__", ...command]]
  if (!expected.some((e) => e.length === words.length && e.every((w, i) => w === words[i]))) c.add("/asset", "inconsistent", `${asset} does not start the ${command.join(" ")} command`)
  const indent = (match?.[2] ?? "").match(/\n(\s*)<string>/)?.[1] ?? "    "
  const extra = env.map(([key, value]) => `\n${indent}<key>${key}</key>\n${indent}<string>${xml(value)}</string>`).join("")
  return template
    .replace(/<!--[\s\S]*?-->/, () => `<!-- ${header(asset, by)} -->`)
    .replace(programArguments, (_all, open: string, _words: string, close: string) => `${open}${argv.map((w) => `\n${indent}<string>${xml(w)}</string>`).join("")}${close}`)
    .replaceAll("__HOME__", xml(home))
    .replace(/(<key>PATH<\/key>\s*<string>[^<]*<\/string>)/, (line) => `${line}${extra}`)
}

/** The unit for `service` under `manager`, rendered from its embedded template. */
export function renderServiceUnit(input: RenderInput): Result<RenderedUnit> {
  const c = new Checker()
  const asset = assetIDFor(input.service, input.manager)
  const entry = EMBEDDED_ASSETS[asset]
  const template = EMBEDDED_TEXT[asset]
  if (!entry || template === undefined) {
    c.add("/service", "invalid_value", `no embedded template for ${input.service} under ${input.manager}`)
    return c.result(undefined)
  }
  let argv: string[] = []
  try {
    argv = serviceArgv(input.layout, input.service)
  } catch (error) {
    c.add("/layout", "invalid_path", (error as Error).message)
  }
  const homeOK = isAbsolutePath(input.home) && input.home !== "/" && (input.manager !== "systemd-user" || SYSTEMD_HOME.test(input.home))
  if (!homeOK) c.add("/home", "invalid_path", "the service's home must be an absolute, normalized directory other than /")
  const env = checkEnvironment(c, input.service, input.environment ?? {})
  if (c.issues.length > 0) return c.result(undefined)

  const command = SERVICE_COMMANDS[input.service]
  const text =
    input.manager === "systemd-user"
      ? renderSystemd(c, asset, template, argv, command, input.home, env, input.writtenBy)
      : renderLaunchd(c, asset, template, argv, command, input.home, env, input.writtenBy)
  if (PLACEHOLDER.test(text)) c.add("/asset", "inconsistent", `${asset} has a placeholder this hubctl does not fill`)
  if (isSecretValue(text)) c.add("/environment", "secret", "service units never carry credentials")
  if (c.issues.length > 0) return c.result(undefined)
  const bytes = new TextEncoder().encode(text)
  return c.result<RenderedUnit>({
    asset,
    service: input.service,
    manager: input.manager,
    path: { root: UNIT_ROOT[input.manager], rel: entry.installAs },
    name: serviceName(input.service, input.manager),
    argv,
    text,
    bytes,
    sha256: `sha256:${sha256Hex(bytes)}`,
  })
}
