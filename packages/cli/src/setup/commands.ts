// `hubctl machine enroll|status` and `hubctl setup discover|preview|apply|verify|drift|rollback|recover|ansible`
// (HBS-13, contracts §7 I1/I3/I7). Each command prints one hub.bootstrap.result envelope with --json (and text for
// people otherwise) and exits with exitFor(code). The program name (`hub` or `hubctl`) never matters; authority comes
// only from the machine credential, the profile and the explicit consent flags (--escalate, --confirm-activation,
// --allow-downgrade), which are never defaults.
//
// Preview and apply are built by the same runtime (runtime.ts) from the same profile and choices: `setup preview
// --out <file>` keeps the preview with those inputs, `setup apply --preview <file>` rediscovers and re-plans with
// them, revalidates the token against the fresh plan (revalidateApply), and the engine applies that fresh plan.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"
import {
  ENROLLMENT_MODES,
  ENVELOPE_SCHEMA,
  exitFor,
  HARNESS_ORDER,
  harnessReadiness,
  PENDING_STEPS,
  PROFILE_IDS,
  programLayout,
  resolvePathRef,
  rootPathIn,
  executionContextOf,
  validateEnvelope,
  type DiscoverySnapshot,
  type EnrollmentMode,
  type ErrorCode,
  type HarnessID,
  type HarnessReadiness,
  type Issue,
  type Json,
  type PathRef,
  type Profile,
  type ResultEnvelope,
  type SetupPlan,
  type VerifiedManifest,
} from "../bootstrap/contracts/index.ts"
import { verifyManifest } from "../bootstrap/contracts/index.ts"
import { OpencodePlanError } from "../bootstrap/adapters/opencode/plan.ts"
import { parseJsonc } from "../bootstrap/transaction/json-merge.ts"
import { renderRoleVars } from "../bootstrap/ansible/render.ts"
import { createNodeProbe } from "../bootstrap/discovery/node-probe.ts"
import { credentialStoreFor, defaultMachineName, machineEnroll, machineStatus, renderMachineResult, sharingOffWarning } from "../bootstrap/enrollment/index.ts"
import { previewSetup, renderPreview, revalidateApply } from "../bootstrap/preview/index.ts"
import { defaultProfile } from "../bootstrap/profiles/catalog.ts"
import { detectDrift, managedFields, type Observation } from "../bootstrap/profiles/drift.ts"
import { rollbackTo } from "../bootstrap/profiles/history.ts"
import { loadProfile } from "../bootstrap/profiles/versions.ts"
import { parseManifest } from "../bootstrap/release/verify.ts"
import { shippedTrustRoot } from "../bootstrap/release/trust-root.ts"
import { fileState } from "../bootstrap/transaction/state.ts"
import { nodeFs } from "../bootstrap/transaction/fs.ts"
import { TxError } from "../bootstrap/transaction/result.ts"
import { TxStore } from "../bootstrap/transaction/store.ts"
import type { TxOutcome } from "../bootstrap/transaction/engine.ts"
import { readNodeConfig, nodeConfigPath } from "../../../node/src/config.ts"
import { str, UsageError, type FlagKind, type Parsed } from "../args"
import { resolveCredentials, type Env } from "../credentials"
import { clientFor } from "../http"
import { hubLaunchDriver } from "./launch-driver.ts"
import { errorCodeOf, issuesText, PlanRefusal } from "./contributors.ts"
import { createSetupRuntime, enrollPromptText, type RuntimePorts, type SetupRuntime } from "./runtime.ts"
import { BootstrapStateStore, raiseFloors, validateSetupRequest, type BootstrapState, type SetupChoices, type SetupRequest } from "./state.ts"

/** Test seams (never set by main.ts): fakes for everything that reaches outside the process. */
export interface BootstrapSeams {
  readonly ports?: RuntimePorts
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** The machine identity discovery fingerprints (default: the OS's). */
  readonly machineID?: string
  /** A trust root to verify manifests with, instead of the embedded one (tests only). */
  readonly trustRoot?: string
  /** Floor of the enrollment poll interval. */
  readonly minIntervalMs?: number
}

export interface SetupIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  stdout(s: string): void
  stderr(s: string): void
  readonly stdin?: () => Promise<string>
  readonly signal?: AbortSignal
  readonly cwd?: string
  /** What runs this CLI (process.execPath and the real path of argv[1]). */
  readonly program: { readonly execPath: string; readonly entry: string }
  readonly version: string
  readonly bootstrap?: BootstrapSeams
}

const CONSENT_FLAGS = { escalate: "bool", "confirm-activation": "bool", "allow-downgrade": "bool" } as const satisfies Record<string, FlagKind>

/** The flags of each command (args.ts CommandSpec). */
export const BOOTSTRAP_FLAGS: Readonly<Record<string, Readonly<Record<string, FlagKind>>>> = {
  "machine enroll": { server: "string", name: "string", reenroll: "bool", "no-verify": "bool" },
  "machine status": { "no-verify": "bool" },
  "setup discover": {},
  "setup preview": { profile: "string", manifest: "string", out: "string", enrollment: "string", "workspace-root": "multi", "verify-launch": "string", server: "string", name: "string", ...CONSENT_FLAGS },
  "setup apply": { preview: "string", manifest: "string", "require-ready": "bool", ...CONSENT_FLAGS },
  "setup verify": { profile: "string" },
  "setup drift": { profile: "string", manifest: "string" },
  "setup rollback": { to: "string", "dry-run": "bool" },
  "setup recover": { resume: "bool", manifest: "string", "require-ready": "bool", ...CONSENT_FLAGS },
  "setup ansible": { profile: "string", plan: "string", manifest: "string", "release-url": "string", "no-require-ready": "bool", "apply-require-ready": "bool", ...CONSENT_FLAGS },
}

