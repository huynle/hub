// The hub CLI (`hub` / `hubctl`, design §2.2, §4, §8): reads and names sessions through the hub's /api/agent.
// `run(argv, io)` is the whole program (main.ts wires it to the process); it returns the exit code.
import pkg from "../package.json" with { type: "json" }
import { parse, UsageError, type CommandSpec, type Parsed } from "./args"
import { resolveCredentials, type Credentials, type Env } from "./credentials"
import { call, CliError, EXIT } from "./http"

export { EXIT } from "./http"

export const VERSION: string = pkg.version

export interface Io {
  env: Env
  home: string
  stdout(s: string): void
  stderr(s: string): void
  /** The whole of stdin (login reads the token from it when --token is not given). */
  stdin?: () => Promise<string>
  /** Ends `watch` (main.ts aborts it on SIGINT/SIGTERM). */
  signal?: AbortSignal
}

export const USAGE = `Usage: hub <command> [options]     (also installed as hubctl)

Reading
  hub status                          machines → projects → sessions, and what needs attention
  hub sessions [--project P] [--state S[,S]] [--machine M] [--label k=v]
  hub show <addr>                     one session: state, blockers, activity, summary
  hub log <addr> [-n 20]              the newest timeline rows (1–200)
  hub watch [--blocked] [--session <addr>]   events as JSON lines until interrupted

Identity
  hub whoami                          who this credential is
  hub who [--project P] [--role R]    named and role-holding sessions
  hub name <@name> [--session <addr>]
  hub role claim <role[.project]> [--exclusive] [--session <addr>]
  hub role release <role[.project]> [--session <addr>]

Login (outside a hub session)
  hub login [--url URL] [--token APP_TOKEN]   store an app token (token read from stdin when not given)
  hub logout

Options: --json (raw responses), --help, --version
Addresses: ses_… (or an unambiguous prefix), @name, @@role, @name.project
Credentials: HUB_URL + HUB_SESSION_TOKEN (set in a session's shells), else the \`hub login\` file.
Exit codes: 0 ok, 1 other, 2 usage, 3 not found/ambiguous/taken, 4 needs user, 5 forbidden/paused,
  6 rate limited, 7 unsupported/offline, 8 gone, 9 unauthorized/expired`

interface Context {
  readonly io: Io
  readonly parsed: Parsed
  readonly json: boolean
  credentials(): Credentials
}

interface Command extends CommandSpec {
  handle(context: Context): Promise<void>
}

const out = (io: Io, text: string) => io.stdout(text.endsWith("\n") ? text : `${text}\n`)
const printJSON = (io: Io, value: unknown) => out(io, JSON.stringify(value, null, 2))
/** A path segment; `@` stays readable (it is valid in a path). */
const enc = (segment: string) => encodeURIComponent(segment).replace(/%40/g, "@")

type Actor = { kind: string; sessionID?: string; machineID?: string; tokenID?: string; label?: string; scopes?: string[]; deviceID?: string; name?: string }

/** Warns when this shell's OpenCode session is not the one the credential acts as (design §1.3, 31swaq28). */
function crossCheck(io: Io, actor: Actor | undefined) {
  const own = io.env.OPENCODE_SESSION_ID
  if (!own || !actor || (actor.kind === "session" && actor.sessionID === own)) return
  const as = actor.kind === "session" ? `session ${actor.sessionID}` : actor.kind === "app" ? "an app token" : "the user"
  io.stderr(`hub: warning: this shell belongs to OpenCode session ${own}, but the credential acts as ${as}\n`)
}

function whoamiText(body: { actor: Actor; user: { id: string; name?: string; email?: string; role?: string } }): string {
  const { actor, user } = body
  const lines: string[] = []
  if (actor.kind === "session") lines.push(`session ${actor.sessionID}${actor.machineID ? ` on machine ${actor.machineID}` : ""}`)
  else if (actor.kind === "app") lines.push(`app token ${actor.tokenID}${actor.label ? ` (${actor.label})` : ""}${actor.scopes?.length ? ` scopes ${actor.scopes.join(",")}` : ""}`)
  else lines.push(`user${actor.deviceID ? ` (device ${actor.deviceID})` : ""}`)
  const who = [user.name, user.email ? `<${user.email}>` : undefined].filter(Boolean).join(" ") || user.id
  lines.push(`user ${who}${user.role ? ` (${user.role})` : ""}`)
  return lines.join("\n")
}

const COMMANDS: Record<string, Command> = {
  whoami: {
    async handle({ io, json, credentials }) {
      const body = await call<{ actor: Actor; user: { id: string } }>(credentials(), "/api/agent/whoami")
      if (json) printJSON(io, body)
      else out(io, whoamiText(body))
      crossCheck(io, body.actor)
    },
  },
  show: {
    args: ["<addr>"],
    async handle({ io, json, parsed, credentials }) {
      const body = await call(credentials(), `/api/agent/sessions/${enc(parsed.args[0]!)}`)
      if (json) printJSON(io, body)
      else printJSON(io, body)
    },
  },
}

function reportError(io: Io, error: CliError, json: boolean) {
  if (json && error.envelope) printJSON(io, { error: error.envelope })
  io.stderr(`hub: ${error.message}\n`)
  const envelope = error.envelope
  const candidates = envelope?.candidates
  if (Array.isArray(candidates) && candidates.length) {
    io.stderr("candidates:\n")
    for (const c of candidates as { sessionID?: string; name?: string; title?: string }[]) {
      io.stderr(`  ${[c.sessionID, c.name ? `@${String(c.name).replace(/^@/, "")}` : undefined, c.title].filter(Boolean).join("  ")}\n`)
    }
  }
  if (typeof envelope?.retryAfter === "number") io.stderr(`retry after ${Math.ceil(envelope.retryAfter)} s\n`)
  if (error.hint) io.stderr(`hint: ${error.hint}\n`)
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv
  if (name === undefined) {
    io.stderr(`${USAGE}\n`)
    return EXIT.usage
  }
  if (name === "help" || name === "--help" || name === "-h") {
    out(io, USAGE)
    return EXIT.ok
  }
  if (name === "--version" || name === "-V" || name === "version") {
    out(io, VERSION)
    return EXIT.ok
  }
  const command = COMMANDS[name]
  if (!command) {
    io.stderr(`hub: unknown command ${name}\nRun \`hub help\` for the commands.\n`)
    return EXIT.usage
  }
  let json = false
  try {
    const parsed = parse(rest, command)
    if (parsed.flags.help) {
      out(io, USAGE)
      return EXIT.ok
    }
    json = parsed.flags.json === true
    const credentials = () => {
      const found = resolveCredentials(io.env, io.home)
      if (!found) throw new CliError(EXIT.unauthorized, "not logged in to a hub", "Run `hub login --url <hub URL>` with an app token, or run inside a hub session's shell (HUB_URL + HUB_SESSION_TOKEN)")
      return found
    }
    await command.handle({ io, parsed, json, credentials })
    return EXIT.ok
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`hub ${name}: ${cause.message}\nRun \`hub help\` for usage.\n`)
      return EXIT.usage
    }
    if (cause instanceof CliError) {
      reportError(io, cause, json)
      return cause.exit
    }
    io.stderr(`hub: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return EXIT.other
  }
}
