// The Codex adapter's planner (HarnessAdapter.plan): pure in (snapshot, profile) and the adapter's fixed options.
//
//   install-harness         the artifact hub's verified manifest pins for Codex on this host's exact target, into
//                           its own version directory (harnessVersionRef); evidence: exactly what the pin lists
//                           (sigstore on Linux, none on macOS). No pin for the target: no install is planned (an
//                           unpinned Codex is never installed), only verification.
//   select-harness-version  makes that version current (harnessCurrentRef); a rollback makes the previous current.
//   verify-harness          real probes only: the binary runs (version-exec), its app-server starts and answers
//                           (api-health), its provider account is ready (provider-auth), and the hub sees the Codex
//                           spoke (spoke-connected).
//
// When hub's own install already has the pinned version current, only verification is planned. A Codex the user
// installed another way (brew, npm, Codex's install.sh into ~/.codex/packages) is never touched: hub installs and
// runs its own pinned copy.
//
// ~/.codex is preserved: hub's Codex wiring needs no edit of it (the spoke passes `-c` overrides to the app-server it
// starts, the wrapper passes `--enable daemon_auto_start` per run, and Codex ≥ 0.165 enables that feature by
// default). The one optional edit, `ensureDaemonFeature` (for a user who turned the feature off in config.toml), is
// a TOML merge-config, which the setup planner turns into an unmergeable-format manual edit: hub never writes TOML.
import {
  executionContextOf,
  harnessCurrentRef,
  harnessVersionRef,
  resolvePathRef,
  type Action,
  type DiscoverySnapshot,
  type HarnessPin,
  type PathRef,
  type PlanInput,
  type Precondition,
  type ProbeKind,
  type VerifiedManifest,
} from "../../contracts/index.ts"

/** The probes verify-codex runs; each must pass, fresh, before Codex is advertised as ready. */
export const CODEX_VERIFY_PROBES: readonly Exclude<ProbeKind, "presence">[] = ["version-exec", "api-health", "provider-auth", "spoke-connected"]

/** Codex's config file, as discovery reads it (home:.codex/config.toml). */
export const CODEX_CONFIG_REF: PathRef = { root: "home", rel: ".codex/config.toml" }

export interface CodexPlanOptions {
  /** The verified hub release manifest; its codex pins are the only Codex artifacts ever installed. */
  readonly manifest: VerifiedManifest
  /** The hub-installed version and digest recorded before (profile history); used only if discovery agrees. */
  readonly previous?: { readonly version: string; readonly sha256: string }
  /** Opt-in: ask for `[features] daemon_auto_start = true` in ~/.codex/config.toml (a manual edit). */
  readonly ensureDaemonFeature?: boolean
}

const codexOf = (snapshot: DiscoverySnapshot) => snapshot.harnesses.find((h) => h.id === "codex")

/** The pin for Codex on exactly this target, if the manifest has one. */
export function codexPinFor(manifest: VerifiedManifest, target: string): HarnessPin | undefined {
  return manifest.harnesses.find((h) => h.harness === "codex" && h.target === target)
}

function configPrecondition(snapshot: DiscoverySnapshot): Precondition | undefined {
  const where = resolvePathRef(CODEX_CONFIG_REF, snapshot.roots, executionContextOf(snapshot))
  if (!where.ok) return undefined
  const found = snapshot.configs.find((c) => c.path === where.value)
  return found?.sha256 ? { exists: true, sha256: found.sha256 } : { exists: false }
}

export function planCodex(input: PlanInput, options: CodexPlanOptions): Action[] {
  const { snapshot, profile } = input
  if (!profile.harnesses.includes("codex")) return []
  const actions: Action[] = []
  const pin = codexPinFor(options.manifest, snapshot.host.target)
  const found = codexOf(snapshot)
  const hubVersion = found?.installed && found.installMethod === "hub" ? found.version : undefined
  if (pin && hubVersion !== pin.version) {
    const previous = hubVersion !== undefined && options.previous?.version === hubVersion ? { previous: options.previous } : {}
    actions.push(
      {
        id: "install-codex",
        kind: "install-harness",
        escalation: "user",
        summary: `Install Codex ${pin.version} for ${pin.target} (pinned by hub ${options.manifest.release})`,
        harness: "codex",
        version: pin.version,
        target: pin.target,
        source: { manifest: options.manifest.release, url: pin.url, file: pin.file },
        size: pin.size,
        sha256: pin.sha256,
        evidence: [...pin.evidence],
        path: harnessVersionRef("codex", pin.version),
        owner: "hub",
        rollback: "restore-previous",
        ...previous,
      },
      {
        id: "select-codex",
        kind: "select-harness-version",
        escalation: "user",
        summary: `Make Codex ${pin.version} the current version`,
        harness: "codex",
        version: pin.version,
        path: harnessCurrentRef("codex"),
        target: harnessVersionRef("codex", pin.version),
        ...previous,
      },
    )
  }
  if (options.ensureDaemonFeature) {
    const precondition = configPrecondition(snapshot)
    if (precondition)
      actions.push({
        id: "codex-daemon-feature",
        kind: "merge-config",
        escalation: "user",
        summary: "Turn on Codex's shared app-server daemon (features.daemon_auto_start) so the hub sees TUI threads",
        path: CODEX_CONFIG_REF,
        format: "toml",
        owner: "harness:codex",
        precondition,
        set: [{ pointer: "/features/daemon_auto_start", value: true }],
        preserveUnknown: true,
      })
  }
  actions.push({
    id: "verify-codex",
    kind: "verify-harness",
    escalation: "user",
    summary: "Verify Codex really runs, its app-server answers, its provider account is ready and its spoke reaches the hub",
    harness: "codex",
    probes: [...CODEX_VERIFY_PROBES],
  })
  return actions
}