// ---------- output ----------

class Refusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

const line = (s: string, max = 500) => {
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function envelope(command: string, ok: boolean, extra: { data?: unknown; error?: { code: ErrorCode; message: string; hint?: string }; warnings?: readonly string[] }): ResultEnvelope {
  const e: ResultEnvelope = {
    schema: ENVELOPE_SCHEMA,
    version: 1,
    command,
    ok,
    ...(extra.data !== undefined ? { data: extra.data } : {}),
    ...(extra.error ? { error: { code: extra.error.code, message: line(extra.error.message), ...(extra.error.hint ? { hint: line(extra.error.hint) } : {}) } } : {}),
    ...(extra.warnings?.length ? { warnings: extra.warnings.map((w) => line(w)) } : {}),
  }
  // An envelope that fails its contract (a credential slipped in, say) is withheld.
  return validateEnvelope(e).ok ? e : { schema: ENVELOPE_SCHEMA, version: 1, command, ok: false, error: { code: "internal", message: "The result failed validation and was withheld" } }
}

function emit(io: SetupIo, json: boolean, e: ResultEnvelope, text?: () => string): number {
  if (json) io.stdout(`${JSON.stringify(e, null, 2)}\n`)
  else {
    if (e.ok && text) io.stdout(text().replace(/\n?$/, "\n"))
    if (e.error) io.stderr(`hubctl ${e.command}: ${e.error.message}\n${e.error.hint ? `hint: ${e.error.hint}\n` : ""}`)
    for (const w of e.warnings ?? []) io.stderr(`hubctl: warning: ${w}\n`)
  }
  return e.ok ? 0 : exitFor(e.error!.code)
}

const issueRefusal = (issues: readonly Issue[], hint?: string) => new Refusal(errorCodeOf(issues[0]!.code), issuesText(issues), hint)

// ---------- inputs ----------

const readText = (file: string, what: string): string => {
  try {
    return readFileSync(file, "utf8")
  } catch (cause) {
    throw new Refusal("not_found", `cannot read the ${what} ${file} (${(cause as NodeJS.ErrnoException).code ?? "error"})`)
  }
}

const parseJSON = (text: string, what: string, code: ErrorCode = "invalid"): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Refusal(code, `the ${what} is not JSON`)
  }
}

/** --profile: a catalog profile id, a profile file, or "-" (stdin); version-1 documents are migrated. */
async function profileArg(io: SetupIo, value: string | undefined, fallback?: Profile): Promise<Profile> {
  if (value === undefined) return fallback ?? unwrapProfile(defaultProfile("session-only"))
  if ((PROFILE_IDS as readonly string[]).includes(value)) return unwrapProfile(defaultProfile(value as Profile["id"]))
  if (value !== "-" && !value.includes("/") && !value.endsWith(".json")) throw new Refusal("usage", `unknown profile ${value}: use ${PROFILE_IDS.join(", ")}, a profile file, or - for stdin`)
  const text = value === "-" ? await (io.stdin?.() ?? Promise.reject(new Refusal("usage", "cannot read the profile from stdin here"))) : readText(path.resolve(io.cwd ?? process.cwd(), value), "profile")
  const loaded = loadProfile(parseJSON(text, "profile"))
  if (!loaded.ok) throw issueRefusal(loaded.issues)
  return loaded.value.profile
}

function unwrapProfile(r: ReturnType<typeof defaultProfile>): Profile {
  if (!r.ok) throw issueRefusal(r.issues)
  return r.value
}

/** --manifest: the release manifest, verified with the trust root this hubctl ships (exit 11 when it fails). */
function manifestArg(io: SetupIo, value: string | undefined): VerifiedManifest | undefined {
  if (value === undefined) return undefined
  const parsed = parseManifest(readText(path.resolve(io.cwd ?? process.cwd(), value), "manifest"))
  if (!parsed.ok) throw new Refusal("signature_invalid", issuesText(parsed.issues))
  const root = shippedTrustRoot(io.bootstrap?.trustRoot)
  if (!root.ok) throw new Refusal("signature_invalid", issuesText(root.issues), "Use a signed release build of hubctl to verify release manifests")
  const verified = verifyManifest(parsed.value, root.value)
  if (!verified.ok) throw new Refusal(errorCodeOf(verified.issues[0]!.code) === "invalid" ? "signature_invalid" : errorCodeOf(verified.issues[0]!.code), issuesText(verified.issues))
  return verified.value
}

function context(io: SetupIo) {
  const probe = createNodeProbe({ env: io.env, home: io.home, ...(io.bootstrap?.machineID ? { machineID: io.bootstrap.machineID } : {}) })
  const now = io.bootstrap?.now ?? Date.now
  return { probe, now }
}

function stateStore(snapshot: DiscoverySnapshot): BootstrapStateStore {
  return new BootstrapStateStore(snapshot.roots.map((r) => ({ ...r, path: rootPathIn(r, executionContextOf(snapshot)) })))
}

