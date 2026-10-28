// Test fixtures for the transactional applier (packages/cli/src/bootstrap/transaction). Owned by the transaction
// tests; the shared contract fixtures stay in ./fixtures.ts. Everything runs in a fresh temporary directory: a
// fake host with every named root mapped under it, so no test touches a real home, config or service directory.
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RootMapping } from "../../src/bootstrap/contracts/index.ts"
import { nodeFs, type TxFs } from "../../src/bootstrap/transaction/fs.ts"

export interface Sandbox {
  readonly dir: string
  readonly roots: RootMapping[]
  readonly path: (root: string, rel: string) => string
  cleanup(): void
}

export const ROOT_DIRS: Record<string, string> = {
  home: "home",
  config: "home/.config",
  state: "home/.local/state",
  data: "home/.local/share",
  "user-bin": "home/.local/bin",
  "launch-agents": "home/Library/LaunchAgents",
  "system-bin": "usr/local/bin",
}

/** A fresh fake host. Root directories are created except those listed in `missing`. */
export function sandbox(options: { missing?: readonly string[] } = {}): Sandbox {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hub-tx-")))
  const roots: RootMapping[] = []
  for (const [id, rel] of Object.entries(ROOT_DIRS)) {
    const path = join(dir, rel)
    if (!options.missing?.includes(id)) nodeFs.mkdirp(path, 0o755)
    roots.push({ id: id as RootMapping["id"], path })
  }
  return {
    dir,
    roots,
    path: (root, rel) => `${roots.find((r) => r.id === root)!.path}/${rel}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export class Killed extends Error {
  constructor() {
    super("killed (simulated crash)")
  }
}

const MUTATIONS = ["writeExclusive", "rename", "link", "unlink", "mkdir", "rmdir", "symlink", "chmod"] as const
type Mutation = (typeof MUTATIONS)[number]

/**
 * A TxFs that fails on purpose.
 *   killAfter: after this many mutations every further call throws Killed, reads included: the process is dead,
 *     so nothing (no catch block, no rollback) can touch the disk any more. The disk is left exactly as a kill
 *     at that boundary would leave it.
 *   enospcAt: the mutation with this number (1-based) of the given kinds fails with ENOSPC; later ones work.
 */
export class FaultyFs implements TxFs {
  mutations = 0
  dead = false
  readonly log: string[] = []

  constructor(
    private readonly inner: TxFs,
    private readonly faults: { killAfter?: number; enospcAt?: number; enospcOn?: readonly Mutation[] } = {},
  ) {}

  private alive() {
    if (this.dead) throw new Killed()
  }

  private mutate(op: Mutation, path: string) {
    this.alive()
    if (this.faults.killAfter !== undefined && this.mutations >= this.faults.killAfter) {
      this.dead = true
      throw new Killed()
    }
    this.mutations++
    this.log.push(`${op} ${path}`)
    if (this.faults.enospcAt === this.mutations && (!this.faults.enospcOn || this.faults.enospcOn.includes(op))) {
      const error = new Error(`ENOSPC: no space left on device, ${op} '${path}'`) as NodeJS.ErrnoException
      error.code = "ENOSPC"
      throw error
    }
  }

  lstat(path: string) {
    this.alive()
    return this.inner.lstat(path)
  }
  readFile(path: string) {
    this.alive()
    return this.inner.readFile(path)
  }
  readlink(path: string) {
    this.alive()
    return this.inner.readlink(path)
  }
  readdir(path: string) {
    this.alive()
    return this.inner.readdir(path)
  }
  writeExclusive(path: string, data: Uint8Array | string, mode: number) {
    this.mutate("writeExclusive", path)
    this.inner.writeExclusive(path, data, mode)
  }
  rename(from: string, to: string) {
    this.mutate("rename", to)
    this.inner.rename(from, to)
  }
  link(from: string, to: string) {
    this.mutate("link", to)
    this.inner.link(from, to)
  }
  unlink(path: string) {
    this.mutate("unlink", path)
    this.inner.unlink(path)
  }
  mkdir(path: string, mode: number) {
    this.mutate("mkdir", path)
    this.inner.mkdir(path, mode)
  }
  mkdirp(path: string, mode: number) {
    this.alive()
    // Each created level counts as one mkdir.
    const missing: string[] = []
    for (let p = path; p !== "/" && !this.inner.lstat(p); p = p.slice(0, p.lastIndexOf("/")) || "/") missing.unshift(p)
    for (const p of missing) this.mkdir(p, mode)
  }
  rmdir(path: string) {
    this.mutate("rmdir", path)
    this.inner.rmdir(path)
  }
  symlink(target: string, path: string) {
    this.mutate("symlink", path)
    this.inner.symlink(target, path)
  }
  chmod(path: string, mode: number) {
    this.mutate("chmod", path)
    this.inner.chmod(path, mode)
  }
  fsyncDir(path: string) {
    this.alive()
    this.inner.fsyncDir(path)
  }
}
