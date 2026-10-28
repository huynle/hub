// How the Hub plugin and the hubctl MCP server sit in an OpenCode 2 config (opencode.json / opencode.jsonc).
//
// OpenCode 2's config schema (@opencode/schema, Config): `plugins` is an array of package specs, each a string or
// `{ package, options? }`; `mcp.servers` maps a server name to `{ type: "local", command: string[], environment?,
// disabled?, … }` or `{ type: "remote", url, … }`. This module only reads: it classifies what is there and computes the
// exact JSON-pointer sets for the lossless JSONC merge (transaction/json-merge.ts), which edits nothing else.
//
//   plugin   absent → append the spec to /plugins; registered (an exact or unpinned npm entry, or the user's own
//            checkout/GitHub install) → nothing; drift (an older pin, or the legacy name @huynle/opencode-voice) →
//            replace just that entry's spec; a duplicate, or a pin newer than this hubctl → conflict (refused).
//   mcp      absent → add mcp.servers.hub; registered (hubctl at the stable authority) → nothing; stale (a hub/hubctl
//            `mcp` at another path, e.g. the plugin's launcher in the hub state dir) → replace only its command;
//            another server named hub, or hub's mcp under another name → conflict (refused).
//   text     unparseable JSONC or duplicate keys → manual_edit_required; a shape hubctl cannot merge into → conflict.
import { compareVersions, SEMVER, type ConfigSet, type Json } from "../../contracts/index.ts"
import { parseJsonc } from "../../transaction/json-merge.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"

/** The npm package of the Hub OpenCode plugin. */
export const HUB_PLUGIN_PACKAGE = "@huynle/hub"
/** The plugin's former name; its last release only re-exports @huynle/hub, so both would load the plugin twice. */
export const LEGACY_PLUGIN_PACKAGE = "@huynle/opencode-voice"
/** The name hubctl's MCP server is registered under. */
export const HUB_MCP_NAME = "hub"
/** The subcommand an MCP client runs (the command is implied by register-mcp-server, never carried by a plan). */
export const MCP_SUBCOMMAND = "mcp"
/** Program names that are hub's one command surface (contract COMMAND_ALIASES). */
const HUB_PROGRAMS = new Set(["hub", "hubctl"])

export interface DesiredRegistration {
  /** The absolute path of the stable hubctl authority the MCP server runs. */
  readonly authority: string
  /** Pin the plugin to this exact version (this hubctl's own); unpinned when absent. */
  readonly pluginVersion?: string
}

export type PluginSource = "npm" | "legacy" | "custom"

export type PluginState =
  | { readonly state: "absent" }
  | { readonly state: "registered"; readonly pointer: string; readonly source: PluginSource; readonly found?: string }
  | { readonly state: "drift"; readonly pointer: string; readonly source: PluginSource; readonly found?: string; readonly object: boolean }

export type McpState = { readonly state: "absent" } | { readonly state: "registered" } | { readonly state: "stale"; readonly found: string }

export type FindingCode =
  | "plugin-unpinned"
  | "plugin-custom-source"
  | "plugin-legacy-name"
  | "plugin-drift"
  | "mcp-stale-authority"
  | "harness-user-installed"
  | "harness-newer-than-pin"

/** Something worth telling the user that needs no refusal (secret-free: specs, versions and paths only). */
export interface Finding {
  readonly code: FindingCode
  readonly message: string
}

export interface ConfigInspection {
  readonly plugin: PluginState
  readonly mcp: McpState
  readonly findings: readonly Finding[]
}

type Value = null | boolean | number | string | Value[] | { [key: string]: Value }
const isObject = (v: unknown): v is { [key: string]: Value } => typeof v === "object" && v !== null && !Array.isArray(v)
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1)

/** The desired plugin spec: `@huynle/hub`, or `@huynle/hub@<version>` when pinned. */
export const pluginSpec = (desired: { readonly pluginVersion?: string }): string => (desired.pluginVersion ? `${HUB_PLUGIN_PACKAGE}@${desired.pluginVersion}` : HUB_PLUGIN_PACKAGE)

