// Check "hello": the spoke's first frame on a connection. It must be a hello the hub parses, with a harness id the
// hub accepts, an evidence level it knows (a non-OpenCode hello), only known features (each once), opencodeVersion
// as the protocol requires it (OpenCode: non-empty; others: optional text, "" recommended for older hubs), the
// machine token as the WebSocket's bearer, and the harness, evidence and features the driver describes.
import { EVIDENCE_LEVELS, HARNESS_OPENCODE, KNOWN_SPOKE_FEATURES, parseSpokeMessage } from "../../protocol/src/index.ts"
import type { DriverInfo } from "../../testkit/src/index.ts"

export interface HelloInput {
  /** The first frame's text. */
  readonly raw: string
  /** The Authorization header of the WebSocket upgrade (null when absent). */
  readonly auth: string | null
  readonly machineToken: string
  /** What the driver said the spoke announces (absent when the driver cannot describe it). */
  readonly describe?: DriverInfo
}

const HARNESS = /^[a-z0-9][a-z0-9._-]*$/
const KNOWN: readonly string[] = KNOWN_SPOKE_FEATURES
const EVIDENCE: readonly string[] = EVIDENCE_LEVELS

export function helloProblems(input: HelloInput): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  let hello: Record<string, unknown>
  try {
    const value = JSON.parse(input.raw)
    if (!value || typeof value !== "object" || Array.isArray(value) || value.t !== "hello") return { problems: ["the first frame is not a hello"], notes }
    hello = value
  } catch {
    return { problems: ["the first frame is not JSON (not a hello)"], notes }
  }
  if (!parseSpokeMessage(input.raw)) problems.push("the hello does not parse as the hub parses it (parseSpokeMessage)")

  const harness = hello.harness
  const openCode = harness === undefined || harness === HARNESS_OPENCODE
  if (harness !== undefined && (typeof harness !== "string" || harness.length > 64 || !HARNESS.test(harness))) {
    problems.push(`harness ${JSON.stringify(harness)} is not a lowercase token of at most 64 characters`)
  }
  if (openCode) {
    if (typeof hello.opencodeVersion !== "string" || hello.opencodeVersion === "") problems.push("an OpenCode hello needs a non-empty opencodeVersion")
  } else {
    if (hello.opencodeVersion === undefined) notes.push('no opencodeVersion: hubs that predate harness hellos refuse it (send "")')
    else if (typeof hello.opencodeVersion !== "string") problems.push("opencodeVersion must be text when sent")
    if (typeof hello.harnessVersion !== "string") problems.push("a harness hello needs a harnessVersion")
    if (!EVIDENCE.includes(hello.evidence as string)) {
      problems.push(hello.evidence === undefined ? "a harness hello needs an evidence level" : `evidence ${JSON.stringify(hello.evidence)} is not one of ${EVIDENCE.join(", ")}`)
    }
  }

  const features = Array.isArray(hello.features) ? (hello.features as unknown[]) : hello.features === undefined ? [] : undefined
  if (!features) problems.push("features must be a list")
  const seen = new Set<unknown>()
  for (const feature of features ?? []) {
    if (!KNOWN.includes(feature as string)) problems.push(`unknown feature ${JSON.stringify(feature)}`)
    if (seen.has(feature)) problems.push(`feature ${JSON.stringify(feature)} is announced twice`)
    seen.add(feature)
  }

  if (input.auth !== `Bearer ${input.machineToken}`) problems.push("the spoke did not connect with the machine token as its bearer (Authorization: Bearer <token>)")

  const info = input.describe
  if (info) {
    const said = openCode ? HARNESS_OPENCODE : harness
    if (info.harness !== said) problems.push(`hello harness ${JSON.stringify(said)} differs from the driver's ${JSON.stringify(info.harness)}`)
    if (!openCode && info.evidence !== hello.evidence) problems.push(`hello evidence ${JSON.stringify(hello.evidence)} differs from the driver's ${JSON.stringify(info.evidence)}`)
    const a = [...seen].map(String).sort()
    const b = [...new Set(info.features)].sort()
    if (a.join() !== b.join()) problems.push(`hello features [${a.join(", ")}] differ from the driver's [${b.join(", ")}]`)
  }
  return { problems, notes }
}
