// @huynle/hub-claude-code: the Claude Code hooks spoke (design §1.2, §13.3; decision fx04e42c point 4, report
// v0hsdqhm). `hub claude` runs Claude Code with the hub plugin (wrapper.ts); the plugin's hooks run the bridge
// (bridge.ts), which talks to the per-user daemon (daemon.ts: HarnessSpoke + ClaudeSessions) over a private Unix
// socket; the plugin's MCP server is a pipe to the daemon (mcp.ts).
export * from "./bridge.ts"
export * from "./daemon.ts"
export * from "./hook-input.ts"
export * from "./ids.ts"
export * from "./main.ts"
export * from "./mcp.ts"
export * from "./paths.ts"
export * from "./plugin.ts"
export * from "./references.ts"
export * from "./sessions.ts"
export * from "./tools.ts"
export * from "./wire.ts"
export * from "./wrapper.ts"
