// A safe Markdown dialect for assistant replies (CommonMark + GFM where agents use it), parsed into a tree the UI
// renders as elements (never innerHTML; HTML in the source stays text).
//
// Blocks: paragraphs (a single newline is a line break, as agents write), ATX and setext headings, bullet/numbered
// lists (nested by indentation, mixed kinds, task items, loose items with several paragraphs), fenced code (an
// unterminated fence is code too, as replies stream in), block quotes holding any blocks, GFM tables, rules.
// Inline: code spans, **strong**, *em*/_em_, ~~strike~~, ==highlight==, [links](url), autolinks (<url> and bare
// http(s) URLs), images (kept as links, never loaded), hard breaks and backslash escapes.
//
// `streaming`: the text is still arriving. The last block then closes what it opened (`**bold` is bold, a table
// header alone is a table, a link target still being written shows its label), so the layout does not jump.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del" | "mark"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  /** An image: rendered as a link to it (or its alt text alone when the source is unsafe), never loaded. */
  | { type: "image"; alt: string; href?: string }
  | { type: "br" }

export type Align = "left" | "center" | "right" | null
export type ListItem = { checked?: boolean; blocks: MdBlock[] }

export type MdBlock =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  /** loose: items are separated by blank lines (or hold several blocks), so their paragraphs keep their spacing. */
  | { type: "list"; ordered: boolean; start?: number; loose: boolean; items: ListItem[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" }

export type MarkdownOptions = { streaming?: boolean }

// Blocks before inline parsing.
type RawItem = { checked?: boolean; blocks: Raw[] }
type Raw =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; start?: number; loose: boolean; items: RawItem[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: Raw[] }
  | { type: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { type: "rule" }

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*))?$/
const SETEXT = /^\s{0,3}(={2,}|-{3,})\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/
const TASK = /^\[([ xX])\](?:\s+(.*))?$/
const DELIM_CELL = /^:?-+:?$/

const indentOf = (line: string) => line.length - line.trimStart().length
const strip = (line: string, n: number) => line.slice(Math.min(n, indentOf(line)))
const isFence = (line: string) => FENCE.test(line)
/** A line that starts a block of its own (it cannot continue a paragraph lazily). */
const isBlockStart = (line: string) => isFence(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)

type Ctx = { streaming: boolean }

export function parseMarkdown(source: string, options: MarkdownOptions = {}): MdBlock[] {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^[ \t]+/, (w) => w.replace(/\t/g, "    ")))
  const streaming = Boolean(options.streaming)
  const raw = parseBlocks(lines, { streaming }, true).blocks
  return finalize(raw, streaming ? tailOf(raw) : undefined)
}

function parseBlocks(lines: string[], ctx: Ctx, atEnd: boolean): { blocks: Raw[]; loose: boolean; trailingBlank: boolean } {
  const out: Raw[] = []
  let para: string[] = []
  let blank = false
  let started = false
  let loose = false
  // A block begins: a blank line since the previous one makes the container loose.
  const begin = () => {
    if (blank && started) loose = true
    blank = false
    started = true
  }
  const flush = () => {
    if (para.length) out.push({ type: "paragraph", text: para.join("\n") })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) {
      flush()
      blank = true
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      begin()
      const [, indent, marker] = fence as unknown as [string, string, string]
      const body: string[] = []
      i++
      for (; i < lines.length; i++) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]!)
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break
        body.push(strip(lines[i]!, indent.length))
      }
      out.push({ type: "code", lang: fence[3] ?? "", text: body.join("\n") })
      continue
    }
    if (para.length) {
      const setext = SETEXT.exec(line)
      if (setext) {
        out.push({ type: "heading", level: setext[1]![0] === "=" ? 1 : 2, text: para.join("\n") })
        para = []
        continue
      }
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      begin()
      out.push({ type: "heading", level: heading[1]!.length, text: (heading[2] ?? "").replace(/(^|\s+)#+\s*$/, "").trim() })
      continue
    }
    if (RULE.test(line)) {
      flush()
      begin()
      out.push({ type: "rule" })
      continue
    }
    const table = tableAt(lines, i, ctx.streaming && atEnd)
    if (table) {
      flush()
      begin()
      out.push(table.block)
      i = table.end - 1
      continue
    }
    if (QUOTE.test(line)) {
      flush()
      begin()
      const body: string[] = []
      let j = i
      for (; j < lines.length; j++) {
        const m = QUOTE.exec(lines[j]!)
        if (m) body.push(m[1]!)
        else if (lines[j]!.trim() && body.at(-1)?.trim() && !isBlockStart(lines[j]!)) body.push(lines[j]!)
        else break
      }
      out.push({ type: "quote", blocks: parseBlocks(body, ctx, atEnd && j === lines.length).blocks })
      i = j - 1
      continue
    }
    const item = LIST.exec(line)
    if (item && (!para.length || canInterrupt(item[2]!))) {
      flush()
      begin()
      const list = parseList(lines, i, ctx, atEnd)
      out.push(list.block)
      i = list.end - 1
      if (list.trailingBlank) blank = true
      continue
    }
    if (!para.length) begin()
    para.push(line.trim())
  }
  flush()
  return { blocks: out, loose, trailingBlank: blank }
}

/** Bullets interrupt a paragraph; numbered items only from 1 ("In\n2024. we…" stays a paragraph). */
const canInterrupt = (marker: string) => !/\d/.test(marker) || /^0*1[.)]$/.test(marker)

