// The hub CLI (`hub` / `hubctl`, design §2.2, §3, §4, §5, §8): reads, names, messages and acts on sessions through
// the hub's /api/agent, with the hub SDK (packages/sdk) as its client.
// `run(argv, io)` is the whole program (main.ts wires it to the process); it returns the exit code.
import type { Asked, HubClient, LaunchState, Sent, SentAll } from "../../sdk/src/index.ts"
import pkg from "../package.json" with { type: "json" }
import { parse, str, UsageError, type CommandSpec, type Parsed } from "./args"
import { loginFile, readLogin, removeLogin, resolveCredentials, writeLogin, type Credentials, type Env } from "./credentials"
import { atName, logText, whoamiText, type Actor, roleText, sessionsText, showText, statusText, whoText } from "./format"
import { CliError, EXIT, withHub } from "./http"
import { serveMcp } from "./mcp"
import { ASK_EXPIRES_DEFAULT_S, askOutcome, declinedText, durationArg, inboxText, mutedText, repliedText, sentText, textArg } from "./messaging"
import { watch } from "./watch"
import { DECISION_FLAGS, decisionOptions, decisionsText, openedText, stateArg } from "./decisions"
import { GRANT_FLAGS, GRANT_REQUEST_FLAGS, grantError, grantRequestArg, grantSpecArg, grantsText, grantText, requestedText, userOnly } from "./grants"
import { answeredText, approvedText, deliveryArg, deniedText, formAnswerArg, needsUserLines, promptedText, stoppedText } from "./acting"
import { currentProgram, installNode, nodeStatus, nodeStatusText, runNodeCommand, uninstallNode, type NodeIo, type Program } from "./node"
import { checkOpenShell, openShellCheckText } from "./openshell"
import { LAUNCH_FLAGS, launchedText, launchesText, launchSpecArg, launchText, stoppedLaunchText } from "./launches"
import { claudeCodeMain } from "../../claude-code/src/main.ts"
import { runClaude } from "../../claude-code/src/wrapper.ts"
import { presetMain } from "../../preset/src/main.ts"
import { codexMain } from "../../codex/src/main.ts"
import { installSpokeService, isServiceVerb, SERVICE_VERBS, spokeServiceStatus, spokeServiceStatusText, uninstallSpokeService, type SpokeServiceName } from "./spoke-services"
import { runCodex } from "../../codex/src/wrapper.ts"

export { EXIT } from "./http"

export const VERSION: string = pkg.version

