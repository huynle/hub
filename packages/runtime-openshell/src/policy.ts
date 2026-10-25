// Compiles a hub profile into an OpenShell sandbox policy (decision lk6gn3u7 §7; OpenShell 0.1.x policy schema
// version 1). Deny by default: the policy holds only these network rules, each for the harness binary alone
// (OpenShell matches a connection's ancestors too, so the agent's shells and git inherit the harness's egress):
//
//   hub            the hub, protocol tcp: the supervisor proxy relays it without terminating TLS. A loopback hub is
//                  reached through host.openshell.internal (OpenShell never authorizes loopback destinations).
//   git_remote     the launch's git remote, only when the profile sets allowGitRemote (https inspected; ssh tcp).
//   profile_egress the profile's extra endpoints, minus any host:port an earlier rule already has.
//
// Model provider endpoints are not listed: attached OpenShell providers contribute their own `_provider_*` rules,
// and the keys stay in OpenShell's proxy. The filesystem section is OpenShell's documented baseline plus the
// sandbox working directory and /sandbox.
//
// Every value is validated before it gets here and every string is emitted double-quoted (JSON strings are YAML
// scalars), so no input can add keys to the document.
import { isGitRemote } from "../../protocol/src/index.ts"
import { RuntimeError } from "../../runtime-sdk/src/index.ts"
import { egressHost, type EgressEndpoint, type OpenShellProfile } from "./profiles.ts"

/** The only binary the policy lets out: the harness baked into the sandbox image. */
export const HARNESS_BINARY = "/usr/local/bin/opencode"
/** How a sandbox reaches the gateway host (and so a loopback-bound hub). */
export const SANDBOX_HOST_ALIAS = "host.openshell.internal"

const READ_ONLY = ["/usr", "/lib", "/bin", "/etc", "/app", "/var/log", "/proc", "/dev/urandom"]
const READ_WRITE = ["/sandbox", "/tmp", "/dev/null"]
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 }

/** A destination in a network rule; `tcp` relays the raw connection (no TLS termination, no request checks). */
export interface PolicyEndpoint extends EgressEndpoint {
  readonly protocol?: "tcp"
}

/** The hub as the sandbox sees it: the policy endpoint and the URL the harness inside connects to. */
export interface HubEndpoint {
  readonly host: string
  readonly port: number
  readonly url: string
}

export interface PolicyInput {
  /** The hub URL as the node knows it (config.json `server`). */
  readonly hubURL: string
  readonly profile: OpenShellProfile
  /** The launch's workspace remote; allowed only when the profile sets allowGitRemote. */
  readonly gitRemote?: string
}

export interface CompiledPolicy {
  /** The policy document for `openshell sandbox create --policy`. */
  readonly yaml: string
  /** OpenShell providers to attach (`--provider`), whose rules and credentials OpenShell adds itself. */
  readonly providers: readonly string[]
  /** The hub URL to hand the harness inside the sandbox. */
  readonly hubURL: string
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)

/** Where the sandbox reaches the hub; RuntimeError when the URL is not one a policy can allow. */
export function sandboxHubEndpoint(hubURL: string): HubEndpoint {
  let url: URL
  try {
    url = new URL(hubURL)
  } catch {
    throw new RuntimeError("the hub URL is not an http(s) or ws(s) URL")
  }
  const defaultPort = DEFAULT_PORTS[url.protocol]
  if (defaultPort === undefined || !url.hostname) throw new RuntimeError("the hub URL is not an http(s) or ws(s) URL")
  const port = url.port ? Number(url.port) : defaultPort
  if (isLoopback(url.hostname)) {
    url.hostname = SANDBOX_HOST_ALIAS
    return { host: SANDBOX_HOST_ALIAS, port, url: url.href }
  }
  const host = url.hostname.includes("*") ? undefined : egressHost(url.hostname)
  if (!host) throw new RuntimeError(`the hub's host ${url.hostname.replace(/^\[|\]$/g, "")} cannot be allowed in a sandbox policy`)
  return { host, port, url: url.href }
}

/** The endpoint a git remote needs: https (443) inspected, ssh or scp-style (22) tcp; undefined when unusable. */
export function gitRemoteEndpoint(remote: string): PolicyEndpoint | undefined {
  if (!isGitRemote(remote)) return undefined
  let host: string | undefined
  let port: number
  let tcp: boolean
  const scp = /^[^@/]+@([^:/]+):/.exec(remote)
  if (scp?.[1]) {
    host = scp[1]
    port = 22
    tcp = true
  } else {
    const url = new URL(remote)
    host = url.hostname
    tcp = url.protocol === "ssh:"
    port = url.port ? Number(url.port) : tcp ? 22 : 443
  }
  const clean = egressHost(host)
  if (!clean || clean.includes("*") || isLoopback(clean)) return undefined
  return tcp ? { host: clean, port, protocol: "tcp" } : { host: clean, port }
}

interface Rule {
  readonly key: string
  readonly name: string
  readonly endpoints: readonly PolicyEndpoint[]
}

const q = (s: string) => JSON.stringify(s)

function emit(profile: string, rules: readonly Rule[]): string {
  const lines = [
    `# hub sandbox policy for profile ${profile}: deny by default; only the rules below allow egress.`,
    "version: 1",
    "",
    "filesystem_policy:",
    "  include_workdir: true",
    "  read_only:",
    ...READ_ONLY.map((p) => `    - ${q(p)}`),
    "  read_write:",
    ...READ_WRITE.map((p) => `    - ${q(p)}`),
    "",
    "landlock:",
    "  compatibility: best_effort",
    "",
    "network_policies:",
  ]
  for (const rule of rules) {
    lines.push(`  ${rule.key}:`, `    name: ${q(rule.name)}`, "    endpoints:")
    for (const e of rule.endpoints) {
      lines.push(`      - host: ${q(e.host)}`, `        port: ${e.port}`)
      if (e.protocol) lines.push(`        protocol: ${e.protocol}`)
    }
    lines.push("    binaries:", `      - path: ${q(HARNESS_BINARY)}`)
  }
  return lines.join("\n") + "\n"
}

/** The OpenShell policy, providers and in-sandbox hub URL for a launch with this profile. */
export function compilePolicy(input: PolicyInput): CompiledPolicy {
  const hub = sandboxHubEndpoint(input.hubURL)
  const rules: Rule[] = [{ key: "hub", name: "hub", endpoints: [{ host: hub.host, port: hub.port, protocol: "tcp" }] }]

  if (input.profile.allowGitRemote && input.gitRemote !== undefined) {
    const git = gitRemoteEndpoint(input.gitRemote)
    if (!git) throw new RuntimeError("the launch's git remote has no host the sandbox can reach")
    rules.push({ key: "git_remote", name: "git-remote", endpoints: [git] })
  }

  const taken = new Set(rules.flatMap((r) => r.endpoints.map((e) => `${e.host}:${e.port}`)))
  const extras = input.profile.endpoints.filter((e) => !taken.has(`${e.host}:${e.port}`))
  if (extras.length > 0) rules.push({ key: "profile_egress", name: "profile-egress", endpoints: extras.map((e) => ({ host: e.host, port: e.port })) })

  return { yaml: emit(input.profile.name, rules), providers: [...input.profile.providers], hubURL: hub.url }
}
