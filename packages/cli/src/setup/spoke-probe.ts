// spoke-connected readiness (HBS-13 integration item 6): whether the hub sees a harness's spoke of this machine.
// One read-only GET /spoke/presence with the machine credential (src/central/http.ts spokePresence), under the
// enrollment policy: https, or plain http to a loopback hub only (checkServerURL); never across a redirect, never to
// an insecure stored hub, and nothing at all without a stored credential. The answer lists only the harness, the
// evidence level and the features of each connected spoke; details never carry the token.
import type { MachineCredential } from "../bootstrap/contracts/index.ts"
import type { SpokeHello } from "../bootstrap/adapters/claude/verify.ts"
import type { SpokeStatus } from "../bootstrap/adapters/codex/verify.ts"
import type { SpokeProbe } from "../bootstrap/adapters/opencode/verify.ts"
import { checkServerURL } from "../bootstrap/enrollment/policy.ts"

export interface ConnectedSpoke {
  readonly harness: string
  readonly evidence: string
  readonly features: readonly string[]
}

export type Presence = { readonly ok: true; readonly spokes: readonly ConnectedSpoke[] } | { readonly ok: false; readonly detail: string }

export interface PresenceOptions {
  /** The stored machine credential (CredentialStore.read). */
  readonly credential: () => Promise<MachineCredential | undefined>
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const TIMEOUT_MS = 10_000
const word = /^[A-Za-z0-9._-]{1,64}$/

function parse(body: unknown): readonly ConnectedSpoke[] | undefined {
  const spokes = (body as { spokes?: unknown } | null)?.spokes
  if (!Array.isArray(spokes)) return undefined
  const out: ConnectedSpoke[] = []
  for (const s of spokes) {
    const { harness, evidence, features } = (s ?? {}) as Record<string, unknown>
    if (typeof harness !== "string" || !word.test(harness) || typeof evidence !== "string" || !word.test(evidence)) return undefined
    const list = Array.isArray(features) ? features.filter((f): f is string => typeof f === "string" && word.test(f)) : []
    out.push({ harness, evidence, features: list })
  }
  return out
}

/** The hub's answer to "which spokes of this machine are connected?". */
export async function spokePresence(options: PresenceOptions): Promise<Presence> {
  let credential: MachineCredential | undefined
  try {
    credential = await options.credential()
  } catch {
    return { ok: false, detail: "the machine credential store cannot be read" }
  }
  if (!credential) return { ok: false, detail: "this machine is not enrolled (run `hubctl machine enroll`)" }
  const server = checkServerURL(credential.server)
  if (!server) return { ok: false, detail: "the stored hub URL is not https (plain http only on loopback), so the hub was not asked" }
  const signals = [AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${server}/spoke/presence`, { method: "GET", headers: { authorization: `Bearer ${credential.token}` }, redirect: "manual", signal: AbortSignal.any(signals) })
  } catch (cause) {
    return { ok: false, detail: `could not reach ${server} (${(cause as { name?: string })?.name ?? "error"})` }
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) return { ok: false, detail: `${server} rejected the machine credential (revoked or unknown)` }
    if (response.status === 404) return { ok: false, detail: `${server} does not answer spoke presence queries (an older hub)` }
    return { ok: false, detail: `${server} could not answer (HTTP ${response.status})` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, detail: `${server} sent an invalid presence answer` }
  }
  const spokes = parse(body)
  return spokes ? { ok: true, spokes } : { ok: false, detail: `${server} sent an invalid presence answer` }
}

const LABEL: Readonly<Record<string, string>> = { opencode: "OpenCode", "claude-code": "Claude Code", codex: "Codex" }

async function find(options: PresenceOptions, harness: string): Promise<{ readonly spoke?: ConnectedSpoke; readonly detail: string }> {
  const p = await spokePresence(options)
  if (!p.ok) return { detail: p.detail }
  const spoke = p.spokes.find((s) => s.harness === harness)
  return spoke ? { spoke, detail: `the hub sees this machine's ${LABEL[harness]} spoke (${spoke.evidence})` } : { detail: `the hub does not see this machine's ${LABEL[harness]} spoke connected` }
}

/** OpenCode's SpokeProbe. */
export function opencodeSpokeProbe(options: PresenceOptions): SpokeProbe {
  return {
    async connected() {
      const r = await find(options, "opencode")
      return { ok: r.spoke !== undefined, detail: r.detail }
    },
  }
}

/** The Claude Code adapter's spoke and conformance probes: the hooks spoke must be connected as a hooks spoke. */
export function claudeSpokeProbes(options: PresenceOptions): { spoke(): Promise<SpokeHello>; conformance(): Promise<{ readonly ok: boolean; readonly detail?: string }> } {
  return {
    async spoke() {
      const r = await find(options, "claude-code")
      return r.spoke ? { connected: true, harness: r.spoke.harness, evidence: r.spoke.evidence, features: r.spoke.features } : { connected: false }
    },
    async conformance() {
      const r = await find(options, "claude-code")
      if (!r.spoke) return { ok: false, detail: r.detail }
      return r.spoke.evidence === "hooks" ? { ok: true, detail: "connected as a hooks spoke" } : { ok: false, detail: `the Claude Code spoke reports ${r.spoke.evidence} evidence, not hooks` }
    },
  }
}

/** The Codex adapter's SpokeStatus. */
export function codexSpokeStatus(options: PresenceOptions): SpokeStatus {
  return {
    async codex() {
      const r = await find(options, "codex")
      return { connected: r.spoke !== undefined, detail: r.detail }
    },
  }
}