function parseList(lines: string[], from: number, ctx: Ctx, atEnd: boolean): { block: Raw; end: number; trailingBlank: boolean } {
  const first = LIST.exec(lines[from]!)!
  const ordered = /\d/.test(first[2]!)
  const kind = first[2]!.slice(-1)
  const items: RawItem[] = []
  let loose = false
  let trailingBlank = false
  let j = from
  while (j < lines.length) {
    const m = LIST.exec(lines[j]!)
    if (!m || /\d/.test(m[2]!) !== ordered || m[2]!.slice(-1) !== kind) break
    if (items.length && trailingBlank) loose = true
    const markerIndent = m[1]!.length
    const gap = m[3]?.replace(/\t/g, "    ").length ?? 0
    const contentIndent = markerIndent + m[2]!.length + (gap >= 1 && gap <= 4 ? gap : 1)
    const body: string[] = [gap > 4 ? `${" ".repeat(gap - 1)}${m[4] ?? ""}`.trim() : (m[4] ?? "")]
    let fence: string | undefined
    const track = (l: string) => {
      if (fence) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(l)
        if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = undefined
      } else {
        const open = FENCE.exec(l)
        if (open) fence = open[2]
      }
    }
    track(body[0]!)
    let k = j + 1
    let blanks = 0
    for (; k < lines.length; k++) {
      const l = lines[k]!
      if (!l.trim()) {
        blanks++
        continue
      }
      const ind = indentOf(l)
      let accept: boolean
      if (fence) accept = true
      else if (blanks) accept = ind >= Math.min(contentIndent, markerIndent + 2)
      else if (ind >= contentIndent) accept = true
      else if (LIST.test(l)) accept = ind >= markerIndent + 2
      else if (ind > markerIndent) accept = true
      else accept = !isBlockStart(l) && !isFence(body.at(-1)!)
      if (!accept) break
      for (; blanks; blanks--) body.push("")
      const stripped = strip(l, contentIndent)
      body.push(stripped)
      track(stripped)
    }
    trailingBlank = blanks > 0
    const task = TASK.exec(body[0]!)
    const parsed = parseBlocks(task ? [task[2] ?? "", ...body.slice(1)] : body, ctx, atEnd && k === lines.length)
    if (parsed.loose) loose = true
    items.push({ ...(task ? { checked: task[1] !== " " } : {}), blocks: parsed.blocks })
    j = k
  }
  const start = ordered ? Number(first[2]!.slice(0, -1)) : undefined
  return { block: { type: "list", ordered, ...(ordered ? { start } : {}), loose, items }, end: j, trailingBlank }
}

/** Cells of a table row: outer pipes dropped, split on unescaped pipes (`\|` is a literal pipe). */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|"
      k++
    } else if (s[k] === "|") {
      cells.push(cur.trim())
      cur = ""
    } else cur += s[k]
  }
  cells.push(cur.trim())
  return cells
}

