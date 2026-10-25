// Presets (design §1.2 preset tier): the official ones shipped in presets/ (data only, imported statically so the CLI
// bundle carries them), finding one by name or file, the argv a launch runs and the native ID read off the screen.
// A preset is validated with the protocol's presetProblem before anything uses it; nothing here runs a shell.
import { readFileSync } from "node:fs"
import path from "node:path"
import { presetProblem, type HarnessPreset } from "../../protocol/src/index.ts"
import aider from "../presets/aider.json" with { type: "json" }
import goose from "../presets/goose.json" with { type: "json" }

/** Longest native ID taken from a screen (UTF-8 bytes; spoke-sdk MAX_NATIVE_BYTES, so it maps to a hub ID). */
export const SCREEN_ID_MAX_BYTES = 98

function official(raw: unknown): HarnessPreset {
  const problem = presetProblem(raw)
  if (problem) throw new Error(`Official preset ${JSON.stringify((raw as { name?: unknown })?.name)} is invalid: ${problem}`)
  return raw as HarnessPreset
}

export const OFFICIAL_PRESETS: readonly HarnessPreset[] = [official(aider), official(goose)]

export type FoundPreset = { readonly preset: HarnessPreset; readonly source: "official" | string } | { readonly error: string }

/** Whether `ref` names a file rather than an official preset. */
const isPath = (ref: string) => ref.includes("/") || ref.includes(path.sep) || ref.endsWith(".json")

/** An official preset by name, or a preset file (a ref with a slash or ending in .json, relative to cwd), validated. */
export function findPreset(ref: string, options: { readonly cwd: string }): FoundPreset {
  if (!isPath(ref)) {
    const preset = OFFICIAL_PRESETS.find((p) => p.name === ref)
    if (preset) return { preset, source: "official" }
    return { error: `no official preset ${JSON.stringify(ref)} (official: ${OFFICIAL_PRESETS.map((p) => p.name).join(", ")}; give a file path for your own)` }
  }
  const file = path.resolve(options.cwd, ref)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    return { error: `cannot read ${file}: ${(cause as NodeJS.ErrnoException).code ?? String(cause)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: `${file} is not JSON` }
  }
  const problem = presetProblem(raw)
  return problem ? { error: `${file} is not a valid preset: ${problem}` } : { preset: raw as HarnessPreset, source: file }
}

export interface LaunchArgvOptions {
  /** Extra arguments for the harness (after the preset's own). */
  readonly args?: readonly string[]
  /** Resume this native session ID (needs the preset's resumeFlag). */
  readonly resume?: string
  /** A fresh native ID, for presets whose ID the hub passes on the command line (source argv). */
  readonly newID: () => string
}

/** Control characters (a NUL would cut an argv element short; line breaks have no place in one). */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The argv a launch runs (never through a shell) and the native session ID, when the hub knows it at launch: the one
 * it passes (source argv) or resumes. A screen ID is only known once it shows (nativeIDFromScreen).
 */
export function launchArgv(preset: HarnessPreset, options: LaunchArgvOptions): { argv: string[]; nativeID: string | undefined } {
  const args = [...(options.args ?? [])]
  for (const arg of args) if (CONTROL.test(arg)) throw new Error(`Argument ${JSON.stringify(arg)} contains control characters`)
  if (options.resume !== undefined) {
    if (!preset.resumeFlag) throw new Error(`The ${preset.name} preset cannot resume a session (it has no resumeFlag)`)
    if (options.resume === "" || CONTROL.test(options.resume)) throw new Error("The session ID to resume must be printable text")
    return { argv: [...preset.command, preset.resumeFlag, options.resume, ...args], nativeID: options.resume }
  }
  if (preset.nativeID.source === "argv") {
    const id = options.newID()
    return { argv: [...preset.command, preset.nativeID.flag, id, ...args], nativeID: id }
  }
  return { argv: [...preset.command, ...args], nativeID: undefined }
}

/** The native session ID on `screen` (the first capture group of the preset's pattern), for source screen only. */
export function nativeIDFromScreen(preset: HarnessPreset, screen: string): string | undefined {
  if (preset.nativeID.source !== "screen") return undefined
  const id = new RegExp(preset.nativeID.pattern).exec(screen)?.[1]
  if (!id || Buffer.byteLength(id) > SCREEN_ID_MAX_BYTES || CONTROL.test(id)) return undefined
  return id
}
