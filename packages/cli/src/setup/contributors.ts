// The plan contributors the CLI adds beside the harness adapters and the node services (preview/plan.ts
// PlanContributor): pure, deterministic functions of (snapshot, profile) and what they were built with, so preview and
// apply plan the same digest.
//
//   hubctlContributor      the standalone hubctl this verified manifest pins for the host's exact target, into
//                          user-bin:hubctl (the stable authority services and MCP clients run), and the `hub` alias
//                          next to it (one command surface; the name grants nothing).
//   enrollmentContributor  inline enrollment: one enroll-machine for the hub the user named, only while this machine
//                          is not enrolled with it (the device code is approved by a person on the hub).
//   refusing               a contributor that can refuse: planSetup has no refusal channel for contributors, so a
//                          Result failure is thrown as a typed PlanRefusal the CLI catches and maps with exitFor.
import { ERROR_CODES, harnessCurrentRef, HARNESS_ORDER, selectArtifact, type Action, type ErrorCode, type HarnessID, type Issue, type PathRef, type PlanInput, type Result, type VerifiedManifest } from "../bootstrap/contracts/index.ts"
import type { PlanContributor } from "../bootstrap/preview/plan.ts"

export const HUBCTL_REF = { root: "user-bin", rel: "hubctl" } as const
export const HUB_ALIAS_REF = { root: "user-bin", rel: "hub" } as const