const alignOf = (cell: string): Align => {
  const c = cell.trim()
  const left = c.startsWith(":")
  const right = c.length > 1 && c.endsWith(":")
  return left && right ? "center" : right ? "right" : left ? "left" : null
}

/**
 * A table at line `i`: a header row with pipes, then a delimiter row with as many cells. A delimiter row still being
 * written (the last line) counts; while streaming, so does a header row alone at the very end.
 */
function tableAt(lines: string[], i: number, streamingEnd: boolean): { block: Raw; end: number } | undefined {
  const line = lines[i]!
  if (!line.includes("|")) return undefined
  const head = splitRow(line)
  const next = lines[i + 1]
  let align: Align[] | undefined
  if (next !== undefined) {
    const cells = splitRow(next)
    const lastLine = i + 1 === lines.length - 1
    if (cells.length === head.length && cells.every((c) => DELIM_CELL.test(c))) align = cells.map(alignOf)
    else if (lastLine && /^[\s|:-]*$/.test(next) && (next.includes("-") || streamingEnd) && next.includes("|") && cells.length <= head.length)
      align = head.map((_, k) => (cells[k] && DELIM_CELL.test(cells[k]!) ? alignOf(cells[k]!) : null))
  } else if (streamingEnd && line.trimStart().startsWith("|") && (line.match(/\|/g)?.length ?? 0) >= 2) align = head.map(() => null)
  if (!align) return undefined
  const rows: string[][] = []
  let j = i + 2
  for (; j < lines.length; j++) {
    const l = lines[j]!
    if (!l.trim() || !l.includes("|") || isFence(l) || QUOTE.test(l) || HEADING.test(l)) break
    rows.push(splitRow(l).slice(0, head.length))
  }
  return { block: { type: "table", align, head, rows }, end: Math.min(j, lines.length) }
}

// ---------- inline ----------

/** Where streaming applies: the last text of the last block (the last cell written in a table). */
type Tail = { node: Raw; cell?: [number, number] }

function tailOf(blocks: Raw[]): Tail | undefined {
  const last = blocks.at(-1)
  if (!last) return undefined
  if (last.type === "paragraph" || last.type === "heading") return { node: last }
  if (last.type === "quote") return tailOf(last.blocks)
  if (last.type === "list") return tailOf(last.items.at(-1)?.blocks ?? [])
  if (last.type === "table") {
    const r = last.rows.length - 1
    return { node: last, cell: r >= 0 ? [r, last.rows[r]!.length - 1] : [-1, last.head.length - 1] }
  }
  return undefined
}

function finalize(blocks: Raw[], tail: Tail | undefined): MdBlock[] {
  const open = (node: Raw) => tail?.node === node
  return blocks.map((b): MdBlock => {
    switch (b.type) {
      case "paragraph":
        return { type: "paragraph", children: parseInline(b.text, { streaming: open(b) }) }
      case "heading":
        return { type: "heading", level: b.level, children: parseInline(b.text, { streaming: open(b) }) }
      case "quote":
        return { type: "quote", blocks: finalize(b.blocks, tail) }
      case "list":
        return { ...b, items: b.items.map((i) => ({ ...(i.checked === undefined ? {} : { checked: i.checked }), blocks: finalize(i.blocks, tail) })) }
      case "table": {
        const cell = (text: string, r: number, c: number) => parseInline(text, { streaming: open(b) && tail!.cell![0] === r && tail!.cell![1] === c })
        const width = b.head.length
        return {
          type: "table",
          align: b.align,
          head: b.head.map((t, c) => cell(t, -1, c)),
          rows: b.rows.map((row, r) => Array.from({ length: width }, (_, c) => cell(row[c] ?? "", r, c))),
        }
      }
      default:
        return b
    }
  })
}

/**
 * Links allowed in replies: http(s), mailto and same-site paths. Backslashes, whitespace and control characters
 * are refused anywhere: browsers read `\` as `/` and drop tabs and newlines, so `/\evil.com` or `/<tab>/evil.com`
 * would leave the site.
 */
