#!/usr/bin/env bun
// create-hub-extension: scaffolds a spoke for a new harness, built on HarnessSpoke, with its conformance driver.
//
//   bun packages/spoke-sdk/scaffold.ts <name> <dir> [--namespace <xy>]
//
// <name> is the harness id the spoke announces (a lowercase token, as a hello's `harness`; not a built-in harness);
// <dir> must not exist yet or be empty (nothing is ever overwritten). It writes:
//   spoke.ts   the spoke: a HarnessSpoke for the harness (evidence "hooks"; ops interrupt and stop; deliver) over a
//              placeholder harness that echoes prompts, with the calls a real harness's hooks or events make;
//   driver.ts  the harness driver (testkit driver protocol v1) the conformance suite runs it through;
//   README.md  how to run the conformance suite and where to plug the real harness in.
// The output passes `hub-conformance spoke --driver "bun <dir>/driver.ts"` as written (test/scaffold.test.ts). It
// imports the hub's packages from this checkout by relative path: they are not published on their own.
//
// Session IDs: the spoke maps its harness's native IDs to hub IDs with hubSessionID(<namespace>, id); the namespace is
// two lowercase letters (default: the first two letters of the name, padded with "x"), not one another spoke uses.
// Not shipped in the npm package (package.json files lists packages/spoke-sdk/src only).
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RESERVED_HARNESS_NAMES } from "../protocol/src/index.ts"
import { SESSION_NAMESPACE } from "./src/index.ts"

export const SCAFFOLD_FILES: readonly string[] = ["spoke.ts", "driver.ts", "README.md"]

/** Session namespaces the hub's own spokes use: Claude Code, Codex, presets, the conformance reference spoke. */
export const TAKEN_NAMESPACES: readonly string[] = ["cc", "cx", "pr", "cf"]

export const SCAFFOLD_USAGE = "Usage: bun packages/spoke-sdk/scaffold.ts <name> <dir> [--namespace <xy>]"

export interface ScaffoldOptions {
  /** The harness id (hello `harness`). */
  readonly name: string
  /** Where to write; must not exist or be empty. */
  readonly dir: string
  /** The session namespace (two lowercase letters); default from the name. */
  readonly namespace?: string
}

export interface ScaffoldResult {
  readonly dir: string
  readonly harness: string
  readonly namespace: string
  /** The files written, relative to dir. */
  readonly files: string[]
}

const HARNESS = /^[a-z0-9][a-z0-9._-]*$/
const HARNESS_MAX = 64
const PACKAGES = path.join(import.meta.dir, "..")

/** The default session namespace for a harness name: its first two letters, padded with "x". */
export function sessionNamespace(name: string): string {
  return `${name.replace(/[^a-z]/g, "")}xx`.slice(0, 2)
}

function checkName(name: string): void {
  if (typeof name !== "string" || name.length > HARNESS_MAX || !HARNESS.test(name)) {
    throw new Error(`The harness id must be 1–${HARNESS_MAX} lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (got ${JSON.stringify(name)})`)
  }
  if ((RESERVED_HARNESS_NAMES as readonly string[]).includes(name)) throw new Error(`"${name}" is a built-in harness with its own spoke; pick another name`)
}

function checkNamespace(namespace: string, explicit: boolean): void {
  if (!SESSION_NAMESPACE.test(namespace)) throw new Error(`The session namespace must be two lowercase letters (got ${JSON.stringify(namespace)})`)
  if (TAKEN_NAMESPACES.includes(namespace)) {
    throw new Error(`Session namespace "${namespace}" (ses_${namespace}…) is used by another spoke${explicit ? "" : " (taken from the name)"}; pass --namespace <two other letters>`)
  }
}

