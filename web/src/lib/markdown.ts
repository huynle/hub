// A small, safe Markdown subset for assistant replies: parsed into a tree the UI renders as elements (never
// innerHTML). Blocks: paragraphs, ATX headings, bullet/numbered lists, fenced code (an unterminated fence is
// code too, as replies stream in), block quotes, rules. Inline: code, **strong**, *em*/_em_, [links](url).

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }

export type MdBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; start?: number; items: string[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; text: string }
  | { type: "rule" }

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

export function parseMarkdown(source: string): MdBlock[] {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n")
  const out: MdBlock[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ type: "paragraph", text: para.join("\n") })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!)
      out.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      out.push({ type: "heading", level: heading[1]!.length, text: heading[2]! })
      continue
    }
    if (RULE.test(line)) {
      flush()
      out.push({ type: "rule" })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const body = [quote[1]!]
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1]!)) body.push(QUOTE.exec(lines[++i]!)![1]!)
      out.push({ type: "quote", text: body.join("\n") })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flush()
      const ordered = !bullet
      const items: string[] = [(bullet ? bullet[1] : numbered![2])!]
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        const m = ordered ? NUMBERED.exec(next) : BULLET.exec(next)
        if (m) {
          items.push((ordered ? m[2] : m[1])!)
          i++
        } else if (next.trim() && /^\s{2,}\S/.test(next)) {
          items[items.length - 1] += `\n${next.trim()}`
          i++
        } else break
      }
      out.push({ type: "list", ordered, ...(ordered ? { start: Number(numbered![1]) } : {}), items })
      continue
    }
    para.push(line)
  }
  flush()
  return out
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

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let text = ""
  const push = (node: Inline) => {
    if (text) out.push({ type: "text", text })
    text = ""
    out.push(node)
  }
  const s = String(source ?? "")
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === "`") {
      const end = s.indexOf("`", i + 1)
      if (end > i) {
        push({ type: "code", text: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c) {
      const end = s.indexOf(c + c, i + 2)
      if (end > i + 2) {
        push({ type: "strong", children: parseInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] !== c && s[i + 1] !== " " && (c === "*" || i === 0 || !/\w/.test(s[i - 1]!))) {
      const end = s.indexOf(c, i + 1)
      if (end > i + 1 && s[end - 1] !== " ") {
        push({ type: "em", children: parseInline(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (c === "[") {
      const close = s.indexOf("](", i + 1)
      const end = close > 0 ? closingParen(s, close + 2) : -1
      if (close > i && end > close) {
        const label = parseInline(s.slice(i + 1, close))
        const href = safeHref(s.slice(close + 2, end))
        if (href) push({ type: "link", href, children: label })
        else {
          // Unsafe target: keep only the label text.
          if (text) out.push({ type: "text", text })
          text = ""
          out.push(...label)
        }
        i = end + 1
        continue
      }
    }
    text += c
    i++
  }
  if (text) out.push({ type: "text", text })
  return out
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
