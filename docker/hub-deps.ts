// Docker build helper: copies the hub's runtime packages (and everything they depend on, as resolved by the
// lockfile install in ./node_modules) into <out>/node_modules. The plugin-only @opencode/* packages are left out.
//   bun docker/hub-deps.ts /deps web-push
import { cpSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"

const [out, ...roots] = process.argv.slice(2)
if (!out || roots.length === 0) throw new Error("usage: hub-deps.ts <out-dir> <package>...")
const top = path.resolve("node_modules")

/** Node resolution: nearest node_modules/<name> walking up from `from`, stopping at the project root. */
function resolve(from: string, name: string): string {
  for (let dir = from; dir.startsWith(top); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name)
    if (existsSync(path.join(candidate, "package.json"))) return candidate
  }
  const candidate = path.join(top, name)
  if (existsSync(path.join(candidate, "package.json"))) return candidate
  throw new Error(`cannot resolve ${name} from ${from}`)
}

const seen = new Set<string>()
const queue = roots.map((name) => resolve(top, name))
while (queue.length) {
  const dir = queue.pop()!
  if (seen.has(dir)) continue
  seen.add(dir)
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    try {
      queue.push(resolve(dir, name))
    } catch (cause) {
      if (!pkg.optionalDependencies?.[name]) throw cause
    }
  }
}

// Copy outermost package directories only; nested node_modules come along with their parent.
const dirs = [...seen].sort()
const outer = dirs.filter((dir) => !dirs.some((other) => other !== dir && dir.startsWith(other + path.sep)))
for (const dir of outer) cpSync(dir, path.join(out, "node_modules", path.relative(top, dir)), { recursive: true })
console.log(`hub deps: ${outer.length} packages → ${out}/node_modules`)
