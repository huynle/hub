// Harness presets (design §1.2, preset tier): data-only descriptions of a harness the hub drives through a terminal
// pane (Herdr/tmux) when it has no spoke of its own. A preset is data, never code: an argv list (no shell syntax,
// nothing is run through a shell), an optional resume flag, where the harness's native session ID comes from, and
// fixed delivery "paste" (messages are pasted into the pane, so a deliver is at most "queued") and evidence "screen"
// (activity is sampled from the screen, which never counts as idle). Unknown fields are refused, so a typo or a field
// from a newer schema is an error rather than silently ignored. The built-in harness names are reserved.
//
// Imports only from wire.ts: index.ts re-exports this module.

import { isObj, nonEmpty, token, UNSAFE_CHARS } from "./wire.ts"

/** Harnesses with their own spokes; a preset may not take their names. */
export const RESERVED_HARNESS_NAMES = ["opencode", "claude-code", "codex"] as const

/**
 * Where a preset's native session ID comes from: nowhere (it cannot resume), a flag the hub passes a fresh ID with
 * when it starts the harness (e.g. `--session-id <id>`), or the first capture group of a pattern on the screen.
 */
export type PresetNativeID =
  | { readonly source: "none" }
  | { readonly source: "argv"; readonly flag: string }
  | { readonly source: "screen"; readonly pattern: string }

export interface HarnessPreset {
  /** The harness id (a lowercase token, as a hello's `harness`), not one of RESERVED_HARNESS_NAMES. */
  readonly name: string
  readonly description?: string
  /** The argv that starts the harness: the program, then its arguments. Never run through a shell. */
  readonly command: readonly string[]
  /** The flag that resumes a session: the hub appends it and the native ID (`[...command, resumeFlag, id]`). */
  readonly resumeFlag?: string
  readonly nativeID: PresetNativeID
  readonly delivery: "paste"
  readonly evidence: "screen"
}

export const PRESET_FIELDS = ["name", "description", "command", "resumeFlag", "nativeID", "delivery", "evidence"] as const

export const PRESET_DESCRIPTION_MAX = 300
export const PRESET_ARGS_MAX = 64
export const PRESET_ARG_MAX = 1000
export const PRESET_PATTERN_MAX = 500
export const PRESET_FLAG_MAX = 100

/** Characters that mean shell syntax (substitution, chaining, redirection, quoting, escapes). */
const SHELL_SYNTAX = /[`$;|&<>\\'"]/
const FLAG = new RegExp(`^--?[A-Za-z0-9][A-Za-z0-9-]{0,${PRESET_FLAG_MAX - 3}}$`)
const isFlag = (v: unknown): v is string => typeof v === "string" && FLAG.test(v)

/** Why an argv element is not acceptable, or undefined. */
function argProblem(v: unknown, i: number): string | undefined {
  const label = `command[${i}]`
  if (!nonEmpty(v) || v.length > PRESET_ARG_MAX) return `${label} must be 1–${PRESET_ARG_MAX} characters`
  if (UNSAFE_CHARS.test(v)) return `${label} must not contain control characters or line breaks`
  if (SHELL_SYNTAX.test(v)) return `${label} must not contain shell syntax (\` $ ; | & < > \\ ' "): command is an argv list, never run through a shell`
  if (v.startsWith("~")) return `${label} must not start with ~ (no shell expansion)`
  if (i === 0 && /\s/.test(v)) return "command[0] is the program alone: put its arguments in the next items"
  if (i === 0 && v.startsWith("-")) return "command[0] must be the program, not a flag"
  return undefined
}

/** The number of capture groups in `pattern`, or undefined when it does not compile. */
function captureGroups(pattern: string): number | undefined {
  try {
    return new RegExp(`${pattern}|`).exec("")!.length - 1
  } catch {
    return undefined
  }
}

function nativeIDProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "nativeID must be {source: none | argv | screen, …}"
  const allowed: Record<string, readonly string[]> = { none: ["source"], argv: ["source", "flag"], screen: ["source", "pattern"] }
  const keys = typeof v.source === "string" ? allowed[v.source] : undefined
  if (!keys) return "nativeID.source must be none, argv or screen"
  const unknown = Object.keys(v).find((k) => !keys.includes(k))
  if (unknown) return `nativeID.${unknown} is not a field of a ${v.source} nativeID`
  if (v.source === "argv" && !isFlag(v.flag)) return "nativeID.flag must be one flag, e.g. --session-id"
  if (v.source === "screen") {
    if (!nonEmpty(v.pattern) || v.pattern.length > PRESET_PATTERN_MAX) return `nativeID.pattern must be 1–${PRESET_PATTERN_MAX} characters`
    const groups = captureGroups(v.pattern)
    if (groups === undefined) return "nativeID.pattern must be a valid regular expression"
    if (groups < 1) return "nativeID.pattern must capture the ID in a group"
  }
  return undefined
}

