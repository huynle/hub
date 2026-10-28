// PathRef → absolute path on this host, refusing anything a planted link or a crafted reference could redirect:
// traversal and unsafe relative paths (the contract's PathRef rules), unmapped roots, any symlink between the root
// and the target (checkNoSymlinkEscape), and a regular file where a directory should be. The root itself is the
// mapping discovery reported and is not checked (contract: paths.ts). v1.1: paths resolve for the execution context
// apply runs in (contract rootPathIn: inside a container, a root is containerPath ?? path; on the host, path).
import { checkNoSymlinkEscape, resolvePathRef, rootPathIn, type ExecutionContext, type PathRef, type RootMapping } from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"
import { txFail, txOk, type TxResult } from "./result.ts"

export interface ResolveOptions {
  /** link-executable manages a symlink at the final component; every component above it is still checked. */
  readonly finalMayBeSymlink?: boolean
  /** Where apply runs (default: the host). */
  readonly context?: ExecutionContext
}

/** The absolute directory of a root for the execution context, if the host has it. */
export function rootDir(id: PathRef["root"], roots: readonly RootMapping[], context: ExecutionContext = "host"): string | undefined {
  const root = roots.find((r) => r.id === id)
  return root ? rootPathIn(root, context) : undefined
}

export function resolveTarget(ref: PathRef, roots: readonly RootMapping[], fs: TxFs, options: ResolveOptions = {}): TxResult<string> {
  const resolved = resolvePathRef(ref, roots, options.context)
  if (!resolved.ok) return txFail("invalid", `${ref.root}:${String(ref.rel)}: ${resolved.issues[0]!.message}`)
  const root = rootDir(ref.root, roots, options.context)!
  const parts = ref.rel.split("/")
  const checked = options.finalMayBeSymlink ? parts.slice(0, -1).join("/") : ref.rel
  if (checked) {
    const walk = checkNoSymlinkEscape(root, checked, (p) => fs.lstat(p)?.kind ?? "missing")
    if (!walk.ok) return txFail("conflict", `${walk.issues[0]!.message} (make this change by hand)`)
  }
  // Every component above the target that exists must be a directory.
  let current = root === "/" ? "" : root
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`
    const info = fs.lstat(current)
    if (!info) break
    if (info.kind !== "directory") return txFail("conflict", `${current} is not a directory`)
  }
  return txOk(resolved.value)
}