export function safeHref(href: string): string | undefined {
  const value = href.trim()
  if (/[\\\s\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined
  if (/^(https?:|mailto:)/i.test(value)) return value
  if (value.startsWith("/") && !value.startsWith("//")) return value
  return undefined
}

type InlineOptions = { streaming?: boolean; inLink?: boolean }

const PUNCT = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const WORD = /[\p{L}\p{N}_]/u
const PAIRS: Record<string, "strong" | "del" | "mark"> = { "**": "strong", __: "strong", "~~": "del", "==": "mark" }

const runOf = (s: string, at: number, ch: string) => {
  let n = 0
  while (s[at + n] === ch) n++
  return n
}

/** Start of the run of exactly `n` backticks closing a code span opened before `from`, or -1. */
function closingTicks(s: string, from: number, n: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] !== "`") continue
    const r = runOf(s, k, "`")
    if (r === n) return k
    k += r - 1
  }
  return -1
}

/** The next `delim` from `from` that `ok` accepts, skipping escapes and code spans; -1 if none. */
function findCloser(s: string, from: number, delim: string, ok: (k: number) => boolean): number {
  for (let k = from; k <= s.length - delim.length; k++) {
    const c = s[k]
    if (c === "\\") {
      k++
      continue
    }
    if (c === "`" && delim !== "`") {
      const r = runOf(s, k, "`")
      const end = closingTicks(s, k + r, r)
      k = (end >= 0 ? end : k) + r - 1
      continue
    }
    if (s.startsWith(delim, k) && ok(k)) return k
  }
  return -1
}

/** Index of the "]" matching the "[" at `open` (nested brackets balanced), or -1. */
function closingBracket(s: string, open: number): number {
  let depth = 0
  for (let k = open + 1; k < s.length; k++) {
    const c = s[k]
    if (c === "\\") k++
    else if (c === "`") {
      const r = runOf(s, k, "`")
      const end = closingTicks(s, k + r, r)
      k = (end >= 0 ? end : k) + r - 1
    } else if (c === "[") depth++
    else if (c === "]") {
      if (depth === 0) return k
      depth--
    }
  }
  return -1
}

/** Index of the ")" that closes a link target starting at `from` (nested parentheses balanced), or -1. */
function closingParen(s: string, from: number): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")") {
      if (depth === 0) return i
      depth--
    } else if (s[i] === "\n") return -1
  }
  return -1
}

/** The URL of a link target: `<url>` or its first word (a title after it is ignored). */
function targetUrl(target: string): string {
  const t = target.trim()
  if (t.startsWith("<")) return t.slice(1, t.indexOf(">") > 0 ? t.indexOf(">") : undefined)
  return t.split(/\s+/)[0] ?? ""
}

const plain = (nodes: Inline[]): string =>
  nodes.map((n) => (n.type === "text" || n.type === "code" ? n.text : n.type === "image" ? n.alt : n.type === "br" ? " " : plain(n.children))).join("")