function checkDir(dir: string): void {
  if (!existsSync(dir)) return
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`)
  if (readdirSync(dir).length) throw new Error(`${dir} is not empty; the scaffold never overwrites files`)
}

/** The class name for a harness name: "my-agent" → "MyAgentSpoke". */
function className(name: string): string {
  const pascal = name
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")
  return `${/^[0-9]/.test(pascal) ? "H" : ""}${pascal}Spoke`
}

/** `p` with its longest existing prefix resolved through symlinks (Bun resolves imports from a file's real path). */
function realPath(p: string): string {
  const missing: string[] = []
  let at = p
  while (!existsSync(at) && path.dirname(at) !== at) {
    missing.unshift(path.basename(at))
    at = path.dirname(at)
  }
  return path.join(realpathSync(at), ...missing)
}

/** The import specifier, from `dir`, of a file under the hub's packages directory. */
function importPath(dir: string, file: string): string {
  const relative = path.relative(realPath(dir), path.join(realPath(PACKAGES), file)).split(path.sep).join("/")
  return relative.startsWith(".") || path.isAbsolute(relative) ? relative : `./${relative}`
}

/** Writes a minimal spoke for harness `name` and its conformance driver into `dir`. Throws (writing nothing) on a bad name, namespace or directory. */
export function scaffoldSpoke(options: ScaffoldOptions): ScaffoldResult {
  const { name } = options
  checkName(name)
  const namespace = options.namespace ?? sessionNamespace(name)
  checkNamespace(namespace, options.namespace !== undefined)
  const dir = path.resolve(options.dir)
  checkDir(dir)
  const vars: TemplateVars = {
    harness: name,
    namespace,
    className: className(name),
    sdk: importPath(dir, "spoke-sdk/src/index.ts"),
    protocol: importPath(dir, "protocol/src/index.ts"),
    testkit: importPath(dir, "testkit/src/index.ts"),
    conformance: importPath(dir, "conformance/src/cli.ts"),
  }
  const contents: Record<string, string> = { "spoke.ts": spokeSource(vars), "driver.ts": driverSource(vars), "README.md": readmeSource(vars) }
  mkdirSync(dir, { recursive: true })
  for (const file of SCAFFOLD_FILES) writeFileSync(path.join(dir, file), contents[file]!, { flag: "wx" })
  return { dir, harness: name, namespace, files: [...SCAFFOLD_FILES] }
}

/** The command line: exit 0 written, 1 refused, 2 usage. */
export function scaffoldMain(argv: readonly string[], io: { stdout(s: string): void; stderr(s: string): void }, cwd: string = process.cwd()): number {
  const positional: string[] = []
  let namespace: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") {
      io.stdout(`${SCAFFOLD_USAGE}\n`)
      return 0
    }
    if (arg === "--namespace" && i + 1 < argv.length) namespace = argv[++i]
    else if (arg.startsWith("--namespace=")) namespace = arg.slice("--namespace=".length)
    else if (arg.startsWith("-")) {
      io.stderr(`scaffold: unknown option ${arg}\n${SCAFFOLD_USAGE}\n`)
      return 2
    } else positional.push(arg)
  }
  if (positional.length !== 2) {
    io.stderr(`${SCAFFOLD_USAGE}\n`)
    return 2
  }
  const [name, dir] = positional as [string, string]
  let result: ScaffoldResult
  try {
    result = scaffoldSpoke({ name, dir: path.resolve(cwd, dir), ...(namespace !== undefined ? { namespace } : {}) })
  } catch (cause) {
    io.stderr(`scaffold: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  const driver = path.join(result.dir, "driver.ts")
  io.stdout(
    [
      `Wrote the ${result.harness} spoke (sessions ses_${result.namespace}…) in ${result.dir}:`,
      ...result.files.map((f) => `  ${f}`),
      "",
      "Run the conformance suite against it (from the hub checkout):",
      `  npx hub-conformance spoke --driver "bun ${driver}"`,
      "",
    ].join("\n"),
  )
  return 0
}

interface TemplateVars {
  readonly harness: string
  readonly namespace: string
  readonly className: string
  readonly sdk: string
  readonly protocol: string
  readonly testkit: string
  readonly conformance: string
}

