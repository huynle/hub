// The hub CLI (`hub` / `hubctl`, design §2.2, §4, §8): reads and names sessions through the hub's /api/agent, with
// the hub SDK (packages/sdk) as its client.
// `run(argv, io)` is the whole program (main.ts wires it to the process); it returns the exit code.
import type { HubClient, Sent, SentAll } from "../../sdk/src/index.ts"
import pkg from "../package.json" with { type: "json" }
import { parse, str, UsageError, type CommandSpec, type Parsed } from "./args"
import { loginFile, readLogin, removeLogin, resolveCredentials, writeLogin, type Credentials, type Env } from "./credentials"
import { atName, logText, whoamiText, type Actor, roleText, sessionsText, showText, statusText, whoText } from "./format"
import { CliError, EXIT, withHub } from "./http"
import { sentText, textArg } from "./messaging"
import { watch } from "./watch"

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
  /** Calls the hub with the resolved credentials (SDK errors become CliErrors). */
  hub<T>(use: (hub: HubClient) => Promise<T>): Promise<T>
}

interface Command extends CommandSpec {
  handle(context: Context): Promise<void>
}

const out = (io: Io, text: string) => io.stdout(text.endsWith("\n") ? text : `${text}\n`)
const printJSON = (io: Io, value: unknown) => out(io, JSON.stringify(value, null, 2))

/** Warns when this shell's OpenCode session is not the one the credential acts as (design §1.3, 31swaq28). */
function crossCheck(io: Io, actor: Actor | undefined) {
  const own = io.env.OPENCODE_SESSION_ID
  if (!own || !actor || (actor.kind === "session" && actor.sessionID === own)) return
  const as = actor.kind === "session" ? `session ${actor.sessionID}` : actor.kind === "app" ? "an app token" : "the user"
  io.stderr(`hub: warning: this shell belongs to OpenCode session ${own}, but the credential acts as ${as}\n`)
}

/** Prints the raw answer with --json, else its text. */
const answer = (context: Context, body: unknown, text: (body: any) => string) => (context.json ? printJSON(context.io, body) : out(context.io, text(body)))

/** --no-wake and --urgent as SDK send options. */
const sendFlags = (flags: Parsed["flags"]) => ({ ...(flags["no-wake"] === true ? { wake: false } : {}), ...(flags.urgent === true ? { urgent: true } : {}) })