function readState(snapshot: DiscoverySnapshot): BootstrapState {
  try {
    return stateStore(snapshot).read()
  } catch (error) {
    throw new Refusal("recovery_required", (error as Error).message)
  }
}

/** The verification launch over the hub launch API, with this shell's hub login (resolved when it starts). */
function launchDriverFor(io: SetupIo) {
  const store = credentialStoreFor(io.env, io.home)
  const client = () => {
    const credentials = resolveCredentials(io.env as Env, io.home)
    if (!credentials) throw new Error("not logged in to the hub (run `hub login` with an app token allowed to launch)")
    return clientFor(credentials)
  }
  return hubLaunchDriver({
    launches: {
      create: (spec, options) => client().launches.create(spec, options),
      get: (id, options) => client().launches.get(id, options),
      stop: (id, options) => client().launches.stop(id, options),
      list: (filter) => client().launches.list(filter),
    },
    machineID: async () => (await store.read())?.machineID,
  })
}

function runtimeFor(io: SetupIo, manifest: VerifiedManifest | undefined, snapshot: DiscoverySnapshot): SetupRuntime {
  const { probe, now } = context(io)
  const ports: RuntimePorts = { launchDriver: launchDriverFor(io), ...io.bootstrap?.ports }
  return createSetupRuntime({
    env: io.env,
    home: io.home,
    now,
    probe,
    layout: programLayout(io.program),
    version: io.version,
    ...(manifest ? { manifest } : {}),
    store: credentialStoreFor(io.env, io.home),
    state: readState(snapshot),
    ...(io.bootstrap?.fetch ? { fetch: io.bootstrap.fetch } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    stderr: io.stderr,
    ports,
  })
}

function discovered(io: SetupIo): DiscoverySnapshot {
  const { probe, now } = context(io)
  const r = createSetupRuntime({ env: io.env, home: io.home, now, probe, layout: programLayout(io.program), version: io.version, store: credentialStoreFor(io.env, io.home), state: { schema: "hub.bootstrap-state", version: 1, floors: { harnesses: {} } }, stderr: io.stderr }).discover()
  if (!r.ok) throw issueRefusal(r.issues)
  return r.value
}

/** A PathRef for an absolute path under a mapped root (the verification launch's workspace). */
function refFor(abs: string, snapshot: DiscoverySnapshot): PathRef | undefined {
  const ctx = executionContextOf(snapshot)
  for (const id of ["home"] as const) {
    const root = snapshot.roots.find((r) => r.id === id)
    const base = root ? rootPathIn(root, ctx) : undefined
    if (base && abs.startsWith(`${base}/`)) return { root: id, rel: abs.slice(base.length + 1) }
  }
  return undefined
}

function choicesOf(io: SetupIo, flags: Parsed["flags"], profile: Profile, snapshot: DiscoverySnapshot): SetupChoices {
  const enrollment = str(flags, "enrollment")
  if (enrollment !== undefined && !(ENROLLMENT_MODES as readonly string[]).includes(enrollment)) throw new Refusal("usage", `--enrollment is ${ENROLLMENT_MODES.join(" or ")}`)
  let roots = (flags["workspace-root"] as string[] | undefined)?.map((r) => path.resolve(io.cwd ?? process.cwd(), r))
  if (!roots?.length && profile.services.includes("node")) {
    // Without --workspace-root, the workspace roots node.json already lists.
    const existing = readNodeConfig(nodeConfigPath(io.env as Record<string, string | undefined>, io.home)).config.workspaceRoots
    if (existing.length > 0) roots = [...existing]
  }
  const launchHarness = str(flags, "verify-launch")
  let launch: SetupChoices["launch"]
  if (launchHarness !== undefined) {
    if (!(HARNESS_ORDER as readonly string[]).includes(launchHarness)) throw new Refusal("usage", `--verify-launch takes ${HARNESS_ORDER.join(", ")}`)
    const workspace = roots?.[0] ? refFor(roots[0], snapshot) : undefined
    if (!workspace) throw new Refusal("usage", "--verify-launch launches in the first workspace root, which must be under your home directory (--workspace-root)")
    launch = { harness: launchHarness as HarnessID, workspace }
  }
  const server = str(flags, "server")
  return {
    ...(enrollment ? { enrollment: enrollment as EnrollmentMode } : {}),
    ...(flags["confirm-activation"] === true ? { activate: true } : {}),
    ...(flags["allow-downgrade"] === true ? { allowDowngrade: true } : {}),
    ...(roots?.length ? { node: { workspaceRoots: roots } } : {}),
    ...(launch ? { launch } : {}),
    ...(server ? { server: server.replace(/\/+$/, ""), machineName: str(flags, "name") ?? defaultMachineName(hostname()) } : {}),
  }
}

/** Planner refusals thrown by adapters and contributors (OpencodePlanError, PlanRefusal) as envelope errors. */
function planned<T>(f: () => T): T {
  try {
    return f()
  } catch (error) {
    if (error instanceof OpencodePlanError || error instanceof PlanRefusal) throw new Refusal(error.code, error.message)
    throw error
  }
}

const usedNonces = (snapshot: DiscoverySnapshot): Set<string> => {
  try {
    return new Set(new TxStore(nodeFs, snapshot.roots, executionContextOf(snapshot)).journals().map((j) => j.nonce))
  } catch {
    return new Set()
  }
}

// ---------- machine ----------

async function machine(verb: string, flags: Parsed["flags"], io: SetupIo, json: boolean): Promise<number> {
  const verify = flags["no-verify"] !== true
  const fetchImpl = io.bootstrap?.fetch
  if (verb === "status") {
    const r = await machineStatus({ store: credentialStoreFor(io.env, io.home), verify, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(io.signal ? { signal: io.signal } : {}) })
    return printMachine(io, json, r.envelope, r.exit)
  }
  const server = str(flags, "server")
  if (!server) throw new UsageError("needs --server <hub URL> (https; plain http only for a loopback hub)")
  const r = await machineEnroll({
    server: server.replace(/\/+$/, ""),
    ...(str(flags, "name") ? { machineName: str(flags, "name")! } : {}),
    store: credentialStoreFor(io.env, io.home, { migrate: true }),
    ...(flags.reenroll === true ? { reenroll: true } : {}),
    verify,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    ...(io.bootstrap?.minIntervalMs !== undefined ? { minIntervalMs: io.bootstrap.minIntervalMs } : {}),
    // Prompts go to stderr, so --json keeps stdout to the one envelope.
    onPrompt: (p) => io.stderr(enrollPromptText(p)),
  })
  return printMachine(io, json, r.envelope, r.exit)
}

function printMachine(io: SetupIo, json: boolean, e: ResultEnvelope, exit: number): number {
  if (json) io.stdout(`${JSON.stringify(e, null, 2)}\n`)
  else (e.ok ? io.stdout : io.stderr)(renderMachineResult(e))
  return exit
}

// ---------- setup ----------

function previewWarnings(snapshot: DiscoverySnapshot, plan: SetupPlan, notes: readonly string[]): string[] {
  const warnings = [...notes]
  const mcp = plan.actions.some((a) => a.kind === "register-mcp-server")
  const installs = plan.actions.some((a) => a.kind === "install-artifact")
  const bin = resolvePathRef({ root: "user-bin", rel: "hubctl" }, snapshot.roots, executionContextOf(snapshot))
  if (mcp && !installs && bin.ok && !existsSync(bin.value))
    warnings.push(`the hub MCP server runs ${bin.value}, which is not installed yet: install the standalone hubctl there (or preview with --manifest, so the plan installs it)`)
  return warnings
}

async function preview(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const snapshot = discovered(io)
  const manifest = manifestArg(io, str(flags, "manifest"))
  const runtime = runtimeFor(io, manifest, snapshot)
  const state = readState(snapshot)
  const profile = await profileArg(io, str(flags, "profile"), state.profile)
  const choices = choicesOf(io, flags, profile, snapshot)
  const bundle = await runtime.plan(profile, choices)
  const { probe, now } = context(io)
  const r = planned(() => previewSetup({ probe, profile, now: now(), ...bundle.sources }))
  if (!r.ok) throw issueRefusal(r.issues)
  const out = str(flags, "out")
  if (out) {
    const request: SetupRequest = { schema: "hub.setup-request", version: 1, preview: r.value, profile, choices }
    const file = path.resolve(io.cwd ?? process.cwd(), out)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  }
  const warnings = previewWarnings(snapshot, r.value.plan, bundle.node()?.notes ?? [])
  return emit(io, json, envelope("setup preview", true, { data: r.value, warnings }), () =>
    [...renderPreview(r.value, io.home), ...(out ? [`Saved for apply: hubctl setup apply --preview ${out}`] : ["Keep it for apply with --out <file>; then: hubctl setup apply --preview <file>"])].join("\n"),
  )
}

function readRequest(io: SetupIo, file: string | undefined): SetupRequest {
  if (!file) throw new UsageError("needs --preview <file> (from hubctl setup preview --out <file>)")
  const raw = parseJSON(readText(path.resolve(io.cwd ?? process.cwd(), file), "preview"), "preview", "preview_invalid")
  const r = validateSetupRequest(raw)
  if (!r.ok) throw new Refusal("preview_invalid", `${file} is not a hubctl setup preview: ${issuesText(r.issues)}`, "Preview again: hubctl setup preview --out <file>")
  return r.value
}

const reportData = (outcome: TxOutcome) =>
  outcome.report ? { txID: outcome.report.txID, state: outcome.report.state, steps: outcome.report.steps, conflicts: outcome.report.conflicts, kept: outcome.report.kept, evidence: outcome.report.evidence } : undefined

/** Directories a rollback left in place because something else wrote into them: informational, not a warning. */
function noteKept(io: SetupIo, json: boolean, outcome: { readonly report?: TxOutcome["report"] }): void {
  if (json) return
  for (const k of outcome.report?.kept ?? []) io.stderr(`hubctl: note: kept ${k.path ?? k.actionID}: ${k.reason}\n`)
}

// ---------- readiness (contract v1.2) ----------

/** One harness's readiness as `setup apply` and `setup verify` report it. */
export interface HarnessReport {
  readonly harness: HarnessID
  readonly ready: boolean
  /** ready; installed-not-ready (only user probes wait: login, spoke); failed (an integrity probe failed). */
  readonly state: "ready" | "installed-not-ready" | "failed"
  readonly probes: HarnessReadiness["probes"]
  readonly nextSteps: readonly string[]
}

const READINESS_STATE = { ready: "ready", pending: "installed-not-ready", failed: "failed" } as const

export const harnessReport = (r: HarnessReadiness): HarnessReport => ({ harness: r.harness, ready: r.state === "ready", state: READINESS_STATE[r.state], probes: r.probes, nextSteps: r.nextSteps })

/**
 * The OpenCode spoke connects only while config.json's `mode` is not "off". When the user turned sharing off, a
 * pending spoke-connected probe waits on that, not on starting OpenCode, so its next step says so.
 */
export function withSharingStep(reports: readonly HarnessReport[], sharing: { readonly off: boolean; readonly location: string }): HarnessReport[] {
  if (!sharing.off) return [...reports]
  const start = PENDING_STEPS.opencode["spoke-connected"]
  return reports.map((r) =>
    r.harness === "opencode" && r.probes.some((p) => p.kind === "spoke-connected" && p.status === "pending")
      ? { ...r, nextSteps: r.nextSteps.map((s) => (s === start ? sharingOffWarning(sharing.location) : s)) }
      : r,
  )
}

function sharingOf(io: SetupIo): { off: boolean; location: string } {
  const store = credentialStoreFor(io.env, io.home)
  try {
    return { off: store.sharingMode() === "off", location: store.location }
  } catch {
    return { off: false, location: store.location }
  }
}

const READINESS_TEXT = { ready: "ready", "installed-not-ready": "installed, not ready", failed: "not working" } as const

function readinessText(reports: readonly HarnessReport[]): string[] {
  return reports.flatMap((h) => [
    `${h.harness}: ${READINESS_TEXT[h.state]}`,
    ...h.probes.map((p) => `  ${({ pass: "ok     ", pending: "pending", fail: "FAIL   " } as const)[p.status]} ${p.kind}${p.detail ? `: ${p.detail}` : ""}`),
    ...h.nextSteps.map((s) => `  next: ${s}`),
  ])
}

/** Collects the readiness each verify-harness step reports (the latest per harness, in HARNESS_ORDER). */
function readinessCollector() {
  const seen = new Map<HarnessID, HarnessReadiness>()
  return {
    onReadiness: (r: HarnessReadiness) => void seen.set(r.harness, r),
    reports: (): HarnessReport[] => HARNESS_ORDER.flatMap((h) => (seen.has(h) ? [harnessReport(seen.get(h)!)] : [])),
  }
}

async function apply(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const request = readRequest(io, str(flags, "preview"))
  const snapshot = discovered(io)
  const manifest = manifestArg(io, str(flags, "manifest"))
  const runtime = runtimeFor(io, manifest, snapshot)
  const bundle = await runtime.plan(request.profile, request.choices)
  const allowDowngrade = flags["allow-downgrade"] === true
  const requireReady = flags["require-ready"] === true
  const readiness = readinessCollector()
  // A verification launch needs its harness ready, so --verify-launch keeps that harness strict.
  const strict = request.choices.launch ? [request.choices.launch.harness] : []
  const applier = runtime.applier(snapshot, runtime.executors(bundle, snapshot, { allowDowngrade, requireReady, strict, onReadiness: readiness.onReadiness }))
  const { probe, now } = context(io)
  const outcome = await applier.apply({
    token: request.preview.token,
    consent: { escalate: flags.escalate === true, confirmActivation: flags["confirm-activation"] === true },
    replan: async () => {
      let r: ReturnType<typeof revalidateApply>
      try {
        r = revalidateApply({ token: request.preview.token, probe, profile: request.profile, now: now(), usedNonces: usedNonces(snapshot), ...bundle.sources })
      } catch (error) {
        if (error instanceof OpencodePlanError || error instanceof PlanRefusal) throw new TxError(error.code, error.message)
        throw error
      }
      if (!r.ok) throw new TxError(errorCodeOf(r.issues[0]!.code), issuesText(r.issues))
      return { plan: r.value.plan, snapshot: r.value.snapshot, blockers: r.value.blockers, evidence: r.value.evidence }
    },
  })
  if (!outcome.ok) {
    const report = reportData(outcome)
    const harnesses = withSharingStep(readiness.reports(), sharingOf(io))
    const data = report || harnesses.length > 0 ? { ...report, ...(harnesses.length > 0 ? { ready: false, harnesses } : {}) } : undefined
    const pendingOnly = harnesses.length > 0 && harnesses.every((h) => h.state !== "failed")
    const hint = outcome.code.startsWith("preview_")
      ? "Preview again: hubctl setup preview --out <file>"
      : outcome.code === "recovery_required"
        ? "Run hubctl setup recover first"
        : outcome.code === "harness_not_ready" && requireReady && pendingOnly
          ? "Only your provider login or the harness's spoke is missing; without --require-ready apply installs it as installed, not ready, so you can log in and start it"
          : undefined
    if (!json && harnesses.length > 0) io.stderr(`${readinessText(harnesses).join("\n")}\n`)
    noteKept(io, json, outcome)
    return emit(io, json, envelope("setup apply", false, { ...(data ? { data } : {}), error: { code: outcome.code, message: outcome.message, ...(hint ? { hint } : {}) } }))
  }
  // Record what was applied (secret-free): the profile, its choices and catalog revision, and the floors seen.
  const store = stateStore(snapshot)
  const state = readState(snapshot)
  store.write({
    schema: "hub.bootstrap-state",
    version: 1,
    profile: request.profile,
    choices: request.choices,
    ...(request.profile.revision ? { catalogRevision: request.profile.revision } : {}),
    txID: outcome.report.txID,
    planDigest: request.preview.planDigest,
    floors: manifest ? raiseFloors(state.floors, manifest, snapshot.host.target) : state.floors,
  })
  store.writeRequest(request)
  const harnesses = withSharingStep(readiness.reports(), sharingOf(io))
  const data = { ...reportData(outcome)!, ready: harnesses.every((h) => h.ready), harnesses }
  const warnings = [
    ...(bundle.node()?.notes ?? []),
    ...outcome.report.conflicts.map((c) => `${c.actionID}: ${c.reason}`),
    ...harnesses.filter((h) => !h.ready).map((h) => `${h.harness} is installed, not ready: ${h.probes.filter((p) => p.status !== "pass").map((p) => p.kind).join(", ")} waits on you (see the next steps)`),
  ]
  return emit(io, json, envelope("setup apply", true, { data, warnings }), () =>
    [
      `Applied ${outcome.report.steps.length} step(s) (${outcome.report.txID}); undo with hubctl setup rollback`,
      ...outcome.report.steps.map((s) => `  ${s.outcome.padEnd(8)} ${s.actionID}`),
      ...readinessText(harnesses),
    ].join("\n"),
  )
}

async function verify(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const snapshot = discovered(io)
  const state = readState(snapshot)
  const profile = await profileArg(io, str(flags, "profile"), state.profile)
  const runtime = runtimeFor(io, undefined, snapshot)
  const now = context(io).now()
  const verifications = await runtime.verify(profile.harnesses)
  const harnesses = withSharingStep(
    verifications.map((v) => harnessReport(harnessReadiness(v, now))),
    sharingOf(io),
  )
  const ready = harnesses.every((h) => h.ready)
  const data = { profile: profile.id, ready, harnesses }
  const text = () => readinessText(harnesses).join("\n")
  if (ready) return emit(io, json, envelope("setup verify", true, { data }), text)
  const failing = harnesses.filter((h) => !h.ready).map((h) => h.harness)
  if (!json) io.stdout(`${text()}\n`)
  return emit(io, json, envelope("setup verify", false, { data, error: { code: "harness_not_ready", message: `not ready: ${failing.join(", ")}`, hint: "Provider and harness logins stay with you on this machine; the failing probes say what is missing" } }))
}

/** What is in the files the desired plan manages (data for detectDrift; read here, never by the drift module). */
function observe(plan: SetupPlan, snapshot: DiscoverySnapshot): Observation {
  const fields: NonNullable<Observation["fields"]>[number][] = []
  const registrations: NonNullable<Observation["registrations"]>[number][] = []
  const ctx = executionContextOf(snapshot)
  const read = (ref: PathRef): { exists: boolean; value?: unknown } | undefined => {
    const where = resolvePathRef(ref, snapshot.roots, ctx)
    if (!where.ok) return undefined
    if (!existsSync(where.value)) return { exists: false }
    try {
      const parsed = parseJsonc(readFileSync(where.value, "utf8"))
      return parsed.ok ? { exists: true, value: parsed.value } : undefined
    } catch {
      return undefined
    }
  }
  const at = (value: unknown, pointer: string): { found: boolean; value?: unknown } => {
    let cur = value
    for (const raw of pointer.split("/").slice(1)) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
      if (cur === null || typeof cur !== "object" || !(key in (cur as object))) return { found: false }
      cur = (cur as Record<string, unknown>)[key]
    }
    return { found: true, value: cur }
  }
  for (const f of managedFields(plan)) {
    if (f.type === "config-value" || f.type === "array-entry") {
      const file = read(f.path)
      if (!file) continue
      const pointer = f.pointer!.endsWith("/-") ? f.pointer!.slice(0, -2) : f.pointer!
      const found = file.exists ? at(file.value, pointer) : { found: false }
      fields.push(found.found ? { path: f.path, pointer, state: "value", value: found.value as Json } : { path: f.path, pointer, state: "absent" })
    } else if (f.type === "mcp-registration" && f.registration) {
      const file = read(f.path)
      if (!file) continue
      const server = file.exists ? at(file.value, `/mcp/servers/${f.registration.name}`) : { found: false }
      const command = (server.value as { command?: unknown } | undefined)?.command
      const ours = Array.isArray(command) && command[1] === "mcp" && typeof command[0] === "string" && ["hub", "hubctl"].includes(path.basename(command[0]))
      registrations.push({ ...f.registration, state: !server.found ? "absent" : ours ? "ours" : "foreign" })
    }
  }
  return { fields, registrations }
}