/** What a plugin spec names: the hub plugin (from npm, by its legacy name, or a custom source) or something else. */
export function classifyPluginSpec(spec: string): { readonly source: PluginSource; readonly version?: string } | undefined {
  const npm = spec.startsWith("npm:") ? spec.slice(4) : spec
  for (const [pkg, source] of [
    [HUB_PLUGIN_PACKAGE, "npm"],
    [LEGACY_PLUGIN_PACKAGE, "legacy"],
  ] as const) {
    if (npm === pkg) return { source }
    if (npm.startsWith(`${pkg}@`)) {
      const v = npm.slice(pkg.length + 1)
      return SEMVER.test(v) ? { source, version: v } : { source }
    }
  }
  // The user's own install of the plugin: a GitHub spec, or a checkout named hub (README: { "package": "/path/to/hub" }).
  if (/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)huynle\/hub(?:\.git)?(?:#.*)?$/.test(spec)) return { source: "custom" }
  const path = spec.startsWith("file://") ? spec.slice(7) : spec
  if (path.startsWith("/") && basename(path.replace(/\/+$/, "")) === "hub") return { source: "custom" }
  return undefined
}

const specOf = (entry: Value): string | undefined => (typeof entry === "string" ? entry : isObject(entry) && typeof entry.package === "string" ? entry.package : undefined)

const parse = (text: string): TxResult<{ [key: string]: Value }> => {
  const parsed = parseJsonc(text)
  if (!parsed.ok) return txFail("manual_edit_required", `the OpenCode config cannot be edited losslessly (${parsed.message}); make the edit by hand`)
  if (!isObject(parsed.value)) return txFail("conflict", "the OpenCode config is not a JSON object")
  return txOk(parsed.value)
}

function inspectPlugin(config: { [key: string]: Value }, desired: DesiredRegistration, findings: Finding[]): TxResult<PluginState> {
  const found: { pointer: string; spec: string; object: boolean; source: PluginSource; version?: string }[] = []
  // `plugins` is OpenCode 2's key; `plugin` is OpenCode 1's, still found in older configs.
  for (const key of ["plugins", "plugin"]) {
    const list = config[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) return txFail("conflict", `"${key}" in the OpenCode config is not a list; fix it by hand`)
    list.forEach((entry, i) => {
      const spec = specOf(entry)
      const kind = spec === undefined ? undefined : classifyPluginSpec(spec)
      if (kind) found.push({ pointer: `/${key}/${i}`, spec: spec!, object: isObject(entry), ...kind })
    })
  }
  if (found.length === 0) return txOk({ state: "absent" })
  if (found.length > 1)
    return txFail("conflict", `the Hub plugin is listed ${found.length} times (${found.map((f) => `${f.pointer} ${f.spec}`).join(", ")}); OpenCode would load only one of them, so remove all but one by hand`)
  const entry = found[0]!
  const base = { pointer: entry.pointer, source: entry.source, ...(entry.version ? { found: entry.version } : {}) }
  if (entry.source === "custom") {
    findings.push({ code: "plugin-custom-source", message: `the Hub plugin comes from ${entry.spec} (your own install); hubctl leaves it as it is` })
    return txOk({ state: "registered", ...base })
  }
  if (entry.source === "legacy") {
    findings.push({ code: "plugin-legacy-name", message: `${entry.spec} is the plugin's old name; it becomes ${pluginSpec(desired)}` })
    return txOk({ state: "drift", ...base, object: entry.object })
  }
  if (!desired.pluginVersion) return txOk({ state: "registered", ...base })
  if (!entry.version) {
    findings.push({ code: "plugin-unpinned", message: `${entry.spec} tracks the latest release; this hubctl is ${desired.pluginVersion}` })
    return txOk({ state: "registered", ...base })
  }
  const order = compareVersions(entry.version, desired.pluginVersion)
  if (order === 0) return txOk({ state: "registered", ...base })
  if (order > 0) return txFail("conflict", `the OpenCode config pins the Hub plugin ${entry.version}, newer than this hubctl (${desired.pluginVersion}); upgrade hubctl or change the pin by hand`)
  findings.push({ code: "plugin-drift", message: `the Hub plugin is pinned to ${entry.version}; it becomes ${pluginSpec(desired)}` })
  return txOk({ state: "drift", ...base, object: entry.object })
}

const isHubMcp = (server: Value): server is { [key: string]: Value } & { command: string[] } =>
  isObject(server) &&
  server.type === "local" &&
  Array.isArray(server.command) &&
  server.command.length === 2 &&
  server.command.every((w) => typeof w === "string") &&
  HUB_PROGRAMS.has(basename(server.command[0] as string)) &&
  server.command[1] === MCP_SUBCOMMAND

function inspectMcp(config: { [key: string]: Value }, desired: DesiredRegistration, findings: Finding[]): TxResult<McpState> {
  const mcp = config.mcp
  if (mcp === undefined) return txOk({ state: "absent" })
  if (!isObject(mcp)) return txFail("conflict", '"mcp" in the OpenCode config is not an object; fix it by hand')
  const servers = mcp.servers
  if (servers === undefined) return txOk({ state: "absent" })
  if (!isObject(servers)) return txFail("conflict", '"mcp.servers" in the OpenCode config is not an object; fix it by hand')
  const elsewhere = Object.entries(servers).find(([name, server]) => name !== HUB_MCP_NAME && isHubMcp(server))
  if (elsewhere) return txFail("conflict", `hub's MCP server is already registered as "${elsewhere[0]}"; remove it or rename it to "${HUB_MCP_NAME}" by hand`)
  const server = servers[HUB_MCP_NAME]
  if (server === undefined) return txOk({ state: "absent" })
  if (!isHubMcp(server)) return txFail("conflict", `another MCP server is already named "${HUB_MCP_NAME}" in the OpenCode config; hubctl will not replace it`)
  if (server.command[0] === desired.authority) return txOk({ state: "registered" })
  findings.push({ code: "mcp-stale-authority", message: `the hub MCP server runs ${server.command[0]}; it becomes ${desired.authority}` })
  return txOk({ state: "stale", found: server.command[0]! })
}

/** Classifies the config's Hub registrations (undefined text: the file does not exist). Reads only. */
export function inspectOpencodeConfig(text: string | undefined, desired: DesiredRegistration): TxResult<ConfigInspection> {
  if (text === undefined) return txOk({ plugin: { state: "absent" }, mcp: { state: "absent" }, findings: [] })
  const config = parse(text)
  if (!config.ok) return config
  const findings: Finding[] = []
  const plugin = inspectPlugin(config.value, desired, findings)
  if (!plugin.ok) return plugin
  const mcp = inspectMcp(config.value, desired, findings)
  if (!mcp.ok) return mcp
  return txOk({ plugin: plugin.value, mcp: mcp.value, findings })
}

/** The merge-config sets that register the plugin (none when it already is). */
export function pluginSets(plugin: PluginState, desired: { readonly pluginVersion?: string }): ConfigSet[] {
  const spec = pluginSpec(desired)
  switch (plugin.state) {
    case "absent":
      return [{ pointer: "/plugins/-", value: spec }]
    case "drift":
      return [{ pointer: plugin.object ? `${plugin.pointer}/package` : plugin.pointer, value: spec }]
    case "registered":
      return []
  }
}

/** The MCP server entry hubctl registers: this hubctl's `mcp` subcommand at the stable authority. */
export const mcpServerValue = (authority: string): Json => ({ type: "local", command: [authority, MCP_SUBCOMMAND] })

/**
 * The sets that register hubctl's MCP server in this config text (computed at apply, from the file as it is then):
 * the whole entry when absent, only the command when it is stale, nothing when it is registered.
 */
export function mcpServerSets(text: string | undefined, authority: string): TxResult<ConfigSet[]> {
  const inspected = inspectOpencodeConfig(text, { authority })
  if (!inspected.ok) return inspected
  const at = `/mcp/servers/${HUB_MCP_NAME}`
  switch (inspected.value.mcp.state) {
    case "absent":
      return txOk([{ pointer: at, value: mcpServerValue(authority) }])
    case "stale":
      return txOk([{ pointer: `${at}/command`, value: [authority, MCP_SUBCOMMAND] }])
    case "registered":
      return txOk([])
  }
}
