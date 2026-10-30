// Fixtures for the node-services adapter (packages/cli/src/bootstrap/adapters/node-services): golden service units
// rendered from the embedded templates with the standalone argv contract, discovery snapshots of a Linux host and of
// a host whose harness lives in a container (the mismatch the adapter must refuse), and a fake service manager.
// Owned by the node-services tests; the shared contract fixtures stay in ./fixtures.ts.
import type { DiscoverySnapshot, ProgramLayout } from "../../src/bootstrap/contracts/index.ts"
import { DISCOVERY_DARWIN, DIGEST, T0 } from "./fixtures.ts"

export const STANDALONE_DARWIN: ProgramLayout = { kind: "standalone", executable: "/Users/dev/.local/bin/hubctl" }
export const STANDALONE_LINUX: ProgramLayout = { kind: "standalone", executable: "/home/dev/.local/bin/hubctl" }
/** A script layout whose entry has a space and a % (quoting and escaping in ExecStart=). */
export const SCRIPT_LINUX: ProgramLayout = { kind: "script", runtime: "/home/dev/.bun/bin/bun", entry: "/home/dev/hub app/100%/main.ts" }
/** An OpenCode binary running the bundled CLI as bun (BUN_BE_BUN=1). */
export const SCRIPT_DARWIN: ProgramLayout = { kind: "script", runtime: "/Users/dev/.opencode/bin/opencode", entry: "/Users/dev/.local/share/hub/hub-cli.js" }

export const GOLDEN_SYSTEMD_NODE = `# Written by hubctl setup from the embedded asset service/systemd-user/node; hubctl removes it only while it is unchanged.
[Unit]
Description=Hub node (prepares launch workspaces for the hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/dev/.local/bin/hubctl node run
Environment=PATH=/home/dev/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=78
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true

[Install]
WantedBy=default.target
`

export const GOLDEN_SYSTEMD_CLAUDE_SCRIPT = `# Written by hubctl setup from the embedded asset service/systemd-user/claude-code; hubctl removes it only while it is unchanged.
[Unit]
Description=Hub Claude Code spoke daemon (follows Claude Code sessions, starts hub launches)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/dev/.bun/bin/bun "/home/dev/hub app/100%%/main.ts" claude-code daemon
Environment=PATH=/home/dev/.local/bin:/home/dev/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HUB_CLAUDE_BIN=/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude
Environment=XDG_CONFIG_HOME=/home/dev/.config
Environment=BUN_BE_BUN=1
Restart=on-failure
RestartSec=30
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true

[Install]
WantedBy=default.target
`

export const GOLDEN_LAUNCHD_NODE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by hubctl setup from the embedded asset service/launchd/node; hubctl removes it only while it is unchanged. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.huynle.hub-node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/dev/.local/bin/hubctl</string>
    <string>node</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/dev/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/dev/.local/state/hub/node.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/dev/.local/state/hub/node.log</string>
</dict>
</plist>
`

/** The same agent from a script layout (an OpenCode binary or bun running hub-cli.js): only this layout runs as bun. */
export const GOLDEN_LAUNCHD_NODE_SCRIPT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by hubctl setup from the embedded asset service/launchd/node; hubctl removes it only while it is unchanged. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.huynle.hub-node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/dev/.opencode/bin/opencode</string>
    <string>/Users/dev/.local/share/hub/hub-cli.js</string>
    <string>node</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/dev/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>BUN_BE_BUN</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/dev/.local/state/hub/node.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/dev/.local/state/hub/node.log</string>
</dict>
</plist>
`

export const GOLDEN_LAUNCHD_CODEX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by hubctl setup from the embedded asset service/launchd/codex-spoke; hubctl removes it only while it is unchanged. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.huynle.hub-codex-spoke</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/dev/.local/bin/hubctl</string>
    <string>codex-spoke</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/dev/.local/bin:/Users/dev/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HUB_CODEX_BIN</key>
    <string>/Users/dev/.local/share/hub/harnesses/codex/current/bin/codex</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/dev/.local/state/hub/codex-spoke.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/dev/.local/state/hub/codex-spoke.log</string>