/** A bare URL starting at `i`, without trailing punctuation or an unbalanced ")". */
function bareUrl(s: string, i: number): string | undefined {
  const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 2048))
  if (!m) return undefined
  let url = m[0]
  for (;;) {
    const last = url.at(-1)!
    if (/[.,:;!?'"*_~]/.test(last)) url = url.slice(0, -1)
    else if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
    else if (last === "]" && (url.match(/\[/g)?.length ?? 0) < (url.match(/\]/g)?.length ?? 0)) url = url.slice(0, -1)
    else break
  }
  return /^https?:\/\/[^/]/i.test(url) ? url : undefined
}

export function parseInline(source: string, options: InlineOptions = {}): Inline[] {
  const s = String(source ?? "")
  const streaming = Boolean(options.streaming)
  const out: Inline[] = []
  let text = ""
  const push = (...nodes: Inline[]) => {
    if (text) out.push({ type: "text", text })
    text = ""
    out.push(...nodes)
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    const next = s[i + 1]
    if (c === "\\") {
      if (next === "\n") {
        push({ type: "br" })
        i += 2
        continue
      }
      if (next !== undefined && PUNCT.test(next)) {
        text += next
        i += 2
        continue
      }
    }
    if (c === "\n") {
      text = text.replace(/ +$/, "")
      push({ type: "br" })
      i++
      continue
    }
    if (c === "`") {
      const r = runOf(s, i, "`")
      const end = closingTicks(s, i + r, r)
      if (end >= 0 || streaming) {
        let code = s.slice(i + r, end >= 0 ? end : undefined)
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1)
        push({ type: "code", text: code })
        i = end >= 0 ? end + r : s.length
        continue
      }
      text += s.slice(i, i + r)
      i += r
      continue
    }
    const pair = s.slice(i, i + 2)
    const kind = PAIRS[pair]
    if (kind && next !== undefined && s[i + 2] !== undefined && !SPACE.test(s[i + 2]!) && s[i + 2] !== c && (c !== "_" || i === 0 || !WORD.test(s[i - 1]!))) {
      const end = findCloser(s, i + 3, pair, (k) => !SPACE.test(s[k - 1]!) && (c !== "_" || !WORD.test(s[k + 2] ?? "")))
      if (end > 0 || streaming) {
        const inner = s.slice(i + 2, end > 0 ? end : undefined)
        push({ type: kind, children: parseInline(inner, { inLink: options.inLink, streaming: end < 0 }) })
        i = end > 0 ? end + 2 : s.length
        continue
      }
    }
    if ((c === "*" || c === "_") && next !== undefined && next !== c && !SPACE.test(next) && (c === "*" || i === 0 || !WORD.test(s[i - 1]!))) {
      const end = findCloser(s, i + 1, c, (k) => {
        if (s[k + 1] === c || s[k - 1] === c) return false
        return !SPACE.test(s[k - 1]!) && (c !== "_" || !WORD.test(s[k + 1] ?? ""))
      })
      if (end > i + 1 || streaming) {
        push({ type: "em", children: parseInline(s.slice(i + 1, end > i ? end : undefined), { inLink: options.inLink, streaming: end < 0 }) })
        i = end > i ? end + 1 : s.length
        continue
      }
    }
    const image = c === "!" && next === "["
    if (c === "[" || image) {
      const open = image ? i + 1 : i
      const close = closingBracket(s, open)
      if (close > 0 && s[close + 1] === "(") {
        const end = closingParen(s, close + 2)
        const label = parseInline(s.slice(open + 1, close), { inLink: true })
        if (end > 0) {
          const href = safeHref(targetUrl(s.slice(close + 2, end)))
          if (image) push({ type: "image", alt: plain(label), ...(href ? { href } : {}) })
          // A link inside a link label keeps only its label (no links in links), as does an unsafe one.
          else if (href && !options.inLink) push({ type: "link", href, children: label })
          else push(...label)
          i = end + 1
          continue
        }
        if (streaming && !s.slice(close).includes("\n")) {
          // The target is still being written: show the label alone until it closes.
          push(...(image ? [{ type: "text", text: plain(label) } as Inline] : label))
          i = s.length
          continue
        }
      }
    }
    if (c === "<" && !options.inLink) {
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i, i + 2048))
      const email = /^<([^\s<>@\\]+@[^\s<>@\\]+\.[^\s<>@\\]+)>/.exec(s.slice(i, i + 512))
      const m = auto ?? email
      if (m) {
        const href = safeHref(auto ? m[1]! : `mailto:${m[1]}`)
        if (href) push({ type: "link", href, children: [{ type: "text", text: m[1]! }] })
        else text += m[0]
        i += m[0].length
        continue
      }
    }
    if ((c === "h" || c === "H") && !options.inLink && (i === 0 || !/[\p{L}\p{N}_/]/u.test(s[i - 1]!)) && s.slice(i - 2, i) !== "](") {
      const url = bareUrl(s, i)
      const href = url && safeHref(url)
      if (url && href) {
        push({ type: "link", href, children: [{ type: "text", text: url }] })
        i += url.length
        continue
      }
    }
    text += c
    i++
  }
  if (text) out.push({ type: "text", text })
  return out
}
