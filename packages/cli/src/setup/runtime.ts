// The composition root of `hubctl setup` (HBS-13): one place that builds the harness adapters, the plan
// contributors and the apply executors from the independently tested bootstrap modules, so preview and apply use the
// SAME adapter registry, contributors and options (and so plan the same digest), and apply executes the fresh plan
// revalidateApply returns.
//
//   adapters      OpenCode, Claude Code, Codex (HARNESS_ORDER), each with its real probes, the machine-credential
//                 spoke probe (spoke-probe.ts) and its pinned-artifact source
//   contributors  hubctl itself (contributors.ts), the node services (node-services/plan.ts), a profile downgrade's
//                 typed service removal (profiles/upgrade.ts), inline enrollment
//   executors     builtinExecutors + the node-service executors + the per-harness dispatchers (dispatch.ts) + the
//                 enroll-machine and verify-runtime executors below
//
// Nothing here runs a shell: processes are started only by the adapters' fixed-argv runners and the service
// manager's fixed-call runner. Every capability that reaches outside is a port the tests replace.
import {
  createAdapterRegistry,
  executionContextOf,
  HARNESS_ORDER,
  ok,
  rootPathIn,
  type AdapterContext,
  type DiscoverySnapshot,
  type HarnessAdapter,
  type HarnessID,
  type HarnessReadiness,
  type HarnessVerification,
  type PathRef,
  type Profile,
  type ProgramLayout,
  type Result,
  type RootMapping,
  type ServiceManagerID,
  type VerifiedManifest,
} from "../bootstrap/contracts/index.ts"
import { claudeVerifyExecutor, createClaudeAdapter, createClaudeHarnessSource, httpsDownloader as claudeDownloader, nodeRunner as claudeNodeRunner, tempScratch, type ProbeRunner as ClaudeProbeRunner } from "../bootstrap/adapters/claude/index.ts"
import { codexVerifyExecutor, createCodexAdapter, createCodexHarnessSource, httpsDownloader as codexDownloader, nodeProbeRunner as codexNodeRunner, stdioAppServerLauncher, type AppServerLauncher, type ProbeRunner as CodexProbeRunner } from "../bootstrap/adapters/codex/index.ts"
import {
  createServiceControl,
  nodeServiceExecutors,
  planNodeServices,
  serviceAssets,
  spawnManagerRunner,
  unitPathResolver,
  type LaunchDriver,
  type LaunchReport,
  type ManagerRunner,
  type NodeServiceControl,
  type NodeServicesPlan,
} from "../bootstrap/adapters/node-services/index.ts"
import { createOpencodeHarness, type Download, type ProcessRunner } from "../bootstrap/adapters/opencode/index.ts"
import { discover } from "../bootstrap/discovery/discover.ts"
import { pathDirs, which } from "../bootstrap/discovery/executables.ts"
import type { DiscoveryProbe } from "../bootstrap/discovery/probe.ts"
import { machineEnroll, type EnrollPrompt } from "../bootstrap/enrollment/enroll.ts"
import type { ConfigCredentialStore } from "../bootstrap/enrollment/store.ts"
import type { PlanSources } from "../bootstrap/preview/plan.ts"
import { installedHarnesses, installedServiceUnits, rollbackHistory, type TransactionRecord } from "../bootstrap/profiles/history.ts"
import { planProfileChange } from "../bootstrap/profiles/upgrade.ts"
import { builtinExecutors, type HarnessSource, type HubctlSource } from "../bootstrap/transaction/builtin.ts"
import { createApplier, type Applier } from "../bootstrap/transaction/engine.ts"
import type { ActionExecutor, ExecutorMap } from "../bootstrap/transaction/executor.ts"
import { nodeFs, type TxFs } from "../bootstrap/transaction/fs.ts"
import { txFail, txOk } from "../bootstrap/transaction/result.ts"
import { TxStore } from "../bootstrap/transaction/store.ts"
import { checkOpenShell } from "../openshell.ts"
import { enrollmentContributor, HUBCTL_REF, hubctlContributor, refusing } from "./contributors.ts"
import { dispatchByHarness, dispatchHarnessSource } from "./dispatch.ts"
import { claudeSpokeProbes, codexSpokeStatus, opencodeSpokeProbe, type PresenceOptions } from "./spoke-probe.ts"
import type { BootstrapState, SetupChoices } from "./state.ts"

