// `hub node openshell check` (design §6.4, decision lk6gn3u7, spike report gut64rwq): can this node run sandboxed
// launches? It reads node.json's `openshell` section and asks the openshell CLI only read-only questions (--version,
// status, workspace list, provider list), in the order a launch needs them. It never creates or changes anything:
// for a missing workspace it prints the command to run. A `fail` is something that stops sandboxed launches (exit 1);
// a `warn` is something that likely makes them useless (no model provider, an image the gateway cannot pull).
import { nodeConfigPath, readNodeConfig } from "../../node/src/index.ts"
import { OpenShellCli, OpenShellError, OPENSHELL_WORKSPACE, SUPPORTED_VERSIONS, type OpenShellClient } from "../../runtime-openshell/src/cli.ts"
import { DEFAULT_PROFILE } from "../../runtime-openshell/src/profiles.ts"
import { DEFAULT_SANDBOX_IMAGE } from "../../runtime-openshell/src/runtime.ts"
import type { Env } from "./credentials"

export type CheckStatus = "ok" | "warn" | "fail" | "skip"

export interface CheckItem {
  /** config, profiles, default-providers, image, cli, gateway, workspace, providers */
  readonly check: string
  readonly status: CheckStatus
  readonly message: string
  readonly hint?: string
}

export interface OpenShellCheckReport {
  /** No `fail` (warnings allowed). */
  readonly ok: boolean
  /** The node.json read. */
  readonly file: string
  readonly checks: readonly CheckItem[]
}

export interface OpenShellCheckOptions {
  readonly env: Env
  readonly home: string
  /** The openshell executable (default "openshell" on PATH). */
  readonly binary?: string
  /** Instead of the CLI (tests). */
  readonly client?: OpenShellClient
}

const EXAMPLE = `{"openshell": {"enabled": true, "image": "ghcr.io/<owner>/hub-sandbox:<tag>", "profiles": {"default": {"providers": ["<provider>"]}}}}`
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const item = (check: string, status: CheckStatus, message: string, hint?: string): CheckItem => ({ check, status, message, ...(hint ? { hint } : {}) })

/** Why an image reference likely cannot be pulled by OpenShell's vm driver (HTTPS registries only); undefined: fine. */
export function imageConcern(image: string): string | undefined {
  const slash = image.indexOf("/")
  const first = slash < 0 ? "" : image.slice(0, slash)
  const hasHost = first === "localhost" || first.includes(".") || first.includes(":")
  if (!hasHost) return `${image} has no registry host, so the gateway looks for it on Docker Hub; OpenShell's vm driver does not use local Docker images, so it must be published to an HTTPS registry`
  const host = first.replace(/:\d+$/, "")
  if (host === "localhost" || /^127\./.test(host) || host === "[::1]" || host.endsWith(".local")) return `${image} is on a local registry; OpenShell's vm driver pulls over HTTPS only and refuses plain-http local registries`
  return undefined
}