const COMMANDS: Record<string, Command> = {
  whoami: {
    async handle(context) {
      const body = await context.hub((hub) => hub.whoami())
      answer(context, body, whoamiText)
      crossCheck(context.io, body.actor)
    },
  },
  status: {
    async handle(context) {
      const body = await context.hub((hub) => hub.status())
      answer(context, body, statusText)
      crossCheck(context.io, body.you)
    },
  },
  sessions: {
    flags: { project: "string", state: "string", machine: "string", label: "multi" },
    async handle(context) {
      const { flags } = context.parsed
      const filter = { project: str(flags, "project"), state: str(flags, "state"), machine: str(flags, "machine"), label: flags.label as string[] | undefined }
      const body = await context.hub((hub) => hub.sessions(filter))
      answer(context, body, (b) => sessionsText(b.sessions ?? []))
    },
  },
  show: {
    args: ["<addr>"],
    async handle(context) {
      const body = await context.hub((hub) => hub.show(context.parsed.args[0]!))
      answer(context, body, showText)
    },
  },
  log: {
    args: ["<addr>"],
    flags: { n: "string" },
    async handle(context) {
      const n = str(context.parsed.flags, "n")
      if (n !== undefined && !/^\d+$/.test(n)) throw new UsageError("-n must be a number (1–200)")
      const body = await context.hub((hub) => hub.log(context.parsed.args[0]!, { n }))
      answer(context, body, (b) => logText(b.rows ?? []))
    },
  },
  who: {
    args: ["@@role?"],
    flags: { project: "string", role: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const role = str(flags, "role") ?? args[0]
      const body = await context.hub((hub) => hub.who({ project: str(flags, "project"), role }))
      answer(context, body, (b) => whoText(b.sessions ?? []))
    },
  },
  name: {
    args: ["<@name>"],
    flags: { session: "string" },
    async handle(context) {
      const session = str(context.parsed.flags, "session")
      const body = await context.hub((hub) => hub.name(context.parsed.args[0]!, { session }))
      answer(context, body, (b) => `${b.sessionID} is ${atName(b.name)}${b.alias ? ` (was ${atName(b.alias)}, kept as an alias for 24 h)` : ""}`)
    },
  },
  "role claim": {
    args: ["<role>"],
    flags: { exclusive: "bool", session: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const session = str(flags, "session")
      const body = await context.hub((hub) => hub.claimRole(args[0]!, { exclusive: flags.exclusive === true, session }))
      answer(context, body, (b) => `${b.sessionID} holds ${roleText(b)}${b.exclusive ? " (exclusive)" : ""}${b.generation !== undefined ? ` generation ${b.generation}` : ""}`)
    },
  },
  "role release": {
    args: ["<role>"],
    flags: { session: "string" },
    async handle(context) {
      const session = str(context.parsed.flags, "session")
      const body = await context.hub((hub) => hub.releaseRole(context.parsed.args[0]!, { session }))
      answer(context, body, (b) => `${b.sessionID} released ${roleText(b)}`)
    },
  },
  watch: {
    flags: { blocked: "bool", session: "string" },
    async handle({ io, parsed, credentials }) {
      await watch(credentials(), { blocked: parsed.flags.blocked === true, session: str(parsed.flags, "session") }, (line) => io.stdout(line), io.signal)
    },
  },
  msg: {
    args: ["<addr>", "<text>"],
    flags: { all: "bool", "no-wake": "bool", urgent: "bool" },
    async handle(context) {
      const { flags, args } = context.parsed
      const text = await textArg(args[1]!, context.io.stdin)
      const options = sendFlags(flags)
      const body = await context.hub<Sent | SentAll>((hub) => (flags.all === true ? hub.msg(args[0]!, text, { ...options, all: true }) : hub.msg(args[0]!, text, options)))
      answer(context, body, (b) => ("sent" in b ? b.sent.map(sentText).join("\n") || "no recipients" : sentText(b)))
    },
  },
  login: {
    flags: { url: "string", token: "string" },
    async handle(context) {
      const { io, parsed } = context
      const file = loginFile(io.env, io.home)
      const url = (str(parsed.flags, "url") ?? io.env.HUB_URL ?? readLogin(file)?.url)?.replace(/\/+$/, "")
      if (!url) throw new UsageError("needs --url <hub URL> (or HUB_URL)")
      const token = (str(parsed.flags, "token") ?? (io.stdin ? await io.stdin() : "")).trim()
      if (!token) throw new UsageError("needs an app token: --token, or on stdin (create one in the console: Settings → Agents)")
      const credentials: Credentials = { url, token, source: "login" }
      const body = await withHub(credentials, (hub) => hub.whoami())
      writeLogin(file, { url, token })
      answer(context, body, (b) => `logged in to ${url}\n${whoamiText(b)}\nsaved in ${file}`)
    },
  },
  logout: {
    async handle(context) {
      const file = loginFile(context.io.env, context.io.home)
      out(context.io, removeLogin(file) ? `logged out (deleted ${file}; the app token stays valid until revoked in the console)` : "not logged in")
    },
  },
}

/** Commands with sub-verbs (`hub role claim`). */
const GROUPS: Record<string, string[]> = { role: ["claim", "release"] }

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
  if (typeof envelope?.feature === "string") io.stderr(`missing feature: ${envelope.feature}${typeof envelope.harness === "string" ? ` (${envelope.harness})` : ""}\n`)
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
  let label = name
  const verbs = GROUPS[name]
  if (verbs) {
    const verb = rest.shift()
    if (verb === "--help" || verb === "-h") {
      out(io, USAGE)
      return EXIT.ok
    }
    if (verb === undefined || !verbs.includes(verb)) {
      io.stderr(`hub ${name}: ${verb === undefined ? "needs" : `unknown subcommand ${verb}; use`} ${verbs.join(" or ")}\n`)
      return EXIT.usage
    }
    label = `${name} ${verb}`
  }
  const command = COMMANDS[label]
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
    await command.handle({ io, parsed, json, credentials, hub: (use) => withHub(credentials(), use) })
    return EXIT.ok
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`hub ${label}: ${cause.message}\nRun \`hub help\` for usage.\n`)
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
