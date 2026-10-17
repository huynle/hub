// Reaching this process's own OpenCode server over HTTP, for what the plugin API does not offer (answering
// forms). The background service is found with Service.discover; a foreground `opencode serve` from its
// command line and password variable. A standalone server started by a TUI (`serve --stdio --port 0`)
// keeps its password to itself: its forms are relayed through the TUI instead (Spoke.formActions).

/** URL and Authorization header of a foreground `opencode serve` this process is, when knowable. */
export function foregroundEndpoint(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { url: string; authorization: string } | undefined {
  if (!argv.includes("serve") || argv.includes("--stdio") || argv.includes("--service")) return undefined
  const option = (name: string) => {
    const index = argv.indexOf(name)
    if (index >= 0) return argv[index + 1]
    return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const port = Number(option("--port"))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const host = option("--hostname")
  const reachable = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host
  return { url: `http://${reachable}:${port}`, authorization: `Basic ${btoa(`opencode:${password}`)}` }
}

/** "gone" for OpenCode's form-not-found / already-settled errors; undefined for anything else. */
export function formOutcome(cause: unknown): "gone" | undefined {
  const tag = (cause as { _tag?: unknown } | null)?._tag
  if (tag === "FormNotFoundError" || tag === "FormAlreadySettledError") return "gone"
  const message = cause instanceof Error ? cause.message : String(cause)
  return /form (not found|already settled)/i.test(message) ? "gone" : undefined
}