/**
 * The fields hub still manages: the fresh plan, plus each applied field step the planner left out because it is
 * already converged (the adapters plan nothing for a config that is as they want it), while the profile still has
 * its component. Without them a converged field would read as "retired".
 */
function withConverged(fresh: SetupPlan, applied: SetupPlan, profile: Profile): SetupPlan {
  const keeps = (a: SetupPlan["actions"][number]): boolean => {
    switch (a.kind) {
      case "register-mcp-server":
        return profile.harnesses.includes(a.harness)
      case "merge-config":
        if (a.owner.startsWith("harness:")) return profile.harnesses.includes(a.owner.slice("harness:".length) as HarnessID)
        if (a.path.rel === "hub/node.json") return profile.services.includes("node")
        if (a.path.rel === "hub/claude-code.json") return profile.harnesses.includes("claude-code")
        return true
      case "install-service":
        return profile.services.includes(a.service)
      case "write-file":
        return true
      default:
        return false
    }
  }
  const ids = new Set(fresh.actions.map((a) => a.id))
  const extra = applied.actions.filter((a) => !ids.has(a.id) && keeps(a))
  return extra.length === 0 ? fresh : { ...fresh, actions: [...fresh.actions, ...extra] }
}

async function drift(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const snapshot = discovered(io)
  const state = readState(snapshot)
  const profile = await profileArg(io, str(flags, "profile"), state.profile)
  const manifest = manifestArg(io, str(flags, "manifest"))
  const runtime = runtimeFor(io, manifest, snapshot)
  const bundle = await runtime.plan(profile, state.choices ?? {})
  const { probe, now } = context(io)
  const desired = planned(() => previewSetup({ probe, profile, now: now(), ...bundle.sources }))
  if (!desired.ok) throw issueRefusal(desired.issues)
  const store = new TxStore(nodeFs, snapshot.roots, executionContextOf(snapshot))
  const committed = store.journals().filter((j) => j.state === "committed" && j.hostFingerprint === snapshot.host.fingerprint).sort((a, b) => a.startedAt - b.startedAt)
  const last = committed.at(-1)
  const lastPlan = last ? store.readPlan(last) : undefined
  const want = lastPlan ? withConverged(desired.value.plan, lastPlan, profile) : desired.value.plan
  const report = detectDrift({ desired: want, snapshot, ...(last && lastPlan ? { applied: { plan: lastPlan, journal: last } } : {}), observed: observe(want, snapshot) })
  if (!report.ok) throw issueRefusal(report.issues)
  const r = report.value
  return emit(io, json, envelope("setup drift", true, { data: r }), () =>
    r.inSync ? "in sync: every field hub manages is as the profile wants" : r.fields.filter((f) => f.status !== "in-sync").map((f) => `${f.status}: ${f.key}${f.repairable ? " (setup preview/apply repairs it)" : ""}`).join("\n"),
  )
}

