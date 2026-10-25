// The spoke conformance runner (design §13.3, §16): starts a harness driver (testkit driver protocol), has it start its
// harness and spoke against a recording hub, a stub model and a deny-all proxy, drives the spoke through every check,
// then judges what it recorded. Checks that do not apply to what the spoke announced are skipped with a reason.
//
// Order matters: interactive checks run first (permission, deliver, feature probes), then the oversize frame and the
// reconnect (which drops the connection), then the passive checks over everything recorded (events, tokens, frames).
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { helloHarness, isOpenCodeHello, MAX_FRAME, spokeFeatures, type Hello, type ServerRequest } from "../../protocol/src/index.ts"
import { denyProxy, spawnDriver, stubModel, type DriverInfo, type ModelFormat, type SpawnedDriver } from "../../testkit/src/index.ts"
import { confirmations, deliverModeProblems, idempotencyProblems, type Answer } from "./deliver.ts"
import { eventProblems } from "./events.ts"
import { featureProbes, judgeProbe, type ProbeContext } from "./features.ts"
import { frameProblems } from "./frames.ts"
import { helloProblems } from "./hello.ts"
import { recordingHub, type RecordedFrame, type RecordingHub } from "./hub.ts"
import { permissionProblems } from "./permission.ts"
import { reconnectProblems } from "./reconnect.ts"
import { tokenLeaks, type KnownToken } from "./tokens.ts"

export const CHECK_IDS = ["hello", "features", "events", "deliver.idempotent", "deliver.modes", "permission", "tokens", "reconnect", "frames"] as const
export type CheckID = (typeof CHECK_IDS)[number]

export const CHECK_TITLES: Record<CheckID, string> = {
  hello: "Hello shape",
  features: "Feature honesty",
  events: "Events (harness subset)",
  "deliver.idempotent": "Deliver idempotency",
  "deliver.modes": "Deliver result modes",
  permission: "Permission replies",
  tokens: "No tokens in output",
  reconnect: "Reconnect after bye",
  frames: "Frame size limit",
}

export type CheckStatus = "pass" | "fail" | "skip"

export interface CheckResult {
  readonly id: CheckID
  readonly title: string
  readonly status: CheckStatus
  /** Why it failed (empty unless status is "fail"). */
  readonly problems: string[]
  /** Observations that do not fail it. */
  readonly notes: string[]
  /** Why it was skipped. */
  readonly reason?: string
}

export interface ConformanceReport {
  readonly suite: "spoke"
  /** True when no check failed. */
  readonly ok: boolean
  readonly driver: readonly string[]
  readonly harness?: string
  readonly harnessVersion?: string
  readonly evidence?: string
  readonly features: readonly string[]
  readonly startedAt: string
  readonly durationMs: number
  readonly checks: CheckResult[]
}

export interface Timeouts {
  /** For the spoke's first hello after start (and a hello after a dropped connection). */
  readonly helloMs: number
  /** For an answer to a request. */
  readonly requestMs: number
  /** For an event the spoke should send (a session in a sessions frame, permission.asked, permission.replied). */
  readonly eventMs: number
  /** For a turn to end (and for turn and steer probes). */
  readonly turnMs: number
  /** How long to watch for late effects (a second admission, a confirmation, an answer to an oversize frame). */
  readonly settleMs: number
}

export const DEFAULT_TIMEOUTS: Timeouts = { helloMs: 30_000, requestMs: 15_000, eventMs: 15_000, turnMs: 60_000, settleMs: 1500 }

export interface RunOptions {
  /** The driver command: executable and arguments (never run through a shell). */
  readonly driver: readonly string[]
  readonly cwd?: string
  /** The driver process's environment (default: this process's). */
  readonly env?: Readonly<Record<string, string>>
  readonly timeouts?: Partial<Timeouts>
  /** The bye's retryAfterMs in the reconnect check (default 1000). */
  readonly retryAfterMs?: number
  /** Extra time allowed past retryAfterMs for the reconnect (default 3000). */
  readonly reconnectGraceMs?: number
  /** Progress lines (e.g. stderr); never given a token. */
  readonly log?: (line: string) => void
}

