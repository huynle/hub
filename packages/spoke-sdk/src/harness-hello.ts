// The hello of a spoke for a harness other than OpenCode (design §1.1, P7-T1): its harness id, version and evidence
// level, and every feature it serves. Unlike an OpenCode hello it implies nothing: each core op (CORE_OPS) the spoke
// serves is announced, and the hub sends only announced ops. Refuses what would mislead the hub instead of sending it.
import { randomBytes } from "node:crypto"
import {
  CORE_OPS,
  EVIDENCE_LEVELS,
  HARNESS_OPENCODE,
  KNOWN_SPOKE_FEATURES,
  type CoreOp,
  type EvidenceLevel,
  type Hello,
  type ProcessKind,
  type SpokeFeature,
  type SpokeMode,
} from "../../protocol/src/index.ts"

export interface HarnessHelloOptions {
  /** The harness id: a lowercase token (letters, digits, `.`, `_`, `-`), not "opencode". */
  readonly harness: string
  readonly harnessVersion: string
  /** How the spoke observes activity; the hub never treats a session as idle on weaker evidence than it claims. */
  readonly evidence: EvidenceLevel
  /** The spoke's own version. */
  readonly pluginVersion: string
  readonly directory: string
  /** The core ops the spoke serves (a hooks spoke may serve "permission" but not "turn"). */
  readonly ops: readonly CoreOp[]
  /** The optional features it serves (e.g. "deliver", "sessionTokens"); never a core op. */
  readonly features?: readonly SpokeFeature[]
  readonly processID?: string
  readonly kind?: ProcessKind
  readonly mode?: SpokeMode
  readonly pid?: number
  readonly launchID?: string
}

/** The hello's harness id rule (as the hub parses it). */
const HARNESS = /^[a-z0-9][a-z0-9._-]*$/
const HARNESS_MAX = 64
const VERSION_MAX = 100
const CORE: readonly string[] = CORE_OPS
const KNOWN: readonly string[] = KNOWN_SPOKE_FEATURES

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** The hello fields (without `t` and `v`, which the connection adds) for a non-OpenCode spoke. Throws on bad options. */
export function buildHarnessHello(options: HarnessHelloOptions): Omit<Hello, "t" | "v"> {
  const { harness, harnessVersion, evidence } = options
  if (harness === HARNESS_OPENCODE) throw new Error("A harness spoke cannot be harness \"opencode\": OpenCode hellos imply every core op; use the OpenCode spoke")
  if (typeof harness !== "string" || harness.length > HARNESS_MAX || !HARNESS.test(harness)) {
    throw new Error(`The harness id must be 1–${HARNESS_MAX} lowercase letters, digits, ".", "_" or "-" (got ${JSON.stringify(harness)})`)
  }
  if (typeof harnessVersion !== "string" || harnessVersion.length > VERSION_MAX) throw new Error(`The harness version must be text of at most ${VERSION_MAX} characters`)
  if (!(EVIDENCE_LEVELS as readonly string[]).includes(evidence)) throw new Error(`The evidence level must be one of ${EVIDENCE_LEVELS.join(", ")} (got ${JSON.stringify(evidence)})`)
  for (const op of options.ops) if (!CORE.includes(op)) throw new Error(`Unknown core op ${JSON.stringify(op)} (core ops: ${CORE_OPS.join(", ")})`)
  const features = unique(options.features ?? [])
  for (const feature of features) {
    if (CORE.includes(feature)) throw new Error(`"${feature}" is a core op: list it in ops, not features`)
    if (!KNOWN.includes(feature)) throw new Error(`Unknown spoke feature ${JSON.stringify(feature)}`)
  }
  if (features.includes("hubPrompt") && !features.includes("deliver")) throw new Error("The hubPrompt feature needs the deliver feature")
  const ops = CORE_OPS.filter((op) => options.ops.includes(op))
  return {
    processID: options.processID ?? `${harness.replace(/[^A-Za-z0-9_-]/g, "_")}_${randomBytes(8).toString("hex")}`,
    kind: options.kind ?? "service",
    directory: options.directory,
    pid: options.pid ?? process.pid,
    mode: options.mode ?? "always",
    // Hubs that predate `harness` require opencodeVersion from every spoke (protocol Hello).
    opencodeVersion: "",
    pluginVersion: options.pluginVersion,
    features: [...ops, ...features],
    harness,
    harnessVersion,
    evidence,
    ...(options.launchID !== undefined ? { launchID: options.launchID } : {}),
  }
}
