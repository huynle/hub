// Lossless config merging for merge-config (v1.1: JSONC, comment- and formatting-preserving).
//
// OpenCode configs are often JSONC: comments, trailing commas, the user's own layout. A merge must keep all of it,
// so it never re-serializes the document. It parses the text into a concrete syntax tree that remembers where every
// value starts and ends, decides what changes on the plain JSON value (the same pointer semantics as always: "-"
// appends unless the value is already there, a missing container is created, a scalar in the way is a conflict),
// and then splices only the text of the value it sets or the member/item it inserts. Every other byte (comments,
// trailing commas, key order, whitespace, numbers and strings exactly as written) is carried through untouched,
// and a document that needs no change is returned byte for byte. After each edit the result is parsed again and must
// equal the intended value exactly, or the merge is refused.
//
// What cannot be edited this way is refused with manual_edit_required (exit 10; the planner turns a known
// unmergeable format into an unmergeable-format ManualEdit): TOML, text that is not JSON/JSONC, duplicate keys (which
// one counts is ambiguous). A structural mismatch (the root is not an object, a scalar in the pointer's way, an
// index out of range) stays a conflict; a prototype key is invalid. No dependency: a small scanner below.
import { canonicalJSON, type ConfigFormat, type ConfigSet, type Json } from "../contracts/index.ts"
import { txFail, txOk, type TxResult } from "./result.ts"

type Value = null | boolean | number | string | Value[] | { [key: string]: Value }

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
const MAX_DEPTH = 512

// ---------- concrete syntax tree ----------

interface Span {
  /** Offset of the first character. */
  readonly start: number
  /** Offset just past the last character. */
  readonly end: number
}

interface Member {
  readonly key: string
  readonly keyStart: number
  readonly keyEnd: number
  readonly value: CstNode
}

type CstNode =
  | (Span & { readonly kind: "object"; readonly members: readonly Member[] })
  | (Span & { readonly kind: "array"; readonly items: readonly CstNode[] })
  | (Span & { readonly kind: "scalar" })

class ParseError extends Error {}

/** Skips whitespace and comments from `i`; returns the offset of the next significant character. */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && " \t\n\r\uFEFF".includes(text[i]!)) i++
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? text.length : nl
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2)
      if (close < 0) throw new ParseError("an unterminated /* comment")
      i = close + 2
    } else return i
  }
}

function parseCst(text: string): CstNode {
  let i = 0
  const value = (depth: number): CstNode => {
    if (depth > MAX_DEPTH) throw new ParseError("nested too deeply")
    i = skipTrivia(text, i)
    const start = i
    const ch = text[i]
    if (ch === "{") {
      i++
      const members: Member[] = []
      const keys = new Set<string>()
      for (;;) {
        i = skipTrivia(text, i)
        if (text[i] === "}") break
        if (text[i] !== '"') throw new ParseError("expected a key")
        const keyStart = i
        const key = str()
        if (keys.has(key)) throw new ParseError(`duplicate key ${JSON.stringify(key)}`)
        keys.add(key)
        const keyEnd = i
        i = skipTrivia(text, i)
        if (text[i++] !== ":") throw new ParseError("expected ':'")
        members.push({ key, keyStart, keyEnd, value: value(depth + 1) })
        i = skipTrivia(text, i)
        if (text[i] === ",") i++
        else if (text[i] !== "}") throw new ParseError("expected ',' or '}'")
      }
      i++
      return { kind: "object", start, end: i, members }
    }
    if (ch === "[") {
      i++
      const items: CstNode[] = []
      for (;;) {
        i = skipTrivia(text, i)
        if (text[i] === "]") break
        items.push(value(depth + 1))
        i = skipTrivia(text, i)
        if (text[i] === ",") i++
        else if (text[i] !== "]") throw new ParseError("expected ',' or ']'")
      }
      i++
      return { kind: "array", start, end: i, items }
    }
    if (ch === '"') {
      str()
      return { kind: "scalar", start, end: i }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400))
    if (m) {
      i += m[0].length
      return { kind: "scalar", start, end: i }
    }
    for (const word of ["true", "false", "null"])
      if (text.startsWith(word, i)) {
        i += word.length
        return { kind: "scalar", start, end: i }
      }
    throw new ParseError("not valid JSON or JSONC")
  }
  const str = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    if (i >= text.length) throw new ParseError("an unterminated string")
    i++
    try {
      return JSON.parse(text.slice(start, i)) as string
    } catch {
      throw new ParseError("an invalid string")
    }
  }
  const root = value(0)
  if (skipTrivia(text, i) !== text.length) throw new ParseError("unexpected text after the document")
  return root
}

function toValue(text: string, node: CstNode): Value {
  if (node.kind === "scalar") return JSON.parse(text.slice(node.start, node.end)) as Value
  if (node.kind === "array") return node.items.map((item) => toValue(text, item))
  const out: { [key: string]: Value } = {}
  for (const m of node.members) Object.defineProperty(out, m.key, { value: toValue(text, m.value), enumerable: true, writable: true, configurable: true })
  return out
}