type Event = { type: string; data: any }
type Outcome = { status: CheckStatus; problems?: string[]; notes?: string[]; reason?: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const secret = (prefix: string) => `${prefix}_conformance_${randomBytes(18).toString("hex")}`
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const TURN_END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
const DELIVER_META = { kind: "msg", from: "@conformance", to: "@spoke" } as const

/** Runs every check against the spoke the driver starts; resolves with the report (it never throws for a bad spoke). */
export async function runConformance(options: RunOptions): Promise<ConformanceReport> {
  const started = Date.now()
  const t: Timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const retryAfterMs = options.retryAfterMs ?? 1000
  const graceMs = options.reconnectGraceMs ?? 3000
  const log = options.log ?? (() => {})
  const results = new Map<CheckID, Outcome>()
  const set = (id: CheckID, outcome: Outcome) => results.set(id, outcome)
  const fromProblems = (problems: string[], notes: string[] = []): Outcome => ({ status: problems.length ? "fail" : "pass", problems, notes })

  const tokens = { machine: secret("hubm"), session: secret("hubs"), act: secret("huba") }
  const known: KnownToken[] = [
    { kind: "machine", value: tokens.machine },
    { kind: "session", value: tokens.session },
    { kind: "act", value: tokens.act },
  ]
  const work = mkdtempSync(path.join(tmpdir(), "hub-conformance-"))
  const project = path.join(work, "project")
  const home = path.join(work, "home")
  mkdirSync(project)
  mkdirSync(home)

  const hub = recordingHub()
  const stub = stubModel()
  const proxy = await denyProxy()
  const driverResults: unknown[] = []
  let driver: SpawnedDriver | undefined
  let info: DriverInfo | undefined
  let hello: Hello | undefined
  let helloJSON: Record<string, unknown> | undefined

  const events = (from = 0): Event[] =>
    hub.frames
      .slice(from)
      .flatMap((f) => (f.parsed?.t === "event" ? [f.parsed.event as unknown as Event] : []))
  const waitEvent = async (predicate: (e: Event) => boolean, timeoutMs: number, from: number): Promise<Event | undefined> => {
    const frame = await hub.waitFor((f) => f.parsed?.t === "event" && predicate(f.parsed.event as unknown as Event), timeoutMs, from)
    return frame?.parsed?.t === "event" ? (frame.parsed.event as unknown as Event) : undefined
  }
  const waitTurnEnd = (sessionID: string, from: number) => waitEvent((e) => TURN_END.has(e.type) && e.data?.sessionID === sessionID, t.turnMs, from)
  const call = async <T>(promise: Promise<T>): Promise<T> => {
    const value = await promise
    driverResults.push(value)
    return value
  }

  {
    // ---- start ----------------------------------------------------------------------------------------------------
    try {
      driver = spawnDriver(options.driver, { ...(options.cwd ? { cwd: options.cwd } : {}), env: { ...((options.env ?? process.env) as Record<string, string>) } })
    } catch (e) {
      set("hello", { status: "fail", problems: [`could not start the driver: ${message(e)}`] })
      return finish()
    }
    info = await call(driver.describe()).catch((e) => (log(`describe: ${message(e)}`), undefined))
    const format: ModelFormat = info?.models?.[0] ?? "anthropic"
    const baseURL = format === "anthropic" ? stub.anthropicBaseURL : stub.openaiBaseURL
    log(`starting the spoke (model ${format})`)
    try {
      await call(driver.start({ hubURL: hub.url, token: tokens.machine, directory: project, env: { ...proxy.env(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, model: { format, baseURL } }))
    } catch (e) {
      set("hello", { status: "fail", problems: [`the driver could not start the spoke: ${message(e)}`] })
      return finish()
    }

    // ---- hello ----------------------------------------------------------------------------------------------------
    const first = await hub.waitFor(() => true, t.helloMs)
    if (!first) {
      set("hello", { status: "fail", problems: [`the spoke sent no frame within ${t.helloMs} ms of start`] })
      return finish()
    }
    const helloCheck = helloProblems({ raw: first.raw, auth: hub.connections[first.conn]?.auth ?? null, machineToken: tokens.machine, ...(info ? { describe: info } : {}) })
    set("hello", fromProblems(helloCheck.problems, helloCheck.notes))
    hello = first.parsed?.t === "hello" ? first.parsed : undefined
    try {
      helloJSON = JSON.parse(first.raw)
    } catch {}
    if (helloJSON?.t !== "hello") return finish()
    const served: ReadonlySet<string> = hello ? spokeFeatures(hello) : new Set(Array.isArray(helloJSON.features) ? (helloJSON.features as string[]) : [])
    const evidence = hello ? helloHarness(hello).evidence : "unknown"

    // ---- a session ------------------------------------------------------------------------------------------------
    let sessionID: string | undefined
    let directory = project
    let noSession = "the spoke reported no session"
    try {
      sessionID = (await call(driver.createSession({ directory: project }))).sessionID
    } catch (e) {
      noSession = `the driver could not open a session (${message(e)})`
    }
    const reported = await hub.waitFor(
      (f) => f.parsed?.t === "sessions" && f.parsed.sessions.some((s) => sessionID === undefined || s.id === sessionID),
      t.eventMs,
    )
    if (reported?.parsed?.t === "sessions") {
      const info = reported.parsed.sessions.find((s) => sessionID === undefined || s.id === sessionID)
      sessionID = info?.id
      directory = info?.directory || project
    } else if (sessionID) {
      noSession = `session ${sessionID} never appeared in a sessions frame within ${t.eventMs} ms`
      sessionID = undefined
    }
    const exp = Date.now() + 3_600_000
    if (sessionID && served.has("sessionTokens")) await hub.request({ op: "sessionTokens", tokens: [{ sessionID, token: tokens.session, exp }], hubURL: hub.url }, t.requestMs)
    if (sessionID && served.has("actTokens")) await hub.request({ op: "actTokens", tokens: [{ sessionID, token: tokens.act, exp }] }, t.requestMs)

    // ---- activity: a plain prompt ---------------------------------------------------------------------------------
    let canPrompt = false
    if (sessionID) {
      const from = hub.frames.length
      try {
        await call(driver.prompt({ sessionID, text: "conformance: say hello" }))
        canPrompt = true
        await waitTurnEnd(sessionID, from)
      } catch (e) {
        log(`prompt: ${message(e)}`)
      }
    }

    // ---- permission -----------------------------------------------------------------------------------------------
    if (!served.has("permission")) set("permission", { status: "skip", reason: "permission not announced" })
    else if (!sessionID) set("permission", { status: "skip", reason: noSession })
    else if (!canPrompt) set("permission", { status: "skip", reason: "the driver cannot prompt a session" })
    else {
      const tool = await call(driver.call("permissionToolCall")).catch(() => undefined)
      if (!tool || typeof tool.name !== "string") set("permission", { status: "skip", reason: "the driver has no permissionToolCall (the tool call that makes its harness ask permission)" })
      else set("permission", fromProblems(await permissionRounds(sessionID, tool)))
    }

    // ---- deliver --------------------------------------------------------------------------------------------------
    if (!served.has("deliver")) {
      set("deliver.idempotent", { status: "skip", reason: "deliver not announced" })
      set("deliver.modes", { status: "skip", reason: "deliver not announced" })
    } else if (!sessionID) {
      set("deliver.idempotent", { status: "skip", reason: noSession })
      set("deliver.modes", { status: "skip", reason: noSession })
    } else {
      set("deliver.idempotent", fromProblems(await deliverIdempotent(sessionID)))
      set("deliver.modes", fromProblems(await deliverModes(sessionID, evidence), [`evidence ${evidence}`]))
    }

    // ---- feature honesty ------------------------------------------------------------------------------------------
    if (!sessionID) set("features", { status: "skip", reason: noSession })
    else {
      const ctx: ProbeContext = { sessionID, directory, hubURL: hub.url, sessionToken: tokens.session, actToken: tokens.act }
      const probes = featureProbes(served, ctx).sort((a, b) => (a.expect === b.expect ? 0 : a.expect === "refuse" ? -1 : 1))
      const problems: string[] = []
      for (const probe of probes) {
        const slow = probe.req.op === "turn" || probe.req.op === "steer"
        const problem = judgeProbe(probe, await hub.request(probe.req, slow ? t.turnMs : t.requestMs))
        if (problem) problems.push(problem)
      }
      const serving = probes.filter((p) => p.expect === "serve").length
      set("features", fromProblems(problems, [`${serving} announced ops served, ${probes.length - serving} unannounced ops and options refused`]))
    }

    // ---- frames (active): an oversize frame from the hub is ignored -----------------------------------------------
    const frameActive = await oversizeIgnored(sessionID)

    // ---- reconnect ------------------------------------------------------------------------------------------------
    {
      const conns = hub.connections.length
      const from = hub.frames.length
      const bye = Date.now()
      hub.bye("draining", retryAfterMs)
      const again = await hub.waitFor((f) => f.conn >= conns && f.t === "hello", retryAfterMs + graceMs, from)
      const resent =
        !sessionID ||
        (again !== undefined &&
          (await hub.waitFor((f) => f.conn === again.conn && f.parsed?.t === "sessions" && f.parsed.sessions.some((s) => s.id === sessionID), t.eventMs, from)) !== undefined)
      set("reconnect", fromProblems(reconnectProblems({ retryAfterMs, graceMs, helloAfterMs: again ? again.at - bye : undefined, resentSessions: resent })))
    }

    // ---- passive checks -------------------------------------------------------------------------------------------
    if (hello && isOpenCodeHello(hello)) set("events", { status: "skip", reason: "an OpenCode spoke forwards the full event set, not the harness subset" })
    else {
      const all = events()
      const reportedIDs = new Set(hub.frames.flatMap((f) => (f.parsed?.t === "sessions" ? f.parsed.sessions.map((s) => s.id) : [])))
      set("events", all.length ? fromProblems(eventProblems({ events: all, sessions: reportedIDs }), [`${all.length} events`]) : { status: "skip", reason: "the spoke sent no events" })
    }
    set("frames", fromProblems([...frameProblems(hub.frames), ...frameActive]))
    return finish()
  }

  async function permissionRounds(sessionID: string, tool: { name: string; input?: unknown }): Promise<string[]> {
    const problems: string[] = []
    for (const decision of ["once", "reject"] as const) {
      const from = hub.frames.length
      stub.queue({ toolCalls: [{ name: tool.name, input: tool.input ?? {}, id: `call_conformance_${decision}` }] }, { text: "done" })
      await call(driver!.prompt({ sessionID, text: `conformance: permission ${decision}` })).catch(() => undefined)
      const asked = await waitEvent((e) => e.type === "permission.asked" && e.data?.sessionID === sessionID, t.eventMs, from)
      if (!asked) {
        problems.push(`${decision}: no permission.asked within ${t.eventMs} ms after the model called ${tool.name}`)
        await waitTurnEnd(sessionID, from)
        continue
      }
      const requestID = asked.data.id as string
      const answer = await hub.request({ op: "permission", sessionID, requestID, decision }, t.requestMs)
      const replied = await waitEvent((e) => e.type === "permission.replied" && e.data?.requestID === requestID, t.eventMs, from)
      await waitTurnEnd(sessionID, from)
      const toolID = asked.data.source?.id
      const toolEvent = toolID === undefined ? undefined : events(from).find((e) => (e.type === "session.tool.success" || e.type === "session.tool.failed") && e.data?.id === toolID)
      const outcome = toolEvent ? (toolEvent.type === "session.tool.success" ? "success" : "failed") : undefined
      problems.push(...permissionProblems({ decision, answer, replied: replied ? { reply: replied.data.reply } : undefined, tool: outcome }).map((p) => `${decision}: ${p}`))
    }
    return problems
  }

  async function deliverIdempotent(sessionID: string): Promise<string[]> {
    const from = hub.frames.length
    const req: ServerRequest = { op: "deliver", sessionID, messageID: `msg_conformance_${randomBytes(6).toString("hex")}`, text: "conformance: deliver once", wake: true, meta: DELIVER_META }
    const answers: Answer[] = await Promise.all([hub.request(req, t.requestMs), hub.request(req, t.requestMs)])
    answers.push(await hub.request(req, t.requestMs))
    await settleTurns(sessionID, from)
    return idempotencyProblems({ answers, admissions: confirmations(events(from), sessionID) })
  }

  async function deliverModes(sessionID: string, evidence: string): Promise<string[]> {
    const problems: string[] = []
    const start = hub.frames.length
    for (const wake of [false, true]) {
      const from = hub.frames.length
      const req: ServerRequest = { op: "deliver", sessionID, messageID: `msg_conformance_${randomBytes(6).toString("hex")}`, text: `conformance: deliver (wake ${wake})`, wake, meta: DELIVER_META }
      const answer = await hub.request(req, t.requestMs)
      if (!answer) {
        problems.push(`no answer to a deliver with wake: ${wake}`)
        continue
      }
      await sleep(t.settleMs)
      const inboxID = (answer.result as { inboxID?: string } | undefined)?.inboxID
      const confirmed = confirmations(events(from), sessionID, inboxID) > 0
      problems.push(...deliverModeProblems({ evidence, wake, answer, confirmed }).map((p) => `wake ${wake}: ${p}`))
    }
    await settleTurns(sessionID, start)
    return problems
  }

  /** Waits the settle time for late admissions, then out the turn a deliver started (when the spoke reported one). */
  async function settleTurns(sessionID: string, from: number): Promise<void> {
    await sleep(t.settleMs)
    if (events(from).some((e) => e.type === "session.execution.started" && e.data?.sessionID === sessionID)) await waitTurnEnd(sessionID, from)
  }

  async function oversizeIgnored(sessionID: string | undefined): Promise<string[]> {
    const problems: string[] = []
    const from = hub.frames.length
    const conns = hub.connections.length
    const id = "conf_oversize"
    hub.sendRaw(JSON.stringify({ t: "req", id, req: { op: "rename", sessionID: sessionID ?? "ses_conformance", title: "x".repeat(MAX_FRAME) } }))
    await sleep(t.settleMs)
    if (hub.frames.slice(from).some((f) => f.parsed?.t === "res" && f.parsed.id === id)) problems.push(`the spoke answered a request in a frame over ${MAX_FRAME} characters (it must drop it)`)
    // Dropping the connection over it is allowed; the spoke must come back and keep serving.
    const live = hub.connections.at(-1)
    if (!live || live.closedAt !== undefined) {
      const again = await hub.waitFor((f) => f.conn >= conns && f.t === "hello", t.helloMs, from)
      if (!again) return [...problems, `the spoke did not come back within ${t.helloMs} ms after an oversize frame`]
    }
    const probe = { op: "form", sessionID: sessionID ?? "ses_conformance", formID: "frm_conformance_none", cancel: true } as const
    if (!(await hub.request(probe, t.requestMs))) problems.push("the spoke stopped answering requests after an oversize frame")
    return problems
  }

  async function finish(): Promise<ConformanceReport> {
    let stderr = ""
    if (driver) {
      await call(driver.stop()).catch(() => undefined)
      await driver.close(3000).catch(() => undefined)
      stderr = driver.stderr()
    }
    const sources = [
      { source: "the driver's stderr", text: stderr },
      { source: "the driver's stdout", text: driver?.noise.join("\n") ?? "" },
      { source: "driver events", text: JSON.stringify(driver?.events ?? []) },
      { source: "driver results", text: JSON.stringify(driverResults) },
      { source: "frames the spoke sent", text: hub.frames.map((f: RecordedFrame) => f.raw).join("\n") },
    ]
    if (hub.frames.length || driver) set("tokens", fromProblems(tokenLeaks(sources, known)))
    await Promise.allSettled([hub.stop(), stub.stop(), proxy.stop()])
    rmSync(work, { recursive: true, force: true })
    return buildReport()
  }

  function buildReport(): ConformanceReport {
    const redact = (s: string) => known.reduce((out, k) => out.split(k.value).join(`<${k.kind} token>`), s)
    const skipReason = hello || helloJSON?.t === "hello" ? "not reached" : "the spoke never sent a hello"
    const checks: CheckResult[] = CHECK_IDS.map((id) => {
      const outcome = results.get(id) ?? { status: "skip", reason: skipReason }
      return {
        id,
        title: CHECK_TITLES[id],
        status: outcome.status,
        problems: (outcome.problems ?? []).map(redact),
        notes: (outcome.notes ?? []).map(redact),
        ...(outcome.reason !== undefined ? { reason: redact(outcome.reason) } : {}),
      }
    })
    const who = hello ? helloHarness(hello) : undefined
    return {
      suite: "spoke",
      ok: checks.every((c) => c.status !== "fail"),
      driver: options.driver,
      ...(who ? { harness: who.harness, harnessVersion: who.harnessVersion, evidence: who.evidence } : info ? { harness: info.harness, harnessVersion: info.harnessVersion, evidence: info.evidence } : {}),
      features: hello?.features ? [...hello.features] : (info?.features ?? []),
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      checks,
    }
  }
}

export type { RecordingHub }