function spokeSource(v: TemplateVars): string {
  return `// The ${v.harness} spoke: connects the ${v.harness} harness to a hub. Scaffolded by packages/spoke-sdk/scaffold.ts.
//
// HarnessSpoke (the hub's spoke SDK) does what every spoke must do the same way: the hello (harness, version,
// evidence, and exactly the ops it has handlers for), refusing ops it did not announce, the sessions frame, event
// validation (the harness event subset), session and act tokens (in memory, never logged), and each hub message
// admitted once per messageID. This file adds the harness: replace PlaceholderHarness with calls into the real one,
// and call sessionStarted / promptSubmitted / sessionEnded from its hooks or events.
//
// Evidence "hooks": the hub follows the harness at hook points, treats it as idle on its Stop-like event, and a
// deliver claims "turn" only once the harness confirmed it (session.inbox.delivered, origin "hub"), else "queued".
// Announce more only when the harness really serves it: add a handler (turn, steer, permission, form, …) and the
// conformance suite probes it.
import { randomUUID } from "node:crypto"
import { HarnessSpoke, hubSessionID, type Admission, type DeliverRequest } from "${v.sdk}"
import type { HarnessEvent, SessionInfo } from "${v.protocol}"

export const HARNESS = "${v.harness}"
export const HARNESS_VERSION = "0.0.0"
/** Hub session IDs are ses_${v.namespace}<native ID as hex> (hubSessionID). */
export const SESSION_NAMESPACE = "${v.namespace}"
const TEXT_MAX = 16_000

export interface ${v.className}Options {
  readonly hubURL: string
  /** The machine token (never logged). */
  readonly token: string
  readonly directory: string
  /** Where the spoke logs; never give it a token. */
  readonly log?: (line: string) => void
}

interface Session {
  readonly id: string
  readonly directory: string
  title: string
  busy: boolean
  turn?: AbortController
  /** Hub messages that wake the session, behind the running turn. */
  readonly queue: Array<{ text: string; inboxID: string }>
  /** Hub messages admitted without waking (wake: false): read with the next prompt. */
  readonly context: Array<{ text: string; inboxID: string }>
}

let counter = 0
const nextID = (prefix: string) => prefix + "_" + Date.now().toString(36) + (++counter).toString(36)

/** Stands in for the real harness: a turn echoes its input. Replace it. */
class PlaceholderHarness {
  async run(input: string, signal: AbortSignal): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (signal.aborted) throw new Error("interrupted")
    return "echo: " + input
  }
}

export class ${v.className} {
  readonly spoke: HarnessSpoke
  readonly #sessions = new Map<string, Session>()
  readonly #harness = new PlaceholderHarness()
  readonly #log: (line: string) => void

  constructor(options: ${v.className}Options) {
    this.#log = options.log ?? (() => {})
    this.spoke = new HarnessSpoke({
      server: options.hubURL,
      token: options.token,
      harness: HARNESS,
      harnessVersion: HARNESS_VERSION,
      evidence: "hooks",
      pluginVersion: "0.0.1",
      directory: options.directory,
      handlers: {
        interrupt: (req) => (this.#interrupt(req.sessionID), {}),
        stop: (req) => ({ stopped: this.#interrupt(req.sessionID) ? [req.sessionID] : [] }),
      },
      deliver: (req) => this.#deliver(req),
      onState: (state) => this.#log("hub connection " + state),
    })
  }

  start(): void {
    this.spoke.start()
  }

  stop(): void {
    for (const session of this.#sessions.values()) session.turn?.abort()
    this.spoke.stop()
  }

  // ---- harness → hub: call these from the harness's hooks or events ----------------------------------------------

  /** A session started (its native ID, when the harness has one); returns its hub session ID. */
  sessionStarted(directory: string, nativeID: string = randomUUID(), title = "${v.harness} session"): string {
    const id = hubSessionID(SESSION_NAMESPACE, nativeID)
    const session: Session = { id, directory, title, busy: false, queue: [], context: [] }
    this.#sessions.set(id, session)
    this.spoke.upsertSession(this.#info(session))
    this.#emit({ type: "session.created", data: { sessionID: id, title } })
    return id
  }

  /** The user typed a prompt in the harness: it runs now, or after the running turn. */
  promptSubmitted(sessionID: string, text: string): void {
    const session = this.#session(sessionID)
    const inboxID = nextID("inb")
    this.#emit({ type: "session.inbox.delivered", data: { sessionID, inboxID, origin: "user" } })
    if (session.busy) session.queue.push({ text, inboxID })
    else void this.#turn(session, text)
  }

  /** The user interrupted the running turn in the harness (Esc, Ctrl-C). */
  interrupt(sessionID: string): void {
    this.#interrupt(sessionID)
  }

  /** The session ended: no longer reported, its tokens dropped. */
  sessionEnded(sessionID: string): void {
    this.#interrupt(sessionID)
    if (!this.#sessions.delete(sessionID)) return
    this.spoke.endSession(sessionID)
    this.#emit({ type: "session.deleted", data: { sessionID } })
  }

  // ---- hub → harness ----------------------------------------------------------------------------------------------

  #session(sessionID: string): Session {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Unknown session " + sessionID)
    return session
  }

  #info(session: Session): SessionInfo {
    return { id: session.id, title: session.title, directory: session.directory, updated: Date.now(), owned: true }
  }

  #emit(event: HarnessEvent): void {
    this.spoke.emit(event)
  }

  /** Interrupts the running turn; false when there was none. */
  #interrupt(sessionID: string): boolean {
    const turn = this.#sessions.get(sessionID)?.turn
    turn?.abort()
    return turn !== undefined
  }

  async #deliver(req: DeliverRequest): Promise<Admission> {
    const session = this.#session(req.sessionID)
    const inboxID = nextID("inb")
    if (!req.wake) {
      session.context.push({ text: req.text, inboxID })
      return { result: { delivered: "queued", inboxID }, resumed: false }
    }
    if (session.busy) {
      session.queue.push({ text: req.text, inboxID })
      return { result: { delivered: "queued", inboxID }, resumed: true }
    }
    // Idle: the message starts a turn now, confirmed before answering "turn" (hooks evidence needs the confirmation).
    this.#emit({ type: "session.inbox.delivered", data: { sessionID: session.id, inboxID, origin: "hub" } })
    void this.#turn(session, req.text)
    return { result: { delivered: "turn", inboxID }, resumed: true }
  }

  async #turn(session: Session, text: string): Promise<void> {
    const sessionID = session.id
    const abort = new AbortController()
    const turnID = nextID("trn")
    session.busy = true
    session.turn = abort
    const context = session.context.splice(0)
    for (const message of context) this.#emit({ type: "session.inbox.delivered", data: { sessionID, inboxID: message.inboxID, origin: "hub" } })
    this.#emit({ type: "session.execution.started", data: { sessionID, turnID } })
    this.#emit({ type: "session.status", data: { sessionID, status: { type: "busy" } } })
    try {
      const input = [...context.map((m) => m.text), text].join("\\n\\n")
      const reply = await this.#harness.run(input, abort.signal)
      this.#emit({ type: "session.text.ended", data: { sessionID, assistantMessageID: nextID("msg"), ordinal: 0, text: reply.slice(0, TEXT_MAX) } })
      this.#emit({ type: "session.execution.succeeded", data: { sessionID, turnID } })
    } catch (cause) {
      if (abort.signal.aborted) this.#emit({ type: "session.execution.interrupted", data: { sessionID, turnID } })
      else this.#emit({ type: "session.execution.failed", data: { sessionID, turnID, error: { message: String(cause instanceof Error ? cause.message : cause).slice(0, 1000) } } })
    } finally {
      session.busy = false
      session.turn = undefined
      this.#emit({ type: "session.status", data: { sessionID, status: { type: "idle" } } })
    }
    const next = session.queue.shift()
    if (next && this.#sessions.has(sessionID)) {
      this.#emit({ type: "session.inbox.delivered", data: { sessionID, inboxID: next.inboxID, origin: "hub" } })
      void this.#turn(session, next.text)
    }
  }
}
`
}

