// Where the bootstrap may touch the filesystem. Plans never carry absolute paths: every path is a PathRef, a named
// root plus a relative path inside it. Discovery maps each root to this host's absolute directory; a relative path
// can never climb out of its root ("..", absolute, backslashes, NUL), and the applier refuses to write through any
// symlink between the root and the target (checkNoSymlinkEscape), so a planted link cannot redirect a write.
import { Checker, fail, isAbsolutePath, ok, oneOf, pointer, shape, type Result } from "./validate.ts"

export const ROOT_IDS = ["home", "config", "state", "data", "user-bin", "launch-agents", "systemd-user", "system-bin"] as const
export type RootID = (typeof ROOT_IDS)[number]

/**
 * Roots that need explicit escalation to write. Everything else is the user's own directories; the default
 * install is unprivileged.
 */
export const ELEVATED_ROOTS: readonly RootID[] = ["system-bin"]

export interface PathRef {
  readonly root: RootID
  /** Relative, "/"-separated, inside the root. */
  readonly rel: string
}

/** A root as discovery found it on this host (and where a container sees it, when the host is a container). */
export interface RootMapping {
  readonly id: RootID
  readonly path: string
  readonly containerPath?: string
}

// eslint-disable-next-line no-control-regex
const BAD_REL = /[\u0000-\u001f\u007f\\]/

export function isSafeRel(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024 || rel.startsWith("/") || BAD_REL.test(rel)) return false
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.length <= 255)
}

export function checkPathRef(c: Checker, path: string, value: unknown): value is PathRef {
  const r = shape(c, path, value, ["root", "rel"])
  if (!r) return false
  const rootOK = oneOf(c, pointer(path, "root"), r.root, ROOT_IDS)
  const relOK = isSafeRel(r.rel)
  if (!relOK && r.rel !== undefined) c.add(pointer(path, "rel"), "invalid_path", "expected a relative path inside the root (no '..', '/', '\\' or control characters)")
  return rootOK && relOK
}

export function validatePathRef(value: unknown): Result<PathRef> {
  const c = new Checker()
  checkPathRef(c, "", value)
  return c.result(value)
}

/**
 * v1.1: where the code that resolves a path runs. `path` is always the host's view of a root; `containerPath` is
 * what a process inside the container sees (discovery records it only when it ran inside one). hubctl resolves
 * paths for the context it runs in: inside the container, a root is `containerPath ?? path`; on the host, `path`.
 */
export const EXECUTION_CONTEXTS = ["host", "container"] as const
export type ExecutionContext = (typeof EXECUTION_CONTEXTS)[number]

/** The absolute directory of `root` as seen from `context`. */
export const rootPathIn = (root: RootMapping, context: ExecutionContext): string => (context === "container" ? (root.containerPath ?? root.path) : root.path)

/** The absolute path of `ref` on a host with these roots, as seen from `context` (default: the host). */
export function resolvePathRef(ref: PathRef, roots: readonly RootMapping[], context: ExecutionContext = "host"): Result<string> {
  const checked = validatePathRef(ref)
  if (!checked.ok) return checked as Result<string>
  const root = roots.find((r) => r.id === ref.root)
  const base = root ? rootPathIn(root, context) : undefined
  if (!base || !isAbsolutePath(base)) return fail("/root", "unmapped_root", `this host has no ${ref.root} root`)
  return ok(base === "/" ? `/${ref.rel}` : `${base}/${ref.rel}`)
}

export type EntryKind = "file" | "directory" | "symlink" | "missing" | "other"

/**
 * Walks from `rootAbs` to `rootAbs/rel` with `lstat` (which must not follow links) and fails at the first symlink. A missing component ends the walk: the rest would be created. The root itself is the
 * mapping discovery reported and is not checked here.
 */
export function checkNoSymlinkEscape(rootAbs: string, rel: string, lstat: (path: string) => EntryKind): Result<string> {
  if (!isAbsolutePath(rootAbs)) return fail("", "invalid_path", "the root must be an absolute, normalized path")
  if (!isSafeRel(rel)) return fail("", "invalid_path", "expected a relative path inside the root")
  const parts = rel.split("/")
  let current = rootAbs === "/" ? "" : rootAbs
  for (const part of parts) {
    current = `${current}/${part}`
    const kind = lstat(current)
    if (kind === "symlink") return fail("", "symlink", `${current} is a symbolic link; refusing to write through it`)
    if (kind === "missing") break
  }
  return ok(rootAbs === "/" ? `/${rel}` : `${rootAbs}/${rel}`)
}
