// Command-line parsing: `--flag`, `--flag value`, `--flag=value` and short aliases (-n, -h, -V). Unknown flags
// and wrong positional counts are usage errors (exit 2).

/**
 * optional: a value only when given with `=` or when the next token starts with a digit (`--wait`, `--wait 30`).
 * json: a value only when given with `=`, or when the next token looks like JSON (`{`, `[`) or is `-` (stdin):
 * `hub answer … --json '{…}'` takes the answer while a bare `--json` keeps its usual meaning (raw output).
 */
export type FlagKind = "bool" | "string" | "multi" | "optional" | "json"

export interface CommandSpec {
  readonly flags?: Readonly<Record<string, FlagKind>>
  /** Positional arguments: required names, then optional ones (suffixed `?`), then any number (suffixed `...`). */
  readonly args?: readonly string[]
}

export interface Parsed {
  readonly flags: Record<string, string | boolean | string[]>
  readonly args: string[]
}

export class UsageError extends Error {}

/** Flags every command takes. */
const COMMON: Record<string, FlagKind> = { json: "bool", help: "bool" }
const SHORT: Record<string, string> = { h: "help", n: "n", V: "version" }

export function parse(argv: readonly string[], spec: CommandSpec): Parsed {
  const kinds: Record<string, FlagKind> = { ...COMMON, ...spec.flags }
  const flags: Parsed["flags"] = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") {
      args.push(...argv.slice(i + 1))
      break
    }
    const long = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(token)
    const short = /^-([a-zA-Z])$/.exec(token)
    if (!long && !short) {
      if (token.startsWith("-") && token.length > 1) throw new UsageError(`unknown option ${token}`)
      args.push(token)
      continue
    }
    const name = long ? long[1]! : SHORT[short![1]!]
    const kind = name === undefined ? undefined : kinds[name]
    if (name === undefined || kind === undefined) throw new UsageError(`unknown option ${token}`)
    if (kind === "bool") {
      if (long?.[2] !== undefined) throw new UsageError(`${token}: --${name} takes no value`)
      flags[name] = true
      continue
    }
    let value = long?.[2]
    const next = argv[i + 1] ?? ""
    if (value === undefined && ((kind === "optional" && !/^\d/.test(next)) || (kind === "json" && !/^[{[]/.test(next) && next !== "-"))) {
      flags[name] = true
      continue
    }
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
    }
    if (kind === "multi") flags[name] = [...((flags[name] as string[] | undefined) ?? []), value]
    else flags[name] = value
  }
  if (flags.help) return { flags, args }
  const names = spec.args ?? []
  const required = names.filter((n) => !n.endsWith("?") && !n.endsWith("...")).length
  if (args.length < required) throw new UsageError(`missing ${names.slice(args.length, required).join(" ")}`)
  if (args.length > names.length && !names.at(-1)?.endsWith("...")) throw new UsageError(`unexpected argument ${args[names.length]}`)
  return { flags, args }
}

export const str = (flags: Parsed["flags"], name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined)
