// `hub grant list | show | create | revoke` (design §5): the spec of `hub grant create` (flags, or --json '{…}' /
// --json -) and the text of grants. Only the user manages grants (src/central/agent/grant-routes.ts); a session's
// own credential is refused here without asking the hub, any other the hub refuses (forbidden, exit 5).
import type { Grant, GrantSpec, GrantVerb } from "../../sdk/src/index.ts"
import { jsonObjectArg, str, UsageError, type FlagKind, type Parsed } from "./args"
import { CliError, EXIT } from "./http"

/** The flags of `hub grant create`. */
export const GRANT_FLAGS: Readonly<Record<string, FlagKind>> = {
  json: "json",
  holder: "string",
  project: "multi",
  allow: "multi",
  permit: "multi",
  never: "multi",
  expires: "string",
  "max-per-hour": "string",
  "allow-always": "bool",
}

export const GRANT_USER_HINT = "only the user manages grants: use the console, or `hub login` with the user's device token"

/** Refuses a session's own credential (HUB_SESSION_TOKEN): a session never creates or revokes a grant. */
export function userOnly(source: string, what: string): void {
  if (source === "env") throw new CliError(EXIT.forbidden, `only the user can ${what} a grant, not a session`, GRANT_USER_HINT)
}

/** A forbidden from the grant routes, with the hint of who may manage grants. */
export function grantError(error: unknown): unknown {
  if (error instanceof CliError && error.exit === EXIT.forbidden) return new CliError(error.exit, error.message, [error.hint, GRANT_USER_HINT].filter(Boolean).join("; "), error.envelope)
  return error
}

/** Comma-separated and repeated values, in order. */
const listOf = (flags: Parsed["flags"], name: string): string[] => ((flags[name] as string[] | undefined) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean)

/** The grant of `hub grant create`: a JSON spec (--json), or the flags. */
export async function grantSpecArg(flags: Parsed["flags"], stdin: (() => Promise<string>) | undefined): Promise<GrantSpec> {
  const json = typeof flags.json === "string" ? flags.json : undefined
  const flagged = Object.keys(GRANT_FLAGS).filter((name) => name !== "json" && flags[name] !== undefined)
  if (json !== undefined) {
    if (flagged.length) throw new UsageError(`give either --json '{…}' or ${flagged.map((f) => `--${f}`).join(", ")}`)
    return (await jsonObjectArg(json, stdin, "grant")) as unknown as GrantSpec
  }
  const holder = str(flags, "holder")
  if (holder === undefined) throw new UsageError("needs --holder (ses_…, @name, @@orchestrator…, or app:<token id>)")
  const projects = listOf(flags, "project")
  if (!projects.length) throw new UsageError("needs --project <path> (repeatable)")
  const allow = listOf(flags, "allow") as GrantVerb[]
  if (!allow.length) throw new UsageError("needs --allow <verbs> (approve, deny, answer, prompt, stop, roles)")
  const permit = listOf(flags, "permit")
  const never = listOf(flags, "never")
  const expires = str(flags, "expires")
  const cap = str(flags, "max-per-hour")
  if (cap !== undefined && !/^\d+$/.test(cap)) throw new UsageError("--max-per-hour is a whole number")
  return {
    holder,
    scope: { projects },
    allow,
    ...(permit.length || never.length ? { permissions: { ...(permit.length ? { allow: permit } : {}), ...(never.length ? { never } : {}) } } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(cap !== undefined ? { maxActionsPerHour: Number(cap) } : {}),
    ...(flags["allow-always"] === true ? { allowAlways: true } : {}),
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/** `g_1  active  @@orchestrator  approve,deny  /p  until 2026-…Z` */
export const grantLine = (g: Grant): string => [g.id, g.state, g.holder, g.allow.join(","), g.scope.projects.join(","), `until ${iso(g.expiresAt)}`].join("  ")

export const grantsText = (grants: readonly Grant[]): string => (grants.length ? grants.map(grantLine).join("\n") : "no grants")

/** One grant in full. */
export function grantText(g: Grant): string {
  const list = (values: readonly string[]) => (values.length ? values.join(", ") : "none")
  return [
    `${g.id}  ${g.state}`,
    `holder: ${g.holder}${g.holderSessionID && g.holderSessionID !== g.holder ? ` (${g.holderSessionID})` : ""}`,
    `projects: ${list(g.scope.projects)}`,
    `verbs: ${list(g.allow)}`,
    `permissions allow: ${list(g.permissions.allow)}`,
    `permissions never: ${list(g.permissions.never)}`,
    `always: ${g.allowAlways ? "yes" : "no"}`,
    `max actions per hour: ${g.maxActionsPerHour}`,
    g.revokedAt !== undefined ? `revoked: ${iso(g.revokedAt)}` : `expires: ${iso(g.expiresAt)}`,
  ].join("\n")
}
