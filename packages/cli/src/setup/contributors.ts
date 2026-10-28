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
import { ERROR_CODES, selectArtifact, type Action, type ErrorCode, type Issue, type PlanInput, type Result, type VerifiedManifest } from "../bootstrap/contracts/index.ts"
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

export function hubctlContributor(options: { readonly manifest?: VerifiedManifest }): PlanContributor {
  return ({ snapshot }) => {
    const manifest = options.manifest
    if (!manifest) return []
    const artifact = selectArtifact(manifest, snapshot.host.target)
    if (!artifact.ok) return []
    return [
      {
        id: "install-hubctl",
        kind: "install-artifact",
        escalation: "user",
        summary: `Install hubctl ${manifest.release} for ${snapshot.host.target} as ~/.local/bin/hubctl (pinned by the signed release manifest)`,
        artifact: "hubctl",
        version: manifest.release,
        target: snapshot.host.target,
        sha256: artifact.value.sha256,
        path: { ...HUBCTL_REF },
      },
      { id: "link-hub", kind: "link-executable", escalation: "user", summary: "Link hub to hubctl (the same command surface)", path: { ...HUB_ALIAS_REF }, target: { ...HUBCTL_REF } },
    ]
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