function driverSource(v: TemplateVars): string {
  return `#!/usr/bin/env bun
// The ${v.harness} harness driver (testkit driver protocol v1): how the spoke conformance suite starts the harness and
// its spoke, opens sessions and types prompts as the local user. Scaffolded by packages/spoke-sdk/scaffold.ts.
//
//   npx hub-conformance spoke --driver "bun <this directory>/driver.ts"
//
// A real harness's driver starts the harness against params.model (a stub model server) with params.env (a deny-all
// proxy, a throwaway HOME): never the user's configuration, never a real model API. Methods it cannot serve fail with
// DriverError("unsupported", …) and the suite skips what needs them.
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart } from "${v.testkit}"
import { HARNESS, HARNESS_VERSION, ${v.className} } from "./spoke.ts"

const log = (line: string) => process.stderr.write(line + "\\n")
let harness: ${v.className} | undefined
const running = (): ${v.className} => {
  if (!harness) throw new DriverError("not_started", "call start first")
  return harness
}
let directory = process.cwd()

serveDriver({
  describe: () => ({
    protocol: DRIVER_PROTOCOL_VERSION,
    harness: HARNESS,
    harnessVersion: HARNESS_VERSION,
    evidence: "hooks",
    // What the hello announces, from a spoke that is never started.
    features: [...new ${v.className}({ hubURL: "http://127.0.0.1:1", token: "unused", directory: "/" }).spoke.features],
    models: ["chat"],
  }),
  start(params: DriverStart) {
    if (harness) throw new DriverError("started", "already started")
    directory = params.directory
    harness = new ${v.className}({ hubURL: params.hubURL, token: params.token, directory: params.directory, log })
    harness.start()
    return {}
  },
  createSession: (params) => ({ sessionID: running().sessionStarted(params?.directory ?? directory) }),
  prompt: (params) => (running().promptSubmitted(params.sessionID, params.text), {}),
  local(params) {
    if (params.action === "interrupt") running().interrupt(params.sessionID)
    else if (params.action === "exit") running().sessionEnded(params.sessionID)
    else throw new DriverError("unsupported", "the ${v.harness} harness asks no permission (" + params.action + ")")
    return {}
  },
  stop: () => (harness?.stop(), {}),
  shutdown: () => harness?.stop(),
})
`
}

