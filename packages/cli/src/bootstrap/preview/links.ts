// Symlink facts for the paths a plan would write, read through the probe (lstat and realpath only).
import type { DiscoverySnapshot } from "../contracts/index.ts"
import type { DiscoveryProbe } from "../discovery/probe.ts"
import { join, normalizeAbs } from "../discovery/util.ts"
import type { LinkInspector } from "./plan.ts"

/** Link facts read through the probe (lstat/realpath only), against the in-container view of each root. */
export function inspectLinks(probe: DiscoveryProbe, snapshot: DiscoverySnapshot): LinkInspector {
  return (ref) => {
    const root = snapshot.roots.find((r) => r.id === ref.root)
    if (!root) return undefined
    const base = root.containerPath ?? root.path
    const parts = ref.rel.split("/")
    let current = base
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!)
      const kind = probe.lstat(current)
      if (kind === "missing") return undefined
      if (kind !== "symlink") continue
      // The edit belongs in the file the link leads to: the deepest existing part, resolved, plus the rest.
      const rest = parts.slice(i + 1)
      for (let k = rest.length; k >= 0; k--) {
        const real = normalizeAbs(probe.realpath([current, ...rest.slice(0, k)].join("/")))
        if (real) return { linkPath: current, resolvedPath: [real, ...rest.slice(k)].join("/").replace(/^\/\//, "/") }
      }
      return { linkPath: current, resolvedPath: [current, ...rest].join("/") }
    }
    return undefined
  }
}
