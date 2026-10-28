// PathRef → absolute path on this host, refusing anything a planted link or a crafted reference could redirect:
// traversal and unsafe relative paths (the contract's PathRef rules), unmapped roots, any symlink between the root
// and the target (checkNoSymlinkEscape), and a regular file where a directory should be. The root itself is the
// mapping discovery reported and is not checked (contract: paths.ts).
import { checkNoSymlinkEscape, resolvePathRef, type PathRef, type RootMapping } from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"
import { txFail, txOk, type TxResult } from "./result.ts"

export interface ResolveOptions {
  /** link-executable manages a symlink at the final component; every component above it is still checked. */
  readonly finalMayBeSymlink?: boolean
}

export function resolveTarget(ref: PathRef, roots: readonly RootMapping[], fs: TxFs, options: ResolveOptions = {}): TxResult<string> {
  const resolved = resolvePathRef(ref, roots)
  if (!resolved.ok) return txFail("invalid", `${ref.root}:${String(ref.rel)}: ${resolved.issues[0]!.message}`)
  const root = roots.find((r) => r.id === ref.root)!.path
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
