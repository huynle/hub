// The command line's arguments:
//   hub-conformance spoke --driver "<command>" [--json] [--out <file>] [--retry-after-ms <n>]
//   hub-conformance spoke [options] -- <command> [args…]
// The driver command is split into words (quotes and backslashes honoured) and run without a shell: no variables,
// globs or other expansions.
export interface CliArgs {
  readonly suite: "spoke"
  readonly driver: string[]
  /** Print the JSON report instead of the table. */
  readonly json: boolean
  /** Also write the JSON report to this file. */
  readonly out?: string
  readonly retryAfterMs?: number
}

export const USAGE = `usage: hub-conformance spoke --driver "<command>" [--json] [--out <file>] [--retry-after-ms <n>]
       hub-conformance spoke [options] -- <command> [args…]`

/** Splits a command into words: whitespace separates, '…' and "…" quote, a backslash escapes the next character. */
export function splitCommand(text: string): string[] {
  const words: string[] = []
  let word = ""
  let inWord = false
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i]
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const [suite, ...rest] = argv
  if (suite !== "spoke") return { error: `unknown suite ${JSON.stringify(suite ?? "")} (only "spoke" for now)` }
  let driver: string[] | undefined
  let json = false
  let out: string | undefined
  let retryAfterMs: number | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    const value = () => rest[++i]
    if (arg === "--") {
      driver = rest.slice(i + 1)
      break
    } else if (arg === "--driver") driver = splitCommand(value() ?? "")
    else if (arg === "--json") json = true
    else if (arg === "--out") {
      out = value()
      if (!out) return { error: "--out needs a file" }
    } else if (arg === "--retry-after-ms") {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 0 || n > 300_000) return { error: "--retry-after-ms needs whole milliseconds (0–300000)" }
      retryAfterMs = n
    } else return { error: `unknown option ${JSON.stringify(arg)}` }
  }
  if (!driver?.length) return { error: "no driver command (--driver \"<command>\" or -- <command>)" }
  return { suite, driver, json, ...(out !== undefined ? { out } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
}