async function rollback(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const snapshot = discovered(io)
  const to = str(flags, "to")
  const store = new TxStore(nodeFs, snapshot.roots, executionContextOf(snapshot))
  if (flags["dry-run"] === true) {
    const journals = store.journals()
    const plan = rollbackTo(journals, to, (entry) => {
      const where = entry.path ? resolvePathRef(entry.path, snapshot.roots, executionContextOf(snapshot)) : undefined
      return where?.ok ? fileState(nodeFs, where.value, { tree: entry.class === "harness" }) : { exists: false }
    }, { hostFingerprint: snapshot.host.fingerprint, plans: journals.flatMap((j) => store.readPlan(j) ?? []) })
    if (!plan.ok) throw issueRefusal(plan.issues)
    return emit(io, json, envelope("setup rollback", true, { data: plan.value }), () => plan.value.steps.map((s) => `${s.decision}: ${s.actionID}${s.path ? ` (${s.path.root}:${s.path.rel})` : ""}`).join("\n") || "nothing to roll back")
  }
  const state = readState(snapshot)
  const runtime = runtimeFor(io, undefined, snapshot)
  const profile = state.profile ?? unwrapProfile(defaultProfile("session-only"))
  const bundle = await runtime.plan(profile, state.choices ?? {})
  const outcome = await runtime.applier(snapshot, runtime.executors(bundle, snapshot, {})).rollback(to ? { to } : {})
  if (!outcome.ok) return emit(io, json, envelope("setup rollback", false, { error: { code: outcome.code, message: outcome.message } }))
  if (!outcome.report) return emit(io, json, envelope("setup rollback", true, { data: { rolledBack: false } }), () => "nothing to roll back")
  // The state now describes the target transaction (or nothing, after a full rollback).
  const target = to ? store.journals().find((j) => j.txID === to) : undefined
  const request = target ? stateStore(snapshot).readRequest(target.planDigest) : undefined
  stateStore(snapshot).write({
    schema: "hub.bootstrap-state",
    version: 1,
    ...(request ? { profile: request.profile, choices: request.choices, ...(request.profile.revision ? { catalogRevision: request.profile.revision } : {}), txID: target!.txID, planDigest: target!.planDigest } : {}),
    floors: state.floors,
  })
  noteKept(io, json, outcome)
  const data = { rolledBack: true, ...reportData(outcome) }
  const warnings = outcome.report.conflicts.map((c) => `${c.actionID}: ${c.reason}`)
  return emit(io, json, envelope("setup rollback", true, { data, warnings }), () => `rolled back${to ? ` to ${to}` : ""}${warnings.length ? ` (${warnings.length} file(s) kept because they changed since)` : ""}`)
}

