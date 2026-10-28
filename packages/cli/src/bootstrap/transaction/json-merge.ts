// Lossless config merging for merge-config. Only the listed JSON pointers change; every other key, known or not,
// is carried through with its value and its position. The file is re-serialized with its own indentation and
// trailing newline, and returned byte for byte when nothing changes. Anything a parse → serialize round trip could
// not carry exactly is refused rather than silently dropped: comments (JSONC with comments), duplicate keys,
// integers beyond 2^53, TOML, or a document that is not an object.
import { canonicalJSON, type ConfigFormat, type ConfigSet, type Json } from "../contracts/index.ts"
import { txFail, txOk, type TxResult } from "./result.ts"

type Node = null | boolean | number | string | Node[] | { [key: string]: Node }

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Merges `sets` into the config text (undefined: the file does not exist yet). */
export function mergeConfigText(text: string | undefined, format: ConfigFormat, sets: readonly ConfigSet[]): TxResult<string> {
  if (format === "toml") return txFail("conflict", "TOML configs cannot be merged losslessly by this hubctl; make the edit by hand")
  let root: Node
  if (text === undefined) root = {}
  else {
    const lossy = losslessProblem(text)
    if (lossy) return txFail("conflict", `the config cannot be merged losslessly (${lossy}); make the edit by hand`)
    root = JSON.parse(text) as Node
  }
  if (!isObject(root)) return txFail("conflict", "the config is not a JSON object")
  let changed = false
  for (const set of sets) {
    const r = applySet(root, set)
    if (!r.ok) return r
    changed ||= r.value
  }
  if (text !== undefined && !changed) return txOk(text)
  return txOk(serialize(root, text))
}

const isObject = (v: unknown): v is { [key: string]: Node } => typeof v === "object" && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b)
const clone = (v: Json): Node => JSON.parse(JSON.stringify(v)) as Node

function segments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
}

/** Applies one set; ok(true) when the document changed. */
function applySet(root: Node, set: ConfigSet): TxResult<boolean> {
  if (!set.pointer.startsWith("/")) return txFail("invalid", `${set.pointer} is not a JSON pointer`)
  const segs = segments(set.pointer)
  if (segs.some((s) => FORBIDDEN_KEYS.has(s))) return txFail("invalid", `${set.pointer} names a prototype key`)
  let current: Node = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    let next: Node | undefined
    if (Array.isArray(current)) {
      const index = arrayIndex(seg, current.length - 1)
      if (index === undefined) return txFail("conflict", `${set.pointer}: no array element ${seg}`)
      next = current[index]
    } else if (isObject(current)) {
      next = Object.hasOwn(current, seg) ? current[seg] : undefined
      if (next === undefined) {
        next = {}
        current[seg] = next
      }
    }
    if (typeof next !== "object" || next === null) return txFail("conflict", `${set.pointer}: ${segs.slice(0, i + 1).join("/")} is not an object or array`)
    current = next
  }
  const last = segs[segs.length - 1]!
  const value = clone(set.value)
  if (Array.isArray(current)) {
    if (last === "-") {
      if (current.some((item) => same(item, value))) return txOk(false)
      current.push(value)
      return txOk(true)
    }
    const index = arrayIndex(last, current.length)
    if (index === undefined) return txFail("conflict", `${set.pointer}: index ${last} is out of range`)
    if (index < current.length && same(current[index], value)) return txOk(false)
    current[index] = value
    return txOk(true)
  }
  if (!isObject(current)) return txFail("conflict", `${set.pointer}: the parent is not an object or array`)
  if (Object.hasOwn(current, last) && same(current[last], value)) return txOk(false)
  current[last] = value
  return txOk(true)
}

function arrayIndex(seg: string, max: number): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(seg)) return undefined
  const n = Number(seg)
  return n <= max ? n : undefined
}

function serialize(root: Node, original: string | undefined): string {
  const trailing = original === undefined || original.endsWith("\n") ? "\n" : ""
  if (original !== undefined && !original.includes("\n")) return JSON.stringify(root) + trailing
  const indent = original === undefined ? "  " : (/\n([ \t]+)\S/.exec(original)?.[1] ?? "  ")
  return JSON.stringify(root, null, indent) + trailing
}

/**
 * Why a JSON.parse → JSON.stringify round trip would lose something, or undefined when it would not. A small
 * scanner over the text: invalid JSON (including comments), duplicate keys in one object, unsafe integers.
 */
function losslessProblem(text: string): string | undefined {
  let i = 0
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++
  }
  const fail = (why: string): never => {
    throw new Error(why)
  }
  const str = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    if (i >= text.length) fail("unterminated string")
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (depth: number): void => {
    if (depth > 512) fail("nested too deeply")
    ws()
    const ch = text[i]
    if (ch === "{") {
      i++
      const keys = new Set<string>()
      ws()
      if (text[i] === "}") return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail("expected a key")
        const key = str()
        if (keys.has(key)) fail(`duplicate key ${JSON.stringify(key)}`)
        keys.add(key)
        ws()
        if (text[i++] !== ":") fail("expected ':'")
        value(depth + 1)
        ws()
        const sep = text[i++]
        if (sep === "}") return
        if (sep !== ",") fail("expected ',' or '}'")
      }
    }
    if (ch === "[") {
      i++
      ws()
      if (text[i] === "]") return void i++
      for (;;) {
        value(depth + 1)
        ws()
        const sep = text[i++]
        if (sep === "]") return
        if (sep !== ",") fail("expected ',' or ']'")
      }
    }
    if (ch === '"') return void str()
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (m) {
      if (!m[1] && !m[2] && !Number.isSafeInteger(Number(m[0]))) fail(`the integer ${m[0]} is too large to keep exactly`)
      i += m[0].length
      return
    }
    for (const word of ["true", "false", "null"]) if (text.startsWith(word, i)) return void (i += word.length)
    fail("not valid JSON (comments are not supported)")
  }
  try {
    value(0)
    ws()
    if (i !== text.length) fail("not valid JSON (comments are not supported)")
    JSON.parse(text)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : "not valid JSON"
  }
}