/** The capabilities that reach outside, replaced in tests. Production defaults are the adapters' own. */
export interface RuntimePorts {
  readonly opencodeRunner?: ProcessRunner
  readonly opencodeDownload?: Download
  readonly claudeRunner?: ClaudeProbeRunner
  readonly codexRunner?: CodexProbeRunner
  readonly codexAppServer?: AppServerLauncher
  /** The service manager's fixed-call runner (default: launchctl / systemctl --user, spawned without a shell). */
  readonly serviceRunner?: ManagerRunner
  /** The bounded verification launch (launch-session); without one a planned launch is refused at preflight. */
  readonly launchDriver?: LaunchDriver
  /** The bytes of this hubctl (install-artifact copies the running, digest-checked binary). */
  readonly hubctlBytes?: () => Uint8Array | undefined
  readonly fs?: TxFs
  readonly uid?: number
}

export interface RuntimeDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly now: () => number
  readonly probe: DiscoveryProbe
  /** How this process runs (programLayout of process.execPath and argv[1]). */
  readonly layout: ProgramLayout
  /** hubctl's own version (the app-server client version). */
  readonly version: string
  readonly manifest?: VerifiedManifest
  readonly store: ConfigCredentialStore
  readonly state: BootstrapState
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly stderr: (s: string) => void
  readonly ports?: RuntimePorts
}

/** Everything one plan was made with: preview and apply build it from the same profile and choices. */
export interface PlanBundle {
  readonly sources: PlanSources
  /** The node-services plan of the last planning run (its units are what install-service writes). */
  readonly node: () => NodeServicesPlan | undefined
  readonly history: readonly TransactionRecord[]
}

/** The consent and readiness choices apply makes (never part of the plan, so never part of its digest). */
export interface ApplyChoices {
  readonly allowDowngrade?: boolean
  /**
   * v1.2: fail (and roll back) unless every harness is ready (`--require-ready`). Without it a harness that only waits
   * on the user (provider login, spoke) is committed as installed, not ready; an integrity failure still rolls back.
   */
  readonly requireReady?: boolean
  /** Harnesses that must be ready regardless (the --verify-launch harness: the launch needs it). */
  readonly strict?: readonly HarnessID[]
  /** Sees each harness's classified readiness (the apply report). */
  readonly onReadiness?: (readiness: HarnessReadiness) => void
}

export interface SetupRuntime {
  readonly deps: RuntimeDeps
  discover(): Result<DiscoverySnapshot>
  plan(profile: Profile, choices: SetupChoices): Promise<PlanBundle>
  executors(bundle: PlanBundle, snapshot: DiscoverySnapshot, consent: ApplyChoices): ExecutorMap
  applier(snapshot: DiscoverySnapshot, executors: ExecutorMap): Applier
  verify(harnesses: readonly HarnessID[]): Promise<HarnessVerification[]>
  /** This host's transactions (oldest first), from the journals and their plans. */
  history(snapshot: DiscoverySnapshot): TransactionRecord[]
  /** The hubctl the services and MCP clients run: user-bin:hubctl when the plan installs it, else this process. */
  serviceLayout(snapshot: DiscoverySnapshot): ProgramLayout
}

/** A manifest that pins nothing (no --manifest): Codex is then only verified, never installed. */
const NO_PINS = { release: "0.0.0", harnesses: [], artifacts: [] } as unknown as VerifiedManifest

