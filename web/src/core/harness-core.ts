// Console controls by harness features and evidence (P7-T10, decision fx04e42c). The catalog lists each process's
// harness, evidence level and features (core ops plus optional ones). An OpenCode session keeps every control as
// before; another harness's session shows only the controls its spoke announced, an evidence badge, and delivery
// labels that never claim more than the spoke can confirm (hooks and screen spokes deliver at most "queued").

export type Evidence = "native" | "hooks" | "rpc" | "screen" | "unknown"
const EVIDENCE: readonly Evidence[] = ["native", "hooks", "rpc", "screen"]

/** What the console reads of a catalog process (older hubs send none of these: an OpenCode process). */
export interface HarnessProcessLike {
  readonly harness?: string
  readonly evidence?: string
  readonly features?: readonly string[]
}

export interface SessionControls {
  /** An OpenCode session: every control as before, no badge. */
  readonly native: boolean
  readonly harness: string
  readonly harnessName: string
  readonly evidence: Evidence
  readonly turn: boolean
  readonly steer: boolean
  readonly interrupt: boolean
  readonly stop: boolean
  readonly permission: boolean
  readonly form: boolean
  /** The model chips and picker. */
  readonly models: boolean
  /** The stored transcript (history pages). */
  readonly timeline: boolean
  /** The details rail's summary (branch, changes, context). */
  readonly summary: boolean
  /** Voice mode (conversation mode plus steered utterances). */
  readonly voice: boolean
  /** Prompts reach the harness later (next hook, a terminal paste): labels say queued, never steered or delivered. */
  readonly queued: boolean
}

const HARNESS_NAMES: Record<string, string> = { opencode: "OpenCode", "claude-code": "Claude Code", codex: "Codex" }
export const harnessName = (harness: string): string => HARNESS_NAMES[harness] ?? harness

/** The controls a session's reporting process allows. */
export function sessionControls(process?: HarnessProcessLike): SessionControls {
  const harness = process?.harness || "opencode"
  if (harness === "opencode") {
    return { native: true, harness, harnessName: "OpenCode", evidence: "native", turn: true, steer: true, interrupt: true, stop: true, permission: true, form: true, models: true, timeline: true, summary: true, voice: true, queued: false }
  }
  const evidence = (EVIDENCE as readonly string[]).includes(process?.evidence ?? "") ? (process!.evidence as Evidence) : "unknown"
  // An older hub lists no features: leave the controls on (its 409 unsupported answer says what is not served).
  const listed = process?.features ? new Set(process.features) : undefined
  const has = (feature: string) => !listed || listed.has(feature)
  return {
    native: false,
    harness,
    harnessName: harnessName(harness),
    evidence,
    turn: has("turn"),
    steer: has("steer"),
    interrupt: has("interrupt"),
    stop: has("stop"),
    permission: has("permission"),
    form: has("form"),
    models: has("models"),
    timeline: has("timeline"),
    summary: has("summary"),
    voice: has("conversation") && has("steer"),
    queued: evidence === "hooks" || evidence === "screen" || evidence === "unknown",
  }
}

export interface EvidenceBadge {
  readonly level: Evidence
  readonly label: string
  readonly detail: string
}

const BADGE: Record<Evidence, { label: string; detail: (name: string) => string }> = {
  native: { label: "Native", detail: (name) => `The hub sees ${name}'s own events: status and turns are confirmed by the harness.` },
  hooks: { label: "Hooks", detail: (name) => `The hub follows ${name} through its lifecycle hooks: status updates at hook points, and prompts are queued until its next hook.` },
  rpc: { label: "RPC", detail: (name) => `The hub drives ${name} through its RPC API: prompts and turns are confirmed by the harness.` },
  screen: { label: "Screen", detail: (name) => `The hub reads ${name}'s terminal screen: status is a guess that never counts as idle, and prompts are pasted in (at most queued).` },
  unknown: { label: "Unknown", detail: (name) => `The ${name} spoke declared no evidence level: the session never counts as idle and prompts are at most queued.` },
}

/** The evidence badge of a non-OpenCode session (none for OpenCode). */
export function evidenceBadge(controls: SessionControls): EvidenceBadge | undefined {
  if (controls.native) return undefined
  const badge = BADGE[controls.evidence]
  return { level: controls.evidence, label: badge.label, detail: badge.detail(controls.harnessName) }
}

export interface PromptGate {
  /** Whether the prompt box shows at all. */
  readonly show: boolean
  /** Whether typed input can be sent now (idle → turn, running → steer). */
  readonly allowed: boolean
  readonly hint?: string
}

/** Whether the composer shows and may send, given the tree runs (a Send steers) or is idle (a Send starts a turn). */
export function promptGate(controls: SessionControls, running: boolean): PromptGate {
  if (controls.turn && controls.steer) return { show: true, allowed: true }
  if (!controls.turn && !controls.steer) return { show: false, allowed: false, hint: `This ${controls.harnessName} session takes no prompts from the hub; type in its terminal.` }
  if (running && !controls.steer) return { show: true, allowed: false, hint: `${controls.harnessName} can't take input while it runs here; send once the session is idle.` }
  if (!running && !controls.turn) return { show: true, allowed: false, hint: `${controls.harnessName} takes input here only while the session runs.` }
  return { show: true, allowed: true }
}

export type DeliveryTick = "sent" | "queued" | "heard"

/** The tick and toast of a typed prompt the hub took (turnAnswer): queued delivery never claims steered or sent. */
export function deliveryNote(controls: SessionControls, answer: "steered" | "accepted" | "result"): { tick: DeliveryTick; toast?: string } {
  if (answer === "result") return { tick: "heard" }
  if (controls.queued) return answer === "steered" ? { tick: "queued", toast: `Queued: ${controls.harnessName} picks it up at its next step` } : { tick: "queued" }
  return answer === "steered" ? { tick: "sent", toast: "Steered the running session" } : { tick: "sent" }
}

const UNDELIVERED: Record<string, string> = { queued: "queued", retained: "held", pending: "pending" }

/** A hub message row's delivery label: only when it is not (yet) delivered into a turn. */
export function messageDeliveryLabel(delivery: unknown): string | undefined {
  return typeof delivery === "string" ? UNDELIVERED[delivery] : undefined
}

/** The notice for the hub's 409 code "unsupported" (the session's spoke does not serve that op); else undefined. */
export function unsupportedNotice(error: unknown): string | undefined {
  const e = error as { status?: unknown; code?: unknown; message?: unknown } | undefined
  if (!e || e.status !== 409 || e.code !== "unsupported") return undefined
  const message = typeof e.message === "string" ? e.message.trim().replace(/\.$/, "") : ""
  return message ? `Not available for this session: ${message[0]!.toLowerCase()}${message.slice(1)}. Use its terminal.` : "Not available for this session. Use its terminal."
}
