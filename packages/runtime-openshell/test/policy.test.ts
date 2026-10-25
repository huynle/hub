// The profile → OpenShell policy compiler (decision lk6gn3u7 §7, design §6.4): deny all egress by default; allow
// the hub (protocol tcp, so the supervisor proxy never terminates its TLS) and, when the profile asks, the launch's
// git remote and extra endpoints, all only for the harness binary (OpenShell matches ancestors too, so the agent's
// shells inherit it). Model provider endpoints are not in the policy: attached OpenShell providers contribute their
// own `_provider_*` rules. Golden tests pin the exact YAML handed to `openshell sandbox create --policy`.
import { describe, expect, test } from "bun:test"
import { compilePolicy, gitRemoteEndpoint, HARNESS_BINARY, SANDBOX_HOST_ALIAS, sandboxHubEndpoint } from "../src/policy.ts"
import { normalizeOpenShellProfiles, selectProfile } from "../src/profiles.ts"

const profiles = normalizeOpenShellProfiles({
  "net-off": {},
  "untrusted-code": {
    image: "hub-sandbox:0.1.0",
    providers: ["anthropic", "openai-work"],
    endpoints: ["registry.npmjs.org:443", "*.pythonhosted.org:443", "host.openshell.internal:4096"],
    allowGitRemote: true,
  },
})
const netOff = selectProfile(profiles, "net-off")
const untrusted = selectProfile(profiles, "untrusted-code")

const FILESYSTEM = `filesystem_policy:
  include_workdir: true
  read_only:
    - "/usr"
    - "/lib"
    - "/bin"
    - "/etc"
    - "/app"
    - "/var/log"
    - "/proc"
    - "/dev/urandom"
  read_write:
    - "/sandbox"
    - "/tmp"
    - "/dev/null"

landlock:
  compatibility: best_effort
`

const GOLDEN_NET_OFF = `# hub sandbox policy for profile net-off: deny by default; only the rules below allow egress.
version: 1

${FILESYSTEM}
network_policies:
  hub:
    name: "hub"
    endpoints:
      - host: "host.openshell.internal"
        port: 4096
        protocol: tcp
    binaries:
      - path: "/usr/local/bin/opencode"
`

const GOLDEN_UNTRUSTED = `# hub sandbox policy for profile untrusted-code: deny by default; only the rules below allow egress.
version: 1

${FILESYSTEM}
network_policies:
  hub:
    name: "hub"
    endpoints:
      - host: "hub.example.com"
        port: 443
        protocol: tcp
    binaries:
      - path: "/usr/local/bin/opencode"
  git_remote:
    name: "git-remote"
    endpoints:
      - host: "github.com"
        port: 443
    binaries:
      - path: "/usr/local/bin/opencode"
  profile_egress:
    name: "profile-egress"
    endpoints:
      - host: "registry.npmjs.org"
        port: 443
      - host: "*.pythonhosted.org"
        port: 443
      - host: "host.openshell.internal"
        port: 4096
    binaries:
      - path: "/usr/local/bin/opencode"
`

describe("compilePolicy (golden)", () => {
  test("net-off with a loopback hub: only the hub, through host.openshell.internal", () => {
    const compiled = compilePolicy({ hubURL: "http://127.0.0.1:4096", profile: netOff })
    expect(compiled.yaml).toBe(GOLDEN_NET_OFF)
    expect(compiled.providers).toEqual([])
    expect(compiled.hubURL).toBe("http://host.openshell.internal:4096/")
  })

  test("untrusted-code with a public hub, a git remote and extra endpoints", () => {
    const compiled = compilePolicy({ hubURL: "https://hub.example.com/", profile: untrusted, gitRemote: "https://github.com/huynle/hub.git" })
    expect(compiled.yaml).toBe(GOLDEN_UNTRUSTED)
    expect(compiled.providers).toEqual(["anthropic", "openai-work"])
    expect(compiled.hubURL).toBe("https://hub.example.com/")
  })

  test("the YAML parses to the expected policy document", () => {
    const doc = Bun.YAML.parse(compilePolicy({ hubURL: "https://hub.example.com", profile: untrusted, gitRemote: "git@github.com:huynle/hub.git" }).yaml) as Record<string, any>
    expect(doc.version).toBe(1)
    expect(Object.keys(doc.network_policies)).toEqual(["hub", "git_remote", "profile_egress"])
    expect(doc.network_policies.git_remote.endpoints).toEqual([{ host: "github.com", port: 22, protocol: "tcp" }])
    expect(doc.network_policies.profile_egress.endpoints[1]).toEqual({ host: "*.pythonhosted.org", port: 443 })
    for (const rule of Object.values(doc.network_policies) as any[]) expect(rule.binaries).toEqual([{ path: HARNESS_BINARY }])
  })
})