/** Parses JSON or JSONC (comments, trailing commas) into its JSON value; duplicate keys are refused. */
export function parseJsonc(text: string): { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: toValue(text, parseCst(text)) }
  } catch (error) {
    return { ok: false, message: error instanceof ParseError ? error.message : "not valid JSON or JSONC" }
  }
}

// ---------- the merge ----------

/** Merges `sets` into the config text (undefined: the file does not exist yet). */
export function mergeConfigText(text: string | undefined, format: ConfigFormat, sets: readonly ConfigSet[]): TxResult<string> {
  if (format === "toml") return txFail("manual_edit_required", "TOML configs cannot be edited losslessly by this hubctl; make the edit by hand")
  if (text === undefined) {
    const root: Value = {}
    for (const set of sets) {
      const r = applySet(root, set)
      if (!r.ok) return r
    }
    return txOk(`${JSON.stringify(root, null, 2)}\n`)
  }
  let current = text
  for (const set of sets) {
    let cst: CstNode
    try {
      cst = parseCst(current)
    } catch (error) {
      return txFail("manual_edit_required", `the config cannot be edited losslessly (${error instanceof Error ? error.message : "unreadable"}); make the edit by hand`)
    }
    const tree = toValue(current, cst)
    if (!isObject(tree)) return txFail("conflict", "the config is not a JSON object")
    const changed = applySet(tree, set)
    if (!changed.ok) return changed
    if (!changed.value) continue
    const next = editText(current, cst, segments(set.pointer), set.value)
    const check = parseJsonc(next)
    if (!check.ok || canonicalJSON(check.value) !== canonicalJSON(tree))
      return txFail("manual_edit_required", `${set.pointer} could not be edited losslessly in this config; make the edit by hand`)
    current = next
  }
  return txOk(current)
}

const isObject = (v: unknown): v is { [key: string]: Value } => typeof v === "object" && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b)
const clone = (v: Json): Value => JSON.parse(JSON.stringify(v)) as Value

function segments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
}

function setKey(obj: { [key: string]: Value }, key: string, value: Value): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Applies one set to the plain value (the semantics of a merge); ok(true) when the document changed. */
function applySet(root: Value, set: ConfigSet): TxResult<boolean> {
  if (!set.pointer.startsWith("/")) return txFail("invalid", `${set.pointer} is not a JSON pointer`)
  const segs = segments(set.pointer)
  if (segs.some((s) => FORBIDDEN_KEYS.has(s))) return txFail("invalid", `${set.pointer} names a prototype key`)
  let current: Value = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    let next: Value | undefined
    if (Array.isArray(current)) {
      const index = arrayIndex(seg, current.length - 1)
      if (index === undefined) return txFail("conflict", `${set.pointer}: no array element ${seg}`)
      next = current[index]
    } else if (isObject(current)) {
      next = Object.hasOwn(current, seg) ? current[seg] : undefined
      if (next === undefined) {
        // A missing container is created as an array when the pointer appends to it ("-"), else an object.
        next = segs[i + 1] === "-" ? [] : {}
        setKey(current, seg, next)
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
  setKey(current, last, value)
  return txOk(true)
}

function arrayIndex(seg: string, max: number): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(seg)) return undefined
  const n = Number(seg)
  return n <= max ? n : undefined
}

// ---------- text edits ----------

interface Splice {
  readonly at: number
  readonly remove: number
  readonly insert: string
}

/** Applies splices given in text order (at equal offsets, the earlier one ends up first). */
function applySplices(text: string, splices: readonly Splice[]): string {
  let out = text
  const ordered = splices.map((s, i) => ({ s, i })).sort((a, b) => b.s.at - a.s.at || b.i - a.i)
  for (const { s } of ordered) out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove)
  return out
}

/** The whitespace that starts the line holding offset `pos`. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/** The document's indentation unit: the first indented line's indentation, else two spaces. */
function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? "  "
}

/**
 * Where a new line may be inserted after offset `from` without separating a value from the comment that follows it
 * on the same line: past spaces and same-line comments, before the newline (or before the next token).
 */
function lineEnd(text: string, from: number): number {
  let i = from
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i)
      return nl < 0 ? text.length : nl
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2)
      if (close < 0 || text.slice(i, close).includes("\n")) return i
      i = close + 2
      continue
    }
    return i
  }
}

const isScalar = (v: unknown) => v === null || typeof v !== "object"

/** A value as text: compact when inline; otherwise objects (and arrays holding containers) one entry per line. */
function render(value: Json, indent: string, unit: string, inline: boolean, colon: string): string {
  if (isScalar(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (inline || value.every(isScalar)) return `[${value.map((v) => render(v, indent, unit, true, colon)).join(", ")}]`
    const inner = indent + unit
    return `[\n${value.map((v) => inner + render(v, inner, unit, false, colon)).join(",\n")}\n${indent}]`
  }
  const entries = Object.entries(value as { [key: string]: Json })
  if (entries.length === 0) return "{}"
  if (inline) return `{${entries.map(([k, v]) => `${JSON.stringify(k)}${colon}${render(v, indent, unit, true, colon)}`).join(", ")}}`
  const inner = indent + unit
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}${colon}${render(v, inner, unit, false, colon)}`).join(",\n")}\n${indent}}`
}