export function createSetupRuntime(deps: RuntimeDeps): SetupRuntime {
  const ports = deps.ports ?? {}
  const fs = ports.fs ?? nodeFs
  let snapshot: DiscoverySnapshot | undefined
  const context = (): AdapterContext => ({ env: deps.env, home: deps.home, platform: deps.probe.platform, arch: deps.probe.arch, now: deps.now, ...(deps.signal ? { signal: deps.signal } : {}) })
  const presence: PresenceOptions = { credential: () => deps.store.read(), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.signal ? { signal: deps.signal } : {}) }
  const floors = deps.state.floors

  const fresh = (): Result<DiscoverySnapshot> => {
    const r = discover(deps.probe, { now: deps.now() })
    if (r.ok) snapshot = r.value
    return r
  }

  function history(snap: DiscoverySnapshot): TransactionRecord[] {
    try {
      const store = new TxStore(fs, snap.roots, executionContextOf(snap))
      const journals = store.journals()
      const plans = journals.flatMap((j) => store.readPlan(j) ?? [])
      const r = rollbackHistory(journals, { hostFingerprint: snap.host.fingerprint, plans })
      return r.ok ? r.value : []
    } catch {
      return []
    }
  }

  function adapters(installed: ReturnType<typeof installedHarnesses>, allowDowngrade: boolean) {
    const manifest = deps.manifest
    const prior = (h: HarnessID) => (installed[h] ? { version: installed[h]!.version, sha256: installed[h]!.sha256 } : undefined)
    const opencode = createOpencodeHarness({
      probe: deps.probe,
      ...(manifest ? { manifest } : {}),
      ...(ports.opencodeRunner ? { runner: ports.opencodeRunner } : {}),
      ...(ports.opencodeDownload ? { download: ports.opencodeDownload } : {}),
      spoke: opencodeSpokeProbe(presence),
      installed: () => prior("opencode"),
      floor: () => floors.harnesses.opencode,
      allowDowngrade,
    })
    const claudeRunner = ports.claudeRunner ?? claudeNodeRunner()
    const claudePrior = prior("claude-code")
    const claudeFloor = floors.harnesses["claude-code"]
    const claude = createClaudeAdapter({
      ...(manifest ? { manifest } : {}),
      ...(claudePrior ? { installed: claudePrior } : {}),
      ...(claudeFloor ? { floor: claudeFloor } : {}),
      allowDowngrade,
      probe: deps.probe,
      probes: { runner: claudeRunner, ...claudeSpokeProbes(presence) },
    })
    const codexPrior = prior("codex")
    const codex = createCodexAdapter({
      manifest: manifest ?? NO_PINS,
      probes: { runner: ports.codexRunner ?? codexNodeRunner, appServer: ports.codexAppServer ?? stdioAppServerLauncher(), spoke: codexSpokeStatus(presence), clientVersion: deps.version },
      snapshot: () => snapshot,
      ...(codexPrior ? { previous: codexPrior } : {}),
    })
    const sources: Partial<Record<HarnessID, HarnessSource>> = {}
    if (manifest) {
      if (opencode.source) sources.opencode = opencode.source
      sources["claude-code"] = createClaudeHarnessSource({
        manifest,
        download: claudeDownloader(),
        runner: claudeRunner,
        scratch: tempScratch(),
        platform: deps.probe.platform,
        ...(claudePrior ? { installed: claudePrior } : {}),
        ...(claudeFloor ? { floor: claudeFloor } : {}),
        allowDowngrade,
      })
      sources.codex = createCodexHarnessSource({ manifest, download: codexDownloader(), installed: () => prior("codex"), floor: () => floors.harnesses.codex, allowDowngrade })
    }
    return { opencode, claude, codex, sources }
  }

  function serviceLayout(snap: DiscoverySnapshot): ProgramLayout {
    const root = snap.roots.find((r) => r.id === "user-bin")
    const installs = deps.manifest?.artifacts.some((a) => a.target === snap.host.target)
    if (root && installs) return { kind: "standalone", executable: `${rootPathIn(root, executionContextOf(snap))}/${HUBCTL_REF.rel}` }
    return deps.layout
  }

  async function plan(profile: Profile, choices: SetupChoices): Promise<PlanBundle> {
    const snap = snapshot ?? (fresh().ok ? snapshot : undefined)
    const records = snap ? history(snap) : []
    const { opencode, claude, codex } = adapters(installedHarnesses(records), choices.allowDowngrade === true)
    const registry = createAdapterRegistry()
    for (const a of [opencode.adapter, claude, codex] as HarnessAdapter[]) registry.register(a)
    let enrolledWith: string | undefined
    try {
      enrolledWith = (await deps.store.read())?.server
    } catch {}
    let nodePlan: NodeServicesPlan | undefined
    const contributors = [
      hubctlContributor(deps.manifest ? { manifest: deps.manifest } : {}),
      refusing((input) => {
        const planned = planNodeServices(input, {
          layout: serviceLayout(input.snapshot),
          ...(choices.node ? { node: choices.node } : {}),
          ...(choices.activate ? { activate: true } : {}),
          environment: deps.env,
          ...(choices.launch ? { launch: choices.launch } : {}),
        })
        if (!planned.ok) return planned
        nodePlan = planned.value
        return ok(planned.value.actions)
      }),
      refusing((input) => {
        const before = deps.state.profile
        if (!before) return ok([])
        const manager = input.snapshot.managers.service
        const services = manager === "none" ? undefined : { manager: manager as ServiceManagerID, installed: installedServiceUnits(records, manager as ServiceManagerID) }
        const change = planProfileChange(before, input.profile, { allowDowngrade: choices.allowDowngrade === true, ...(services ? { services } : {}) })
        return change.ok ? ok(change.value.actions) : change
      }),
      enrollmentContributor({ ...(choices.server ? { server: choices.server } : {}), machineName: choices.machineName ?? "machine", enrolledWith }),
    ]
    return { sources: { adapters: registry, contributors, ...(choices.enrollment ? { enrollment: choices.enrollment } : {}) }, node: () => nodePlan, history: records }
  }

  function control(snap: DiscoverySnapshot): NodeServiceControl | undefined {
    if (snap.managers.service === "none") return undefined
    let run = ports.serviceRunner
    if (!run) {
      const systemctl = which(deps.probe, [...pathDirs(deps.probe), "/usr/bin", "/bin"], "systemctl") ?? "/usr/bin/systemctl"
      run = spawnManagerRunner({ programs: { launchctl: "/bin/launchctl", systemctl }, env: deps.env })
    }
    return createServiceControl({ run, uid: ports.uid ?? deps.probe.uid, unitPath: unitPathResolver(snap.roots, executionContextOf(snap)) })
  }

  function hubctlSource(): HubctlSource | undefined {
    const manifest = deps.manifest
    if (!manifest) return undefined
    return {
      manifest,
      fetch: async () => {
        const bytes = ports.hubctlBytes?.() ?? (deps.layout.kind === "standalone" ? new Uint8Array(fs.readFile(deps.layout.executable)) : undefined)
        if (!bytes) throw new Error("this hubctl is not the standalone release binary; run the hubctl you downloaded from the release to install it")
        return bytes
      },
      ...(floors.hubctl ? { floor: floors.hubctl } : {}),
    }
  }

  function enrollExecutor(): ActionExecutor<"enroll-machine"> {
    const ref: PathRef = { root: "config", rel: "hub/config.json" }
    return {
      kind: "enroll-machine",
      plan: () => ({ class: "credential", path: ref }),
      check: async (_action, ctx) =>
        ctx.target === deps.store.location ? txOk(undefined) : txFail("usage", `the machine credential lives in ${deps.store.location} (HUB_SPOKE_CONFIG); enroll it separately with hubctl machine enroll`),
      change: async (action) =>
        txOk({
          type: "effect",
          perform: async () => {
            const r = await machineEnroll({
              server: action.server,
              machineName: action.machineName,
              store: deps.store,
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
              onPrompt: (p: EnrollPrompt) => deps.stderr(enrollPromptText(p)),
            })
            return r.envelope.ok ? txOk(undefined) : txFail(r.envelope.error!.code, r.envelope.error!.message)
          },
        }),
      undo: async () => {
        try {
          await deps.store.clear()
          return txOk(undefined)
        } catch (error) {
          return txFail("internal", (error as Error).message)
        }
      },
    }
  }

  const verifyRuntime: ActionExecutor<"verify-runtime"> = {
    kind: "verify-runtime",
    plan: () => ({ class: "external" }),
    change: async () =>
      txOk({
        type: "effect",
        perform: async () => {
          const report = await checkOpenShell({ env: deps.env as Record<string, string | undefined>, home: deps.home })
          return report.ok ? txOk(undefined) : txFail("harness_not_ready", "OpenShell is not ready (`hubctl node openshell check` shows why)")
        },
      }),
  }

  function executors(bundle: PlanBundle, snap: DiscoverySnapshot, consent: ApplyChoices): ExecutorMap {
    const allowDowngrade = consent.allowDowngrade === true
    const gate = (h: HarnessID) => ({ requireReady: consent.requireReady === true || (consent.strict ?? []).includes(h), ...(consent.onReadiness ? { onReadiness: consent.onReadiness } : {}) })
    const { opencode, claude, codex, sources } = adapters(installedHarnesses(bundle.history), allowDowngrade)
    const services = control(snap)
    const hubctl = hubctlSource()
    const builtin = builtinExecutors({
      // Lazy: the node plan exists once apply's re-plan ran the contributor; only its exact units are written.
      renderService: (action) => {
        const node = bundle.node()
        return node ? serviceAssets(node).renderService(action) : undefined
      },
      ...(services ? { services } : {}),
      ...(hubctl ? { hubctl } : {}),
      ...(deps.manifest ? { harness: dispatchHarnessSource({ manifest: deps.manifest, sources, allowDowngrade }) } : {}),
    })
    const oc = opencode.executors(context, gate("opencode"))
    const launchProbe = ports.launchDriver ? { driver: ports.launchDriver, ...(deps.signal ? { signal: deps.signal } : {}), onReport: (r: LaunchReport) => deps.stderr(launchReportText(r)) } : undefined
    return {
      ...builtin,
      ...nodeServiceExecutors({ ...(services ? { control: services } : {}), ...(launchProbe ? { probe: launchProbe } : {}) }),
      "register-mcp-server": dispatchByHarness("register-mcp-server", { opencode: oc["register-mcp-server"]! }),
      "verify-harness": dispatchByHarness("verify-harness", {
        opencode: oc["verify-harness"]!,
        "claude-code": claudeVerifyExecutor({ verify: () => claude.verify(context()), now: deps.now, ...gate("claude-code") }),
        codex: codexVerifyExecutor({ verify: (ctx) => codex.verify(ctx), context, ...gate("codex") }),
      }),
      "enroll-machine": enrollExecutor(),
      "verify-runtime": verifyRuntime,
    }
  }

  function applier(snap: DiscoverySnapshot, map: ExecutorMap): Applier {
    return createApplier({ roots: snap.roots, context: executionContextOf(snap), host: { fingerprint: snap.host.fingerprint, target: snap.host.target }, executors: map, fs, now: deps.now, keepBackups: true })
  }

  async function verify(harnesses: readonly HarnessID[]): Promise<HarnessVerification[]> {
    const snap = fresh()
    const { opencode, claude, codex } = adapters(snap.ok ? installedHarnesses(history(snap.value)) : {}, false)
    const by: Record<HarnessID, HarnessAdapter> = { opencode: opencode.adapter, "claude-code": claude, codex }
    const out: HarnessVerification[] = []
    for (const id of HARNESS_ORDER) if (harnesses.includes(id)) out.push(await by[id].verify(context()))
    return out
  }

  return { deps, discover: fresh, plan, executors, applier, verify, history, serviceLayout }
}

/** What `machine enroll` (and an inline enrollment) shows while it waits; never a credential. */
export function enrollPromptText(p: EnrollPrompt): string {
  if (p.autoApproved) return "hubctl: the local hub approved this machine by itself\n"
  return `hubctl: approve this machine on the hub: ${p.approveURL}\nhubctl: and check it shows the code ${p.userCode} (it expires at ${new Date(p.expiresAt).toISOString()})\n${p.warning ? `hubctl: warning: ${p.warning}\n` : ""}`
}

export function launchReportText(r: LaunchReport): string {
  return `${r.stages.map((s) => `hubctl: verification launch, ${s.stage}: ${s.ok ? "ok" : "failed"}${s.detail ? ` (${s.detail})` : ""}`).join("\n")}\n`
}