export interface Io {
  env: Env
  home: string
  stdout(s: string): void
  stderr(s: string): void
  /** The whole of stdin (login reads the token from it when --token is not given). */
  stdin?: () => Promise<string>
  /** Ends `watch` and `mcp` (main.ts aborts it on SIGINT/SIGTERM). */
  signal?: AbortSignal
  /** stdin as a stream (`hub mcp` reads JSON-RPC lines from it). */
  input?: AsyncIterable<Uint8Array | string>
  /** The working directory (`hub launch` defaults --repo to it); default process.cwd(). */
  cwd?: string
  /** `hub node install`: the platform (default process.platform), user ID and what runs this CLI. */
  platform?: NodeJS.Platform
  uid?: number
  program?: Program
  /** `hub node openshell check`: the openshell executable (default "openshell" on PATH). */
  openshellBinary?: string
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

Messaging (text "-" reads it from stdin)
  hub msg <addr> "text" [--all] [--no-wake] [--urgent]   tell: fire and forget
  hub ask <addr> "text" [--wait [secs]] [--expires 2h] [--all] [--no-wake] [--urgent]
                                      tracked until answered, declined or expired; --wait alone waits until
                                      it expires; exit 0 answered, 1 declined or no answer yet, 8 expired
  hub reply <msgID> "text" [--no-wake]   goes to the real sender
  hub decline <msgID> --why "reason"
  hub ask @me "question" [--option id=label[:safe]]... [--recommend id [--why "…"]] [--urgency low|normal|high]
         [--deadline 2h [--on-timeout <safe id>]] [--tier confirm|tap] [--about <addr>]...
                                      opens a Decision for the user (answered in the console; the answer
                                      comes back as a reply); --on-timeout picks a safe option at the deadline
  hub decisions list [--state open|answered|expired|closed]   the Decisions you asked
  hub inbox                           asks to answer, your open asks, recent messages, mutes
  hub mute <addr> · hub unmute <addr>    refuse (or accept again) messages from a session

Acting (users; agents under a grant, else exit 4 needs user with the evaluation)
  hub approve <addr> <requestID> [--always] [--why "…"]   answer a permission request (once, or always)
  hub deny <addr> <requestID> [--why "…"]                 reject it; the reason reaches the harness
  hub answer <addr> <formID> key=value… | --json '{…}' | --json - | --cancel [--why "…"]
                                      answer a form (a repeated key is a list); --cancel dismisses it
  hub prompt <addr> "text" [--delivery queue|steer] [--why "…"]   prompt a session (text "-" reads stdin)
  hub stop <addr> [--why "…"]         stop its running turn

Grants (the user only: the console, or \`hub login\` with a device token; exit 5 otherwise)
  hub grant list · hub grant show <grantID> · hub grant revoke <grantID>
  hub grant create --holder <ses_…|@name|@@orchestrator…|app:<id>> --project <path>... --allow approve,deny,…
         [--permit <pattern>]... [--never <pattern>]... [--expires 8h] [--max-per-hour N] [--allow-always]
         | --json '{…}' | --json -   what a session or app token may do, in which projects, until when
                                      verbs: approve, deny, answer, prompt, stop, roles, launch (start sessions)
  hub grant request --project <path>... --allow approve,deny,… [--permission-allow <pattern>]... [--never <pattern>]...
         [--expires 8h] [--max-per-hour N] [--allow-always] [--holder <@@role you hold>] --why "…"
                                      (agents) ask the user for a grant: opens a tap Decision; the answer comes
                                      back as a reply (with the grant id when approved)

Launching (users; agents and app tokens with sessions:launch under a grant with verb launch)
  hub launch [--repo <path, default .>] [--mode worktree|checkout|clone] [--branch B] [--base B] [--remote URL]
         [--name <@name>] [--role R]... [--harness H] [--agent A] [--model provider/model]
         [--runtime host|openshell [--profile P]] [--machine M] [--node-label k=v]... [--prefer]
         [--label k=v]... [--prompt "text" | --prompt -] [--end idle|asked|never] [--timeout 4h]
         [--cleanup keep|remove] [--key K]
                                      start a session; the same --key again answers the same launch;
                                      --label tags it for apps, --node-label picks nodes (--prefer: not required)
  hub launches list [--state S[,S]] [--label k=v]...   your launches (agents: the ones they started)
  hub launches show <launchID> · hub launches stop <launchID>   (stop: exit 8 when it already ended)

Node (this machine runs launches; design §6.3)
  hub node run                        the node daemon until Ctrl-C/SIGTERM (needs an enrolled machine and
                                      ~/.config/hub/node.json with "workspaceRoots")
  hub node install [--dry-run]        write the launchd agent (macOS) or systemd user unit (Linux) and print
                                      the commands that load it (never run by hub); --dry-run only prints
  hub node uninstall [--dry-run]      remove it and print the commands that stop it
  hub node status                     the service file, enrolment and node.json
  hub node openshell check            can this node run sandboxed launches: the openshell CLI (0.1.x), its
                                      gateway, workspace hub, node.json's openshell section, profiles, image
                                      and providers (read-only; exit 1 when something is wrong)

Claude Code (hooks spoke)
  hub claude [claude args…]           run Claude Code with the hub plugin (--plugin-dir; ~/.claude is never
                                      changed), starting the per-user daemon when needed (an enrolled machine);
                                      env HUB_CLAUDE_PERMISSION_WAIT=<s> (default 120, 0: report only), HUB_CLAUDE_BIN
  hub claude-code daemon|hook|mcp     the spoke's daemon, hook bridge and MCP pipe (run by hub claude and the plugin)
  hub claude-code install|uninstall [--dry-run] | status
                                      the daemon as a launchd agent / systemd user unit (like hub node install:
                                      load commands printed, never run), so launches need no hub claude run

Presets (harnesses without a spoke, driven through a tmux pane; evidence screen)
  hub preset list                     the official presets
  hub preset check <name|file>        validate a preset (data only: an argv, never run through a shell)
  hub preset run <name|file> [--socket <name> | --current] [--cwd <dir>] [--resume <id>] [--no-hub] [-- args…]
                                      start it in a new pane on a private tmux server (-L hub-preset; your own
                                      tmux only with --current) and connect it to the hub until the pane ends;
                                      hub messages are pasted (never confirmed), Ctrl-C for stop/interrupt
Codex (app-server spoke)
  hub codex [codex args…]             run Codex with the shared app-server daemon on (--enable daemon_auto_start;
                                      ~/.codex is never changed), starting the per-user spoke when needed (an
                                      enrolled machine); env HUB_CODEX_BIN, HUB_CODEX_CONFIG (-c lines for the spoke)
  hub codex-spoke serve               the spoke service (run by hub codex); attaches to the daemon's threads
  hub codex-spoke install|uninstall [--dry-run] | status
                                      the spoke service as a launchd agent / systemd user unit (printed, never loaded)

MCP
  hub mcp                             an MCP server on stdio: these verbs as tools, with this CLI's credential

Login (outside a hub session)
  hub login [--url URL] [--token APP_TOKEN]   store an app token (token read from stdin when not given)
  hub logout

Options: --json (raw responses), --help, --version
Addresses: ses_… (or an unambiguous prefix), @name, @@role, @name.project, @me (the user)
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
  /** Resolves the exit code when it is not 0. */
  handle(context: Context): Promise<number | void>
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

/** context.hub for the grant routes: a forbidden says who may manage grants. */
const grantHub = <T>(context: Context, use: (hub: HubClient) => Promise<T>): Promise<T> =>
  context.hub(use).catch((error) => {
    throw grantError(error)
  })

/** --why as SDK act options. */
const whyOf = (flags: Parsed["flags"]) => {
  const why = str(flags, "why")
  return why !== undefined ? { why } : {}
}

/** --no-wake and --urgent as SDK send options. */
const sendFlags = (flags: Parsed["flags"]) => ({ ...(flags["no-wake"] === true ? { wake: false } : {}), ...(flags.urgent === true ? { urgent: true } : {}) })

const nodeIo = (io: Io): NodeIo => ({
  env: io.env,
  home: io.home,
  platform: io.platform ?? process.platform,
  uid: io.uid ?? process.getuid?.() ?? 0,
  program: io.program ?? currentProgram(),
})

const spokeStatusOutput = (context: Context, name: SpokeServiceName) => {
  const status = spokeServiceStatus(name, nodeIo(context.io))
  if (context.json) printJSON(context.io, status)
  else out(context.io, spokeServiceStatusText(name, status))
}

const nodeOutput = (io: Io, output: { stdout: string; warnings: readonly string[] }) => {
  for (const warning of output.warnings) io.stderr(`hub: warning: ${warning}\n`)
  out(io, output.stdout)
}

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
  ask: {
    args: ["<addr>", "<text>"],
    flags: { all: "bool", "no-wake": "bool", urgent: "bool", expires: "string", wait: "optional", ...DECISION_FLAGS },
    async handle(context) {
      const { flags, args } = context.parsed
      const decision = decisionOptions(flags, args[0]!)
      const text = await textArg(args[1]!, context.io.stdin)
      const expiresFlag = str(flags, "expires")
      const expires = expiresFlag === undefined ? undefined : durationArg(expiresFlag, "--expires")
      const wait = flags.wait === undefined ? undefined : flags.wait === true ? (expires ?? ASK_EXPIRES_DEFAULT_S) : durationArg(String(flags.wait), "--wait")
      const options = { ...sendFlags(flags), ...(expires !== undefined ? { expires } : {}) }
      if (flags.all === true) {
        if (wait !== undefined) throw new UsageError("--wait cannot be combined with --all")
        const body = await context.hub((hub) => hub.ask(args[0]!, text, { ...options, all: true }))
        answer(context, body, (b) => b.sent.map(sentText).join("\n") || "no recipients")
        return
      }
      const body = await context.hub<Asked>((hub) => hub.ask(args[0]!, text, { ...options, ...decision, ...(wait !== undefined ? { wait } : {}) }))
      const outcome = askOutcome(body, wait)
      answer(context, body, () => (body.decision ? `${outcome.text}\n${openedText(body.decision)}` : outcome.text))
      if (outcome.note) context.io.stderr(`hub: ${outcome.note}\n`)
      return outcome.exit
    },
  },
  reply: {
    args: ["<msgID>", "<text>"],
    flags: { "no-wake": "bool" },
    async handle(context) {
      const { flags, args } = context.parsed
      const text = await textArg(args[1]!, context.io.stdin)
      const body = await context.hub((hub) => hub.reply(args[0]!, text, flags["no-wake"] === true ? { wake: false } : {}))
      answer(context, body, repliedText)
    },
  },
  decline: {
    args: ["<msgID>"],
    flags: { why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const why = str(flags, "why")
      if (why === undefined) throw new UsageError('needs --why "reason"')
      const reason = await textArg(why, context.io.stdin, "reason")
      const body = await context.hub((hub) => hub.decline(args[0]!, reason))
      answer(context, body, declinedText)
    },
  },
  "decisions list": {
    flags: { state: "string" },
    async handle(context) {
      const state = stateArg(str(context.parsed.flags, "state"))
      const body = await context.hub((hub) => hub.decisions(state ? { state } : {}))
      answer(context, body, (b) => decisionsText(b.decisions ?? []))
    },
  },
  inbox: {
    async handle(context) {
      const body = await context.hub((hub) => hub.inbox())
      answer(context, body, inboxText)
    },
  },
  mute: {
    args: ["<addr>"],
    async handle(context) {
      const body = await context.hub((hub) => hub.mute(context.parsed.args[0]!))
      answer(context, body, (b) => mutedText(b.muted))
    },
  },
  unmute: {
    args: ["<addr>"],
    async handle(context) {
      const body = await context.hub((hub) => hub.unmute(context.parsed.args[0]!))
      answer(context, body, (b) => mutedText(b.muted))
    },
  },
  approve: {
    args: ["<addr>", "<requestID>"],
    flags: { always: "bool", why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const body = await context.hub((hub) => hub.approve(args[0]!, args[1]!, { ...(flags.always === true ? { always: true } : {}), ...whyOf(flags) }))
      answer(context, body, approvedText)
    },
  },
  deny: {
    args: ["<addr>", "<requestID>"],
    flags: { why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const body = await context.hub((hub) => hub.deny(args[0]!, args[1]!, whyOf(flags)))
      answer(context, body, deniedText)
    },
  },
  answer: {
    args: ["<addr>", "<formID>", "key=value..."],
    flags: { json: "json", cancel: "bool", why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const [addr, formID, ...pairs] = args as [string, string, ...string[]]
      const given = await formAnswerArg(pairs, flags, context.io.stdin)
      const options = whyOf(flags)
      const body = await context.hub((hub) => (given === "cancel" ? hub.cancelForm(addr, formID, options) : hub.answer(addr, formID, given, options)))
      answer(context, body, (b) => answeredText(b, given === "cancel"))
    },
  },
  prompt: {
    args: ["<addr>", "<text>"],
    flags: { delivery: "string", why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const delivery = deliveryArg(str(flags, "delivery"))
      const text = await textArg(args[1]!, context.io.stdin)
      const body = await context.hub((hub) => hub.prompt(args[0]!, text, { ...(delivery ? { delivery } : {}), ...whyOf(flags) }))
      answer(context, body, promptedText)
    },
  },
  stop: {
    args: ["<addr>"],
    flags: { why: "string" },
    async handle(context) {
      const { flags, args } = context.parsed
      const body = await context.hub((hub) => hub.stop(args[0]!, whyOf(flags)))
      answer(context, body, stoppedText)
    },
  },
  "grant list": {
    async handle(context) {
      const body = await grantHub(context, (hub) => hub.grants())
      answer(context, body, (b) => grantsText(b.grants ?? []))
    },
  },
  "grant show": {
    args: ["<grantID>"],
    async handle(context) {
      const body = await grantHub(context, (hub) => hub.grant(context.parsed.args[0]!))
      answer(context, body, (b) => grantText(b.grant))
    },
  },
  "grant create": {
    flags: GRANT_FLAGS,
    async handle(context) {
      userOnly(context.credentials().source, "create")
      const spec = await grantSpecArg(context.parsed.flags, context.io.stdin)
      const body = await grantHub(context, (hub) => hub.createGrant(spec))
      answer(context, body, (b) => `created ${grantText(b.grant)}`)
    },
  },
  "grant request": {
    flags: GRANT_REQUEST_FLAGS,
    async handle(context) {
      const why = str(context.parsed.flags, "why")
      if (!why?.trim()) throw new UsageError('needs --why "…" (the reason the user reads)')
      const grant = await grantRequestArg(context.parsed.flags, context.io.stdin)
      const body = await context.hub((hub) => hub.requestGrant(grant, why))
      answer(context, body, requestedText)
    },
  },
  "grant revoke": {
    args: ["<grantID>"],
    async handle(context) {
      userOnly(context.credentials().source, "revoke")
      const body = await grantHub(context, (hub) => hub.revokeGrant(context.parsed.args[0]!))
      answer(context, body, (b) => `revoked ${b.grant.id} (${b.grant.holder})`)
    },
  },
  launch: {
    flags: LAUNCH_FLAGS,
    async handle(context) {
      const spec = await launchSpecArg(context.parsed.flags, { cwd: context.io.cwd ?? process.cwd(), ...(context.io.stdin ? { stdin: context.io.stdin } : {}) })
      const body = await context.hub((hub) => hub.launches.create(spec))
      if (context.json) printJSON(context.io, { launch: body.launch })
      else out(context.io, launchedText(body.launch, body.created, spec.key))
    },
  },
  "launches list": {
    flags: { state: "string", label: "multi" },
    async handle(context) {
      const { flags } = context.parsed
      const state = str(flags, "state")?.split(",").filter(Boolean) as LaunchState[] | undefined
      const body = await context.hub((hub) => hub.launches.list({ ...(state?.length ? { state } : {}), ...(flags.label ? { label: flags.label as string[] } : {}) }))
      answer(context, body, (b) => launchesText(b.launches ?? []))
    },
  },
  "launches show": {
    args: ["<launchID>"],
    async handle(context) {
      const body = await context.hub((hub) => hub.launches.get(context.parsed.args[0]!))
      answer(context, body, (b) => launchText(b.launch))
    },
  },
  "launches stop": {
    args: ["<launchID>"],
    async handle(context) {
      const body = await context.hub((hub) => hub.launches.stop(context.parsed.args[0]!))
      answer(context, body, (b) => stoppedLaunchText(b.launch))
    },
  },
  "node run": {
    async handle({ io }) {
      return runNodeCommand(io)
    },
  },
  "node install": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, installNode(nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "node uninstall": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, uninstallNode(nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "node status": {
    async handle(context) {
      const status = nodeStatus(nodeIo(context.io))
      if (context.json) printJSON(context.io, status)
      else out(context.io, nodeStatusText(status))
    },
  },
  "claude-code install": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, installSpokeService("claude-code", nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "claude-code uninstall": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, uninstallSpokeService("claude-code", nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "claude-code status": {
    async handle(context) {
      spokeStatusOutput(context, "claude-code")
    },
  },
  "codex-spoke install": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, installSpokeService("codex-spoke", nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "codex-spoke uninstall": {
    flags: { "dry-run": "bool" },
    async handle(context) {
      nodeOutput(context.io, uninstallSpokeService("codex-spoke", nodeIo(context.io), { dryRun: context.parsed.flags["dry-run"] === true }))
    },
  },
  "codex-spoke status": {
    async handle(context) {
      spokeStatusOutput(context, "codex-spoke")
    },
  },
  "node openshell check": {
    async handle(context) {
      const { io } = context
      const report = await checkOpenShell({ env: io.env, home: io.home, ...(io.openshellBinary ? { binary: io.openshellBinary } : {}) })
      if (context.json) printJSON(io, report)
      else out(io, openShellCheckText(report))
      return report.ok ? EXIT.ok : EXIT.other
    },
  },
  mcp: {
    async handle({ io, credentials }) {
      if (!io.input) throw new UsageError("needs stdin")
      await serveMcp({ input: io.input, write: io.stdout, log: io.stderr, credentials, version: VERSION, ...(io.signal ? { signal: io.signal } : {}) })
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
const GROUPS: Record<string, string[]> = { "claude-code": [...SERVICE_VERBS], "codex-spoke": [...SERVICE_VERBS], role: ["claim", "release"], decisions: ["list"], grant: ["list", "show", "create", "revoke", "request"], launches: ["list", "show", "stop"], node: ["run", "install", "uninstall", "status", "openshell"], "node openshell": ["check"] }

const groupVerbs = (label: string): string[] | undefined => (Object.hasOwn(GROUPS, label) ? GROUPS[label] : undefined)

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
  if (envelope?.code === "needs_user") for (const line of needsUserLines(envelope)) io.stderr(`${line}\n`)
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
  // `hub claude` passes every other argument to Claude Code; `hub claude-code` has its own subcommands.
  if (name === "claude") return runClaude(rest, { env: io.env, home: io.home, stderr: io.stderr, program: io.program ?? currentProgram() })
  // Their service verbs (install, uninstall, status) are commands of this CLI, like `hub node install`.
  if (name === "claude-code" && !isServiceVerb(rest[0])) return claudeCodeMain(rest, io)
  if (name === "preset") return presetMain(rest, io)
  // `hub codex` passes every other argument to Codex; `hub codex-spoke serve` is the spoke service it starts.
  if (name === "codex") return runCodex(rest, { env: io.env, home: io.home, stderr: io.stderr, program: io.program ?? currentProgram() })
  if (name === "codex-spoke" && !isServiceVerb(rest[0])) return codexMain(rest, io)
  let label = name
  // Groups nest (`hub node openshell check`): each level picks one of its sub-verbs.
  for (let verbs = groupVerbs(label); verbs; verbs = groupVerbs(label)) {
    const verb = rest.shift()
    if (verb === "--help" || verb === "-h") {
      out(io, USAGE)
      return EXIT.ok
    }
    if (verb === undefined || !verbs.includes(verb)) {
      io.stderr(`hub ${label}: ${verb === undefined ? "needs" : `unknown subcommand ${verb}; use`} ${verbs.join(" or ")}\n`)
      return EXIT.usage
    }
    label = `${label} ${verb}`
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
    return (await command.handle({ io, parsed, json, credentials, hub: (use) => withHub(credentials(), use) })) ?? EXIT.ok
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