async function recover(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const snapshot = discovered(io)
  const store = new TxStore(nodeFs, snapshot.roots, executionContextOf(snapshot))
  let pending
  try {
    pending = store.journals().find((j) => j.state !== "committed" && j.state !== "rolled-back")
  } catch (error) {
    throw new Refusal("recovery_required", (error as Error).message)
  }
  const state = readState(snapshot)
  const request = pending ? stateStore(snapshot).readRequest(pending.planDigest) : undefined
  const manifest = manifestArg(io, str(flags, "manifest"))
  const runtime = runtimeFor(io, manifest, snapshot)
  const profile = request?.profile ?? state.profile ?? unwrapProfile(defaultProfile("session-only"))
  const bundle = await runtime.plan(profile, request?.choices ?? state.choices ?? {})
  const mode = flags.resume === true ? "resume" : "rollback"
  if (mode === "resume" && request) {
    // The units a resumed install-service writes are rendered by the same planner (pinned by digest in the plan).
    const { probe, now } = context(io)
    planned(() => previewSetup({ probe, profile, now: now(), ...bundle.sources }))
  }
  const outcome = await runtime.applier(snapshot, runtime.executors(bundle, snapshot, { allowDowngrade: flags["allow-downgrade"] === true, requireReady: flags["require-ready"] === true })).recover({
    mode,
    consent: { escalate: flags.escalate === true, confirmActivation: flags["confirm-activation"] === true },
  })
  noteKept(io, json, outcome)
  if (!outcome.ok) return emit(io, json, envelope("setup recover", false, { ...(outcome.report ? { data: reportData(outcome) } : {}), error: { code: outcome.code, message: outcome.message } }))
  if (!outcome.report) return emit(io, json, envelope("setup recover", true, { data: { recovered: false } }), () => "nothing to recover")
  return emit(io, json, envelope("setup recover", true, { data: { recovered: true, mode, ...reportData(outcome) } }), () => `recovered ${outcome.report!.txID} (${mode}): ${outcome.report!.state}`)
}