/** Why `v` is not an acceptable harness preset, or undefined when it is. */
export function presetProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "a preset must be an object"
  const unknown = Object.keys(v).find((k) => !(PRESET_FIELDS as readonly string[]).includes(k))
  if (unknown) return `${unknown} is not a preset field (fields: ${PRESET_FIELDS.join(", ")})`
  if (!token(v.name, 64)) return "name must be a lowercase token of 1–64 letters, digits and . _ -"
  if ((RESERVED_HARNESS_NAMES as readonly string[]).includes(v.name)) return `name ${v.name} is reserved for a built-in harness`
  if (v.description !== undefined && (typeof v.description !== "string" || v.description.length > PRESET_DESCRIPTION_MAX || UNSAFE_CHARS.test(v.description))) {
    return `description must be at most ${PRESET_DESCRIPTION_MAX} printable characters`
  }
  if (!Array.isArray(v.command) || v.command.length === 0 || v.command.length > PRESET_ARGS_MAX) return `command must be a list of 1–${PRESET_ARGS_MAX} arguments (argv), not a string`
  for (const [i, arg] of v.command.entries()) {
    const problem = argProblem(arg, i)
    if (problem) return problem
  }
  const native = nativeIDProblem(v.nativeID)
  if (native) return native
  if (v.resumeFlag !== undefined) {
    if (!isFlag(v.resumeFlag)) return "resumeFlag must be one flag, e.g. --resume"
    if ((v.nativeID as PresetNativeID).source === "none") return "resumeFlag needs a nativeID source (argv or screen) to resume by"
  }
  if (v.delivery !== "paste") return "delivery must be paste"
  if (v.evidence !== "screen") return "evidence must be screen"
  return undefined
}

/** Whether `v` is an acceptable harness preset (see presetProblem). */
export const isHarnessPreset = (v: unknown): v is HarnessPreset => presetProblem(v) === undefined

/** The preset schema as JSON Schema (draft 2020-12), for packs validated outside TypeScript. */
export const PRESET_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Hub harness preset",
  type: "object",
  additionalProperties: false,
  required: ["name", "command", "nativeID", "delivery", "evidence"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$", maxLength: 64, not: { enum: [...RESERVED_HARNESS_NAMES] } },
    description: { type: "string", maxLength: PRESET_DESCRIPTION_MAX },
    command: {
      type: "array",
      minItems: 1,
      maxItems: PRESET_ARGS_MAX,
      items: { type: "string", minLength: 1, maxLength: PRESET_ARG_MAX, pattern: "^[^`$;|&<>\\\\'\"~][^`$;|&<>\\\\'\"]*$" },
    },
    resumeFlag: { type: "string", pattern: FLAG.source },
    nativeID: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["source"], properties: { source: { const: "none" } } },
        { type: "object", additionalProperties: false, required: ["source", "flag"], properties: { source: { const: "argv" }, flag: { type: "string", pattern: FLAG.source } } },
        { type: "object", additionalProperties: false, required: ["source", "pattern"], properties: { source: { const: "screen" }, pattern: { type: "string", minLength: 1, maxLength: PRESET_PATTERN_MAX } } },
      ],
    },
    delivery: { const: "paste" },
    evidence: { const: "screen" },
  },
} as const