/** The checks node.json alone can answer. */
function configChecks(env: Env, home: string): { file: string; checks: CheckItem[]; providers: Map<string, string[]>; usable: boolean; gateway?: string } {
  const file = nodeConfigPath(env, home)
  const { config, problems } = readNodeConfig(file)
  const checks: CheckItem[] = []
  const providers = new Map<string, string[]>()
  const openshell = config.openshell
  const configProblems = problems.filter((p) => !/^openshell\.profiles\.[^:]+: unsupported \(/.test(p))
  for (const p of configProblems) checks.push(item("config", "fail", p))
  if (!openshell) {
    checks.push(item("config", "fail", `${file} has no openshell section`, `add one, e.g. ${EXAMPLE}`))
    return { file, checks, providers, usable: false }
  }
  if (configProblems.length === 0) {
    if (openshell.enabled) checks.push(item("config", "ok", `${file}: openshell enabled${openshell.gateway ? ` (gateway ${openshell.gateway})` : ""}`))
    else checks.push(item("config", "warn", `${file}: openshell.enabled is not true, so the node does not offer sandboxes`, 'set "enabled": true in the openshell section'))
  }

  const set = openshell.profiles
  const names = Object.keys(set.profiles).sort()
  checks.push(item("profiles", "ok", `usable profiles: ${names.join(", ") || "none"}`))
  for (const [name, reason] of Object.entries(set.unsupported)) checks.push(item("profiles", "fail", `profile ${name} is unsupported: ${reason}`, "remove mounts, cpu and memory from it"))

  const fallback = set.profiles[DEFAULT_PROFILE]
  if (!fallback) checks.push(item("default-providers", "skip", `no usable ${DEFAULT_PROFILE} profile`))
  else if (fallback.providers.length === 0)
    checks.push(item("default-providers", "warn", `the ${DEFAULT_PROFILE} profile names no providers, so a sandboxed agent cannot reach a model`, `create a provider in workspace ${OPENSHELL_WORKSPACE} (openshell --workspace ${OPENSHELL_WORKSPACE} provider create --name <name> --type <type> …) and list it in openshell.profiles.${DEFAULT_PROFILE}.providers`))
  else checks.push(item("default-providers", "ok", `the ${DEFAULT_PROFILE} profile uses ${fallback.providers.join(", ")}`))

  const images = new Map<string, string[]>()
  for (const name of names) {
    const profile = set.profiles[name]!
    const image = profile.image ?? openshell.image ?? DEFAULT_SANDBOX_IMAGE
    images.set(image, [...(images.get(image) ?? []), name])
    for (const provider of profile.providers) providers.set(provider, [...(providers.get(provider) ?? []), name])
  }
  for (const [image, users] of images) {
    const concern = imageConcern(image)
    const who = `profile${users.length > 1 ? "s" : ""} ${users.join(", ")}`
    if (image === DEFAULT_SANDBOX_IMAGE && !openshell.image && !users.some((u) => set.profiles[u]!.image))
      checks.push(item("image", "warn", `no image configured (${who} get ${image}, a local build name)`, "publish the sandbox image to an HTTPS registry and set openshell.image"))
    else if (concern) checks.push(item("image", "warn", `${concern} (${who})`, "publish it to an HTTPS registry (e.g. ghcr.io) and point openshell.image at it"))
    else checks.push(item("image", "ok", `${image} (${who})`))
  }
  return { file, checks, providers, usable: true, ...(openshell.gateway ? { gateway: openshell.gateway } : {}) }
}

export async function checkOpenShell(options: OpenShellCheckOptions): Promise<OpenShellCheckReport> {
  const local = configChecks(options.env, options.home)
  const checks = [...local.checks]
  const client: OpenShellClient =
    options.client ?? new OpenShellCli({ ...(options.binary ? { binary: options.binary } : {}), ...(local.gateway ? { gateway: local.gateway } : {}), env: options.env })
  const skip = (check: string, why: string) => checks.push(item(check, "skip", why))

  let reachable = false
  try {
    const version = await client.version()
    checks.push(item("cli", "ok", `openshell ${version} (supported ${SUPPORTED_VERSIONS})`))
    try {
      const status = await client.status()
      if (status.connected && status.authenticated) {
        reachable = true
        checks.push(item("gateway", "ok", `gateway ${status.gateway || "(active)"} at ${status.server} is connected`))
      } else checks.push(item("gateway", "fail", `gateway ${status.gateway || "(active)"} is ${status.connected ? "connected but not authenticated" : "not connected"}`, "see `openshell status` and `openshell gateway --help`"))
    } catch (cause) {
      checks.push(item("gateway", "fail", errorText(cause), "see `openshell status`"))
    }
  } catch (cause) {
    const notInstalled = cause instanceof OpenShellError && cause.code === "not_installed"
    checks.push(item("cli", "fail", errorText(cause), notInstalled ? "install the NVIDIA OpenShell CLI (and its gateway) on this machine" : `this hub speaks openshell ${SUPPORTED_VERSIONS}`))
    skip("gateway", "the openshell CLI is not usable")
  }

  if (!reachable) {
    skip("workspace", "the gateway is not reachable")
    skip("providers", "the gateway is not reachable")
  } else {
    try {
      const workspaces = client.workspaces ? await client.workspaces() : []
      if (workspaces.includes(OPENSHELL_WORKSPACE)) checks.push(item("workspace", "ok", `${OPENSHELL_WORKSPACE} exists`))
      else checks.push(item("workspace", "fail", `the gateway has no workspace ${OPENSHELL_WORKSPACE} (the hub's sandboxes live there)`, `create it (not run by hub): openshell workspace create --name ${OPENSHELL_WORKSPACE}`))
    } catch (cause) {
      checks.push(item("workspace", "fail", errorText(cause)))
    }
    if (local.providers.size === 0) skip("providers", "no profile names a provider")
    else {
      try {
        const existing = new Set(client.providers ? await client.providers() : [])
        const missing = [...local.providers].filter(([name]) => !existing.has(name))
        for (const [name, users] of missing)
          checks.push(item("providers", "fail", `provider ${name} (profile${users.length > 1 ? "s" : ""} ${users.join(", ")}) does not exist in workspace ${OPENSHELL_WORKSPACE}`, `create it: openshell --workspace ${OPENSHELL_WORKSPACE} provider create --name ${name} --type <type> …`))
        if (missing.length === 0) checks.push(item("providers", "ok", `found ${[...local.providers.keys()].join(", ")}`))
      } catch (cause) {
        checks.push(item("providers", "fail", errorText(cause)))
      }
    }
  }
  return { ok: !checks.some((c) => c.status === "fail"), file: local.file, checks }
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" }

export function openShellCheckText(report: OpenShellCheckReport): string {
  const lines: string[] = []
  for (const c of report.checks) {
    lines.push(`${MARK[c.status]}  ${c.check}: ${c.message}`)
    if (c.hint && c.status !== "ok") lines.push(`        hint: ${c.hint}`)
  }
  const fails = report.checks.filter((c) => c.status === "fail").length
  const warns = report.checks.filter((c) => c.status === "warn").length
  lines.push(fails ? `${fails} problem${fails > 1 ? "s" : ""}${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}` : `no problems${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}`)
  return lines.join("\n")
}