async function ansible(io: SetupIo, flags: Parsed["flags"], json: boolean): Promise<number> {
  const releaseURL = str(flags, "release-url")
  if (!releaseURL) throw new UsageError("needs --release-url <https base URL of the hub release>")
  const manifest = manifestArg(io, str(flags, "manifest"))
  if (!manifest) throw new UsageError("needs --manifest <hubctl-manifest.json of that release> (its signature is checked)")
  const profile = await profileArg(io, str(flags, "profile"))
  const planFile = str(flags, "plan")
  let plan: unknown
  if (planFile) {
    const raw = parseJSON(readText(path.resolve(io.cwd ?? process.cwd(), planFile), "plan"), "plan") as Record<string, unknown>
    plan = raw.schema === "hub.setup-request" ? (raw.preview as Record<string, unknown> | undefined)?.plan : raw.schema === "hub.setup-preview" ? raw.plan : raw
  }
  const r = renderRoleVars({
    profile,
    ...(plan !== undefined ? { plan } : {}),
    manifest,
    options: {
      releaseBaseURL: releaseURL,
      escalate: flags.escalate === true,
      confirmActivation: flags["confirm-activation"] === true,
      allowDowngrade: flags["allow-downgrade"] === true,
      requireReady: flags["no-require-ready"] !== true,
      applyRequireReady: flags["apply-require-ready"] === true,
    },
  })
  if (!r.ok) return emit(io, json, envelope("setup ansible", false, { error: { code: r.error.code, message: r.error.message } }))
  if (json) return emit(io, true, envelope("setup ansible", true, { data: r.vars }))
  io.stdout(r.yaml.endsWith("\n") ? r.yaml : `${r.yaml}\n`)
  return 0
}

