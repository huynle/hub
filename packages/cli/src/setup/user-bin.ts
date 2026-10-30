// The user-bin link rule (contract §7.6 A6, HBS-12 E4), shared by the setup's harness links (contributors.ts) and
// the OpenCode plugin's `hub` link (src/spoke/launchers.ts): hub links a command into user-bin (~/.local/bin) only
// when nothing is there or what is there is a link of hub's own, and only when no other command of that name is on
// PATH. A user's binary is never shadowed or replaced. Pure: callers read the facts (lstat, readlink, PATH).

/** What is at the link path now, not following a final symlink. */
export type UserBinEntry = "missing" | "file" | "directory" | "symlink" | "other"

/**
 * - in-place: the link is already there, pointing at the target.
 * - create: nothing there: link it.
 * - replace: a link of hub's own pointing elsewhere: re-point it.
 * - foreign: something of the user's is there: leave it.
 * - shadowed: another command of that name comes first on PATH: leave it.
 */
export type UserBinLinkDecision = "in-place" | "create" | "replace" | "foreign" | "shadowed"

export interface UserBinLinkFacts {
  readonly entry: UserBinEntry
  /** The absolute path a symlink at the link path points to. */
  readonly pointsTo?: string
  /** The absolute path the link should point to. */
  readonly target: string
  /** The link path itself. */
  readonly linkPath: string
  /** Whether a link pointing here is hub's own (its harness directory, its launchers). */
  readonly hubOwned: (pointsTo: string) => boolean
  /** The first command of that name on PATH, as found (not followed); undefined when none. */
  readonly foundOnPath?: string
}

export function userBinLinkDecision(facts: UserBinLinkFacts): UserBinLinkDecision {
  const { entry, pointsTo } = facts
  if (entry === "symlink" && pointsTo === facts.target) return "in-place"
  const hubOwned = entry === "symlink" && pointsTo !== undefined && facts.hubOwned(pointsTo)
  if (entry !== "missing" && !hubOwned) return "foreign"
  if (facts.foundOnPath !== undefined && facts.foundOnPath !== facts.linkPath) return "shadowed"
  return entry === "missing" ? "create" : "replace"
}