describe("compilePolicy rules", () => {
  test("no git rule unless the profile allows it, even with a remote", () => {
    const doc = Bun.YAML.parse(compilePolicy({ hubURL: "https://hub.example.com", profile: netOff, gitRemote: "https://github.com/x/y.git" }).yaml) as Record<string, any>
    expect(Object.keys(doc.network_policies)).toEqual(["hub"])
  })

  test("allowGitRemote without a remote: no git rule", () => {
    const doc = Bun.YAML.parse(compilePolicy({ hubURL: "https://hub.example.com", profile: untrusted }).yaml) as Record<string, any>
    expect(Object.keys(doc.network_policies)).toEqual(["hub", "profile_egress"])
  })

  test("extra endpoints that repeat the hub or git endpoint are dropped (one rule per host:port)", () => {
    const set = normalizeOpenShellProfiles({ p: { endpoints: ["hub.example.com:443", "github.com:443", "pypi.org:443"], allowGitRemote: true } })
    const doc = Bun.YAML.parse(compilePolicy({ hubURL: "https://hub.example.com", profile: selectProfile(set, "p"), gitRemote: "https://github.com/x/y.git" }).yaml) as Record<string, any>
    expect(doc.network_policies.profile_egress.endpoints).toEqual([{ host: "pypi.org", port: 443 }])
  })

  test("a profile whose extras all repeat the hub gets no profile_egress rule", () => {
    const set = normalizeOpenShellProfiles({ p: { endpoints: ["hub.example.com:443"] } })
    const doc = Bun.YAML.parse(compilePolicy({ hubURL: "https://hub.example.com", profile: selectProfile(set, "p") }).yaml) as Record<string, any>
    expect(Object.keys(doc.network_policies)).toEqual(["hub"])
  })

  test("a bad hub URL is a RuntimeError", () => {
    expect(() => compilePolicy({ hubURL: "not a url", profile: netOff })).toThrow("the hub URL is not an http(s) or ws(s) URL")
    expect(() => compilePolicy({ hubURL: "ftp://hub.example.com", profile: netOff })).toThrow("the hub URL is not an http(s) or ws(s) URL")
  })

  test("an unusable git remote is a RuntimeError when the profile allows git", () => {
    expect(() => compilePolicy({ hubURL: "https://hub.example.com", profile: untrusted, gitRemote: "file:///srv/repo" })).toThrow("the launch's git remote has no host the sandbox can reach")
  })
})

describe("sandboxHubEndpoint", () => {
  test("loopback hubs are reached through host.openshell.internal; the URL keeps its path", () => {
    expect(sandboxHubEndpoint("http://localhost:4096")).toEqual({ host: SANDBOX_HOST_ALIAS, port: 4096, url: "http://host.openshell.internal:4096/" })
    expect(sandboxHubEndpoint("http://127.0.0.1:4096/hub")).toEqual({ host: SANDBOX_HOST_ALIAS, port: 4096, url: "http://host.openshell.internal:4096/hub" })
    expect(sandboxHubEndpoint("http://[::1]:4096")).toEqual({ host: SANDBOX_HOST_ALIAS, port: 4096, url: "http://host.openshell.internal:4096/" })
    expect(sandboxHubEndpoint("http://127.1.2.3:80")).toEqual({ host: SANDBOX_HOST_ALIAS, port: 80, url: "http://host.openshell.internal/" })
  })

  test("default ports by scheme", () => {
    expect(sandboxHubEndpoint("https://hub.example.com")).toEqual({ host: "hub.example.com", port: 443, url: "https://hub.example.com/" })
    expect(sandboxHubEndpoint("http://hub.example.com")).toEqual({ host: "hub.example.com", port: 80, url: "http://hub.example.com/" })
    expect(sandboxHubEndpoint("wss://hub.example.com")).toEqual({ host: "hub.example.com", port: 443, url: "wss://hub.example.com/" })
    expect(sandboxHubEndpoint("ws://hub.lan:8080")).toEqual({ host: "hub.lan", port: 8080, url: "ws://hub.lan:8080/" })
  })

  test("private IPv4 hubs are kept as they are", () => {
    expect(sandboxHubEndpoint("http://192.168.1.10:4096")).toEqual({ host: "192.168.1.10", port: 4096, url: "http://192.168.1.10:4096/" })
  })

  test("other IPv6 hubs are unsupported", () => {
    expect(() => sandboxHubEndpoint("http://[fd00::1]:4096")).toThrow("the hub's host fd00::1 cannot be allowed in a sandbox policy")
  })
})

describe("gitRemoteEndpoint", () => {
  test("https remotes: port 443 or the URL's port, inspected (no protocol)", () => {
    expect(gitRemoteEndpoint("https://github.com/huynle/hub.git")).toEqual({ host: "github.com", port: 443 })
    expect(gitRemoteEndpoint("https://git.example.com:8443/x/y.git")).toEqual({ host: "git.example.com", port: 8443 })
  })

  test("ssh and scp-style remotes: port 22 or the URL's port, protocol tcp", () => {
    expect(gitRemoteEndpoint("git@github.com:huynle/hub.git")).toEqual({ host: "github.com", port: 22, protocol: "tcp" })
    expect(gitRemoteEndpoint("ssh://git@gitlab.example.com:2222/x/y.git")).toEqual({ host: "gitlab.example.com", port: 2222, protocol: "tcp" })
    expect(gitRemoteEndpoint("ssh://GitHub.com/x/y.git")).toEqual({ host: "github.com", port: 22, protocol: "tcp" })
  })

  test("anything else: undefined", () => {
    expect(gitRemoteEndpoint("file:///srv/repo")).toBeUndefined()
    expect(gitRemoteEndpoint("/srv/repo")).toBeUndefined()
    expect(gitRemoteEndpoint("https://localhost/x.git")).toBeUndefined()
    expect(gitRemoteEndpoint("--upload-pack=x")).toBeUndefined()
  })
})