async function discoverCommand(io: SetupIo, json: boolean): Promise<number> {
  const snapshot = discovered(io)
  return emit(io, json, envelope("setup discover", true, { data: snapshot }), () => {
    const h = snapshot.harnesses.map((x) => `${x.id}: ${x.installed ? `${x.path}${x.version ? ` (${x.version})` : ""}${x.installMethod ? `, ${x.installMethod}` : ""}` : "not installed"}`)
    return [`host: ${snapshot.host.target}${snapshot.host.supported ? "" : " (unsupported)"}, ${snapshot.host.os.name} ${snapshot.host.os.version}`, `service manager: ${snapshot.managers.service}`, ...h].join("\n")
  })
}

/** Runs `machine <verb>` or `setup <verb>`; the exit code. */
export async function bootstrapCommand(label: string, parsed: Parsed, io: SetupIo): Promise<number> {
  const json = parsed.flags.json === true
  const [group, verb] = label.split(" ") as [string, string]
  try {
    if (group === "machine") return await machine(verb, parsed.flags, io, json)
    switch (verb) {
      case "discover":
        return await discoverCommand(io, json)
      case "preview":
        return await preview(io, parsed.flags, json)
      case "apply":
        return await apply(io, parsed.flags, json)
      case "verify":
        return await verify(io, parsed.flags, json)
      case "drift":
        return await drift(io, parsed.flags, json)
      case "rollback":
        return await rollback(io, parsed.flags, json)
      case "recover":
        return await recover(io, parsed.flags, json)
      case "ansible":
        return await ansible(io, parsed.flags, json)
    }
    throw new UsageError(`unknown subcommand ${verb}`)
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (error instanceof Refusal) return emit(io, json, envelope(label, false, { ...(error.data !== undefined ? { data: error.data } : {}), error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } }))
    const message = error instanceof Error ? error.message : String(error)
    return emit(io, json, envelope(label, false, { error: { code: "internal", message } }))
  }
}

export const MACHINE_VERBS = ["enroll", "status"] as const
export const SETUP_VERBS = ["discover", "preview", "apply", "verify", "drift", "rollback", "recover", "ansible"] as const