/** The value a missing pointer tail creates ("-" makes an array, any other segment an object). */
function nested(segs: readonly string[], value: Json): Json {
  if (segs.length === 0) return value
  const inner = nested(segs.slice(1), value)
  return segs[0] === "-" ? [inner] : { [segs[0]!]: inner }
}

/** The key/value separator a container already uses (": " unless its members are written tight). */
function colonOf(text: string, node: CstNode): string {
  if (node.kind !== "object" || node.members.length === 0) return ": "
  const m = node.members[0]!
  return /:\s/.test(text.slice(m.keyEnd, m.value.start)) ? ": " : ":"
}

/** The text after editing one pointer of the (already validated) set. */
function editText(text: string, root: CstNode, segs: readonly string[], value: Json): string {
  const unit = indentUnit(text)
  let colon = colonOf(text, root)
  let node = root
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const last = i === segs.length - 1
    if (node.kind === "object") {
      colon = colonOf(text, node) === ":" ? ":" : colon
      const member = node.members.find((m) => m.key === seg)
      if (!member) return insertEntry(text, node, `${JSON.stringify(seg)}${colon}`, nested(segs.slice(i + 1), value), unit, colon)
      if (last) return replaceValue(text, member.value, value, lineIndent(text, member.keyStart), unit, colon)
      node = member.value
    } else if (node.kind === "array") {
      if (seg === "-" || Number(seg) === node.items.length) return insertEntry(text, node, "", value, unit, colon)
      const item = node.items[Number(seg)]!
      if (last) return replaceValue(text, item, value, lineIndent(text, item.start), unit, colon)
      node = item
    } else throw new Error("unreachable: the merge already refused a scalar in the way")
  }
  throw new Error("unreachable: an empty pointer")
}

function replaceValue(text: string, node: CstNode, value: Json, indent: string, unit: string, colon: string): string {
  const inline = !text.slice(node.start, node.end).includes("\n") && !isScalar(value) && !text.includes("\n")
  return applySplices(text, [{ at: node.start, remove: node.end - node.start, insert: render(value, indent, unit, inline, colon) }])
}

/** Inserts a member (`prefix` is `"key": `) or an array item (no prefix) as the container's last entry. */
function insertEntry(text: string, container: CstNode, prefix: string, value: Json, unit: string, colon: string): string {
  const entries: { start: number; end: number }[] =
    container.kind === "object" ? container.members.map((m) => ({ start: m.keyStart, end: m.value.end })) : container.kind === "array" ? container.items.map((n) => ({ start: n.start, end: n.end })) : []
  const close = container.end - 1
  const multiline = text.slice(container.start, container.end).includes("\n")
  if (entries.length === 0) {
    const inner = text.slice(container.start + 1, close)
    const commented = /\/[/*]/.test(inner)
    const baseIndent = lineIndent(text, container.start)
    // An empty array, or an empty object nested in a one-line document, gets an inline entry; an empty root object
    // (a fresh `{}` config) or a commented one gets an entry on its own line.
    const singleLineDoc = !text.trimEnd().includes("\n")
    const isRoot = container.start === skipTrivia(text, 0)
    if ((container.kind === "array" || (singleLineDoc && !isRoot)) && !commented) {
      return applySplices(text, [{ at: container.start + 1, remove: inner.length, insert: prefix + render(value, baseIndent, unit, singleLineDoc, colon) }])
    }
    const keep = inner.trimEnd().length
    const entryIndent = baseIndent + unit
    return applySplices(text, [{ at: container.start + 1 + keep, remove: inner.length - keep, insert: `\n${entryIndent}${prefix}${render(value, entryIndent, unit, false, colon)}\n${baseIndent}` }])
  }
  const lastEntry = entries[entries.length - 1]!
  const after = skipTrivia(text, lastEntry.end)
  const trailingComma = text[after] === ","
  if (!multiline) {
    const entry = prefix + render(value, "", unit, true, colon)
    const sep = entries.length > 1 && !/,\s/.test(text.slice(entries[0]!.end, entries[1]!.start)) ? "," : ", "
    if (trailingComma) return applySplices(text, [{ at: after + 1, remove: 0, insert: `${sep === "," ? "" : " "}${entry},` }])
    return applySplices(text, [{ at: lastEntry.end, remove: 0, insert: `${sep}${entry}` }])
  }
  const indent = lineIndent(text, lastEntry.start)
  const entry = prefix + render(value, indent, unit, false, colon)
  if (trailingComma) return applySplices(text, [{ at: lineEnd(text, after + 1), remove: 0, insert: `\n${indent}${entry},` }])
  return applySplices(text, [
    { at: lastEntry.end, remove: 0, insert: "," },
    { at: lineEnd(text, lastEntry.end), remove: 0, insert: `\n${indent}${entry}` },
  ])
}
