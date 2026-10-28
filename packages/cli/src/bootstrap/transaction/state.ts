// File states as the journal records them: existence, digest and mode, never contents. A symlink's digest is the
// digest of its target text; a harness install root (a directory tree) can be digested as a whole, so recovery can
// tell "exactly as we left it" from "the user changed something inside".
import { digestOf, sha256Hex, type FileState } from "../contracts/index.ts"
import type { TxFs } from "./fs.ts"

export const sha256Of = (data: Uint8Array | string): string => `sha256:${sha256Hex(data)}`

export function fileState(fs: TxFs, path: string, options: { readonly tree?: boolean } = {}): FileState {
  const info = fs.lstat(path)
  if (!info) return { exists: false }
  switch (info.kind) {
    case "file":
      return { exists: true, sha256: sha256Of(fs.readFile(path)), mode: info.mode }
    case "symlink":
      return { exists: true, symlink: true, sha256: sha256Of(fs.readlink(path)) }
    case "directory":
      return options.tree ? { exists: true, sha256: treeDigest(fs, path), mode: info.mode } : { exists: true, mode: info.mode }
    default:
      return { exists: true }
  }
}

/** Digest over every entry under `dir` (relative path, kind, mode, content or link digest), in sorted order. */
export function treeDigest(fs: TxFs, dir: string): string {
  const entries: unknown[] = []
  const walk = (abs: string, rel: string) => {
    for (const name of fs.readdir(abs).sort()) {
      const childAbs = `${abs}/${name}`
      const childRel = rel ? `${rel}/${name}` : name
      const info = fs.lstat(childAbs)
      if (!info) continue
      if (info.kind === "directory") {
        entries.push({ rel: childRel, kind: "directory", mode: info.mode })
        walk(childAbs, childRel)
      } else if (info.kind === "file") entries.push({ rel: childRel, kind: "file", mode: info.mode, sha256: sha256Of(fs.readFile(childAbs)) })
      else if (info.kind === "symlink") entries.push({ rel: childRel, kind: "symlink", sha256: sha256Of(fs.readlink(childAbs)) })
      else entries.push({ rel: childRel, kind: "other" })
    }
  }
  walk(dir, "")
  return digestOf({ kind: "hub.tree", entries })
}

/** The journal's notion of "the same file" (recoveryDecision uses the same rule). */
export const sameState = (a: FileState, b: FileState): boolean =>
  a.exists === b.exists &&
  (a.sha256 ?? null) === (b.sha256 ?? null) &&
  (a.mode === undefined || b.mode === undefined || a.mode === b.mode) &&
  Boolean(a.symlink) === Boolean(b.symlink)