function readmeSource(v: TemplateVars): string {
  return `# ${v.harness} spoke

Scaffolded by \`packages/spoke-sdk/scaffold.ts\`: a spoke that connects the **${v.harness}** harness to a hub, built
on \`HarnessSpoke\` from the hub's spoke SDK, and its conformance driver.

| File | What |
|---|---|
| \`spoke.ts\` | \`${v.className}\`: the HarnessSpoke (harness \`${v.harness}\`, evidence \`hooks\`, ops \`interrupt\` and \`stop\`, \`deliver\`) over a placeholder harness that echoes prompts |
| \`driver.ts\` | the harness driver (driver protocol v1) the conformance suite controls the harness through |

Hub session IDs are \`ses_${v.namespace}…\`: \`hubSessionID("${v.namespace}", nativeID)\` maps the harness's own
session IDs (UUIDs or other IDs) to hub IDs, and \`nativeSessionID\` maps them back.

## Check it

From the hub checkout (after \`npm ci\`):

\`\`\`sh
npx hub-conformance spoke --driver "bun <dir>/driver.ts"
# or: bun ${v.conformance} spoke --driver "bun <dir>/driver.ts"
\`\`\`

As scaffolded, every check passes except **Permission replies**, skipped because the spoke does not announce
\`permission\`.

## Make it real

1. Replace \`PlaceholderHarness\` with the harness: start its turns, interrupt them.
2. Call \`sessionStarted\`, \`promptSubmitted\` and \`sessionEnded\` from the harness's hooks or events, and emit only
   events of the harness subset (\`HARNESS_EVENTS\` in the protocol); \`HarnessSpoke.emit\` refuses anything else.
3. Pick the evidence level the harness really gives (\`native\`, \`hooks\`, \`rpc\`, \`screen\`): the hub infers idle
   and delivery modes from it.
4. Add a handler for each further op the harness really serves (\`turn\`, \`steer\`, \`permission\`, \`form\`, …); the
   spoke announces exactly the ops it has handlers for. For \`permission\`, give the driver a \`permissionToolCall\`
   method (the stub model's tool call that makes the harness ask).
5. Make \`driver.ts\` start the real harness against the suite's stub model and environment, then run the suite again.

See docs/spoke-sdk.md in the hub repository.
`
}

if (import.meta.main) process.exit(scaffoldMain(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }))