</dict>
</plist>
`

const verified = { state: "verified" as const, probes: [{ kind: "version-exec" as const, ok: true, observedAt: T0 }] }

/** A Linux workstation (systemd --user) with Claude Code installed by hub on the host itself. */
export const DISCOVERY_LINUX: DiscoverySnapshot = {
  ...DISCOVERY_DARWIN,
  host: { fingerprint: DIGEST.e, platform: "linux", arch: "x64", libc: "glibc", target: "linux-x64", supported: true, os: { name: "Ubuntu", version: "24.04" } },
  topology: { container: "none", shims: [] },
  managers: { package: ["apt"], runtime: [{ id: "bun", version: "1.3.5", path: "/home/dev/.bun/bin/bun" }], service: "systemd-user" },
  harnesses: [
    { id: "opencode", installed: true, path: "/home/dev/.opencode/bin/opencode", version: "2.0.26", installMethod: "native", health: verified },
    { id: "claude-code", installed: true, path: "/home/dev/.local/share/hub/harnesses/claude-code/current/bin/claude", version: "2.1.90", installMethod: "hub", health: verified },
    { id: "codex", installed: false, health: { state: "unverified", probes: [] } },
  ],
  configs: [],
  roots: [
    { id: "home", path: "/home/dev" },
    { id: "config", path: "/home/dev/.config" },
    { id: "state", path: "/home/dev/.local/state" },
    { id: "data", path: "/home/dev/.local/share" },
    { id: "user-bin", path: "/home/dev/.local/bin" },
    { id: "systemd-user", path: "/home/dev/.config/systemd/user" },
  ],
}

/**
 * The brain-runner lesson: hubctl runs on the host, but the harness (and its repositories) live inside a Docker
 * container. The `claude` on the host's PATH is only a shim into the container, so a host service would find no
 * harness and the wrong workspace paths.
 */
export const DISCOVERY_HOST_HARNESS_IN_CONTAINER: DiscoverySnapshot = {
  ...DISCOVERY_LINUX,
  topology: { container: "none", shims: [{ name: "claude", path: "/usr/local/bin/claude", kind: "container-shim", resolvesTo: "/root/.local/bin/claude" }] },
  harnesses: [
    { id: "opencode", installed: false, health: { state: "unverified", probes: [] } },
    { id: "claude-code", installed: true, path: "/usr/local/bin/claude", version: "2.1.90", installMethod: "unknown", health: { state: "unverified", probes: [] } },
    { id: "codex", installed: false, health: { state: "unverified", probes: [] } },
  ],
}

/** hubctl runs inside a container with its own systemd --user; home is a host directory mounted at /workspace/home. */
export const DISCOVERY_IN_CONTAINER: DiscoverySnapshot = {
  ...DISCOVERY_LINUX,
  topology: { container: "docker", shims: [] },
  harnesses: [
    { id: "opencode", installed: false, health: { state: "unverified", probes: [] } },
    { id: "claude-code", installed: true, path: "/workspace/home/.local/bin/claude", version: "2.1.90", installMethod: "native", health: verified },
    { id: "codex", installed: false, health: { state: "unverified", probes: [] } },
  ],
  roots: [
    { id: "home", path: "/srv/dev", containerPath: "/workspace/home" },
    { id: "config", path: "/srv/dev/.config", containerPath: "/workspace/home/.config" },
    { id: "state", path: "/srv/dev/.local/state", containerPath: "/workspace/home/.local/state" },
    { id: "data", path: "/srv/dev/.local/share", containerPath: "/workspace/home/.local/share" },
    { id: "systemd-user", path: "/etc/container-user/systemd" },
  ],
}

/** The same container, but its unit directory is the host's own systemd --user directory, mounted in. */
export const DISCOVERY_CONTAINER_HOST_UNITS: DiscoverySnapshot = {
  ...DISCOVERY_IN_CONTAINER,
  roots: [...DISCOVERY_IN_CONTAINER.roots.filter((r) => r.id !== "systemd-user"), { id: "systemd-user", path: "/srv/dev/.config/systemd/user", containerPath: "/workspace/home/.config/systemd/user" }],
}

/** A fake launchctl / systemctl --user: records every call and keeps the load and enable state of each service. */
export class FakeManager {
  readonly calls: string[] = []
  readonly loaded = new Set<string>()
  readonly enabled = new Set<string>()
  /** Exit codes to force for exact calls ("launchctl bootstrap gui/501 /path"). */
  readonly failing = new Map<string, number>()
  /** Services that refuse to come up (activation leaves them unloaded). */
  readonly broken = new Set<string>()

  constructor(seed: { loaded?: readonly string[]; enabled?: readonly string[] } = {}) {
    for (const s of seed.loaded ?? []) this.loaded.add(s)
    for (const s of seed.enabled ?? []) this.enabled.add(s)
  }

  readonly run = async (call: { readonly program: "systemctl" | "launchctl"; readonly words: readonly string[] }): Promise<{ readonly exitCode: number }> => {
    const line = [call.program, ...call.words].join(" ")
    this.calls.push(line)
    const forced = this.failing.get(line)
    if (forced !== undefined) return { exitCode: forced }
    return { exitCode: call.program === "systemctl" ? this.systemctl(call.words) : this.launchctl(call.words) }
  }

  private systemctl(words: readonly string[]): number {
    const [, verb, ...rest] = words
    const unit = rest[rest.length - 1]!
    switch (verb) {
      case "daemon-reload":
        return 0
      case "is-active":
        return this.loaded.has(unit) ? 0 : 3
      case "is-enabled":
        return this.enabled.has(unit) ? 0 : 1
      case "enable":
        this.enabled.add(unit)
        return 0
      case "disable":
        this.enabled.delete(unit)
        return 0
      case "start":
      case "restart":
        if (!this.broken.has(unit)) this.loaded.add(unit)
        return 0
      case "stop":
        this.loaded.delete(unit)
        return 0
    }
    return 1
  }

  private launchctl(words: readonly string[]): number {
    const [verb, target, file] = words
    if (verb === "print") return this.loaded.has(target!.split("/").pop()!) ? 0 : 113
    if (verb === "bootout") return this.loaded.delete(target!.split("/").pop()!) ? 0 : 3
    if (verb === "bootstrap") {
      const label = file!.split("/").pop()!.replace(/\.plist$/, "")
      if (this.broken.has(label)) return 5
      this.loaded.add(label)
      return 0
    }
    return 1
  }
}