/** A plan that cannot be made, with the envelope error code it maps to. */
export class PlanRefusal extends Error {
  override readonly name = "PlanRefusal"
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The envelope code for a planner issue: the issue code when it is one, else `invalid`. */
export const errorCodeOf = (code: string): ErrorCode => ((ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : "invalid")

export const issuesText = (issues: readonly Issue[]): string => issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")

/** A contributor from a planner that returns a Result: a refusal is thrown as a PlanRefusal. */
export function refusing(plan: (input: PlanInput) => Result<readonly Action[]>): PlanContributor {
  return (input) => {
    const r = plan(input)
    if (!r.ok) throw new PlanRefusal(errorCodeOf(r.issues[0]!.code), issuesText(r.issues))
    return r.value
  }
}

/**
 * What is installed now (read-only): a file's digest (undefined when there is no regular file) and whether a path is
 * a symlink to a target. The CLI reads the files the plan would write; tests inject fakes.
 */
export interface InstalledInspector {
  sha256(ref: PathRef): string | undefined
  linksTo(ref: PathRef, target: PathRef): boolean
}

/**
 * The pinned hubctl and its `hub` alias, each only when not already in place: an installed hubctl with the pinned
 * artifact's digest is that artifact, whichever path the hubctl that plans runs from (HBS-12 E3: a converged host
 * plans no install and no link).
 */
export function hubctlContributor(options: { readonly manifest?: VerifiedManifest; readonly installed?: InstalledInspector }): PlanContributor {
  return ({ snapshot }) => {
    const manifest = options.manifest
    if (!manifest) return []
    const artifact = selectArtifact(manifest, snapshot.host.target)
    if (!artifact.ok) return []
    const installed = options.installed
    const actions: Action[] = []
    if (installed?.sha256(HUBCTL_REF) !== artifact.value.sha256)
      actions.push({
        id: "install-hubctl",
        kind: "install-artifact",
        escalation: "user",
        summary: `Install hubctl ${manifest.release} for ${snapshot.host.target} as ~/.local/bin/hubctl (pinned by the signed release manifest)`,
        artifact: "hubctl",
        version: manifest.release,
        target: snapshot.host.target,
        sha256: artifact.value.sha256,
        path: { ...HUBCTL_REF },
      })
    if (!installed?.linksTo(HUB_ALIAS_REF, HUBCTL_REF))
      actions.push({ id: "link-hub", kind: "link-executable", escalation: "user", summary: "Link hub to hubctl (the same command surface)", path: { ...HUB_ALIAS_REF }, target: { ...HUBCTL_REF } })
    return actions
  }
}

/** Read-only facts about paths a plan would link, and the user's PATH (the CLI reads them through the probe). */
export interface PathInspector {
  /** What is at `ref` now, not following a final symlink. */
  entry(ref: PathRef): "missing" | "file" | "directory" | "symlink" | "other"
  /** The absolute path a symlink at `ref` points to (resolved against its directory); undefined for anything else. */
  linkTarget(ref: PathRef): string | undefined
  /** The absolute path of `ref` on this host. */
  where(ref: PathRef): string | undefined
  /** The first `name` on the user's PATH, as found (not followed). */
  onPath(name: string): string | undefined
}

/** Each harness's executable: its command name, and where it is inside an install root (the adapters' unpackers). */
export const HARNESS_EXECUTABLES: Readonly<Record<HarnessID, { readonly name: string; readonly rel: string; readonly label: string }>> = Object.freeze({
  opencode: { name: "opencode", rel: "bin/opencode", label: "OpenCode" },
  "claude-code": { name: "claude", rel: "claude", label: "Claude Code" },
  codex: { name: "codex", rel: "bin/codex", label: "Codex" },
})

/**
 * Contract amendment A6 (HBS-12 E4): a hub-installed harness goes on PATH through a typed link in user-bin
 * (`~/.local/bin/opencode` → `data:hub/harnesses/opencode/current/bin/opencode`), journaled and rolled back like any
 * link. Only for a harness hub makes current (this plan selects it, or its `current` is already there), and only when
 * nothing else of that name is on PATH and user-bin holds nothing of that name but a link of hub's own (one into
 * hub's harness directory): a user's binary is never shadowed or replaced.
 */
export function harnessLinkContributor(inspector: PathInspector): PlanContributor {
  return ({ profile, planned = [] }) => {
    const actions: Action[] = []
    for (const harness of HARNESS_ORDER) {
      if (!profile.harnesses.includes(harness)) continue
      const exe = HARNESS_EXECUTABLES[harness]
      const current = harnessCurrentRef(harness)
      const target: PathRef = { root: current.root, rel: `${current.rel}/${exe.rel}` }
      const selected = planned.some((a) => a.kind === "select-harness-version" && a.harness === harness)
      if (!selected && inspector.entry(target) !== "file") continue
      const link: PathRef = { root: "user-bin", rel: exe.name }
      const linkPath = inspector.where(link)
      const targetPath = inspector.where(target)
      const ownDir = inspector.where({ root: current.root, rel: `hub/harnesses/${harness}` })
      if (!linkPath || !targetPath || !ownDir) continue
      const there = inspector.entry(link)
      const pointsTo = inspector.linkTarget(link)
      if (there === "symlink" && pointsTo === targetPath) continue
      const hubOwned = there === "symlink" && pointsTo !== undefined && pointsTo.startsWith(`${ownDir}/`)
      if (there !== "missing" && !hubOwned) continue
      const found = inspector.onPath(exe.name)
      if (found !== undefined && found !== linkPath) continue
      actions.push({
        id: `link-${harness}`,
        kind: "link-executable",
        escalation: "user",
        summary: `Put the hub-installed ${exe.label} on PATH: link ~/.local/bin/${exe.name} to its current version`,
        path: link,
        target,
      })
    }
    return actions
  }
}

export interface EnrollmentChoices {
  /** The hub to enroll with (inline enrollment); without it the plan does not enroll. */
  readonly server?: string
  readonly machineName: string
  /** The hub this machine is enrolled with now, if any (read from the credential store before planning). */
  readonly enrolledWith: string | undefined
}

export function enrollmentContributor(choices: EnrollmentChoices): PlanContributor {
  return () => {
    if (!choices.server || choices.enrolledWith === choices.server) return []
    return [
      {
        id: "enroll-machine",
        kind: "enroll-machine",
        escalation: "user",
        summary: `Enroll this machine with ${choices.server} (device code; you approve it on the hub)`,
        server: choices.server,
        machineName: choices.machineName,
      },
    ]
  }
}
