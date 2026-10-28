// Test fixtures for the transactional applier (packages/cli/src/bootstrap/transaction). Owned by the transaction
// tests; the shared contract fixtures stay in ./fixtures.ts. Everything runs in a fresh temporary directory: a
// fake host with every named root mapped under it, so no test touches a real home, config or service directory.
import { generateKeyPairSync, sign } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  manifestPayload,
  planDigest,
  sha256Hex,
  verifyManifest,
  type Action,
  type ArtifactManifest,
  type JournalHooks,
  type PreviewToken,
  type RootMapping,
  type SetupPlan,
  type VerifiedManifest,
} from "../../src/bootstrap/contracts/index.ts"
import { builtinExecutors } from "../../src/bootstrap/transaction/builtin.ts"
import { createApplier, type Applier, type ApplierConfig, type FreshPlan } from "../../src/bootstrap/transaction/engine.ts"
import type { ActionExecutor, ExecutorMap } from "../../src/bootstrap/transaction/executor.ts"
import { nodeFs, type TxFs } from "../../src/bootstrap/transaction/fs.ts"
import { txFail, txOk } from "../../src/bootstrap/transaction/result.ts"
import { ACTIONS, HOST, MANIFEST_UNSIGNED, MINUTE, PREVIEW, SNAPSHOT_DIGEST, T0, TRUST_ROOT_TEMPLATE } from "./fixtures.ts"

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

// ---------- a whole fake host for apply tests ----------

const enc = (s: string) => new TextEncoder().encode(s)
export const digestOfText = (s: string) => `sha256:${sha256Hex(s)}`

export const HUBCTL_BYTES = "hubctl 0.8.0 darwin-arm64 binary"
export const NODE_JSON = '{\n  "roots": ["~/projects"]\n}\n'
export const SERVICE_UNIT = "<plist><string>/Users/dev/.local/bin/hubctl</string><string>node</string><string>run</string></plist>\n"
export const HARNESS_ARCHIVE = "opencode-2.0.26-darwin-arm64.zip bytes"
export const HARNESS_FILES = [
  { rel: "bin/opencode", text: "#!opencode 2.0.26", mode: 0o755 },
  { rel: "LICENSE", text: "MIT", mode: 0o644 },
] as const
export const OPENCODE_JSON = '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark",\n  "x-user-key": {"keep": true}\n}\n'
/** The previous machine credential (a stale one must never come back after a rollback). */
export const OLD_CREDENTIAL = { server: "https://old-hub.example", machineID: "mach_old", token: "mt_old_secret_token" }
export const NEW_TOKEN = "mt_new_secret_token"

let cachedManifest: VerifiedManifest | undefined

/** Signed once per test process with an ephemeral key (no key material is committed). */
function signedManifest(): VerifiedManifest {
  if (cachedManifest) return cachedManifest
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const body: Omit<ArtifactManifest, "signatures"> = {
    ...MANIFEST_UNSIGNED,
    artifacts: MANIFEST_UNSIGNED.artifacts.map((a) => (a.target === "darwin-arm64" ? { ...a, size: enc(HUBCTL_BYTES).byteLength, sha256: digestOfText(HUBCTL_BYTES) } : a)),
    harnesses: MANIFEST_UNSIGNED.harnesses.map((h) =>
      h.harness === "opencode" ? { ...h, size: enc(HARNESS_ARCHIVE).byteLength, sha256: digestOfText(HARNESS_ARCHIVE) } : h,
    ),
  }
  const manifest: ArtifactManifest = {
    ...body,
    signatures: [{ keyID: "hub-release-1", algorithm: "ed25519", value: sign(null, Buffer.from(manifestPayload(body)), privateKey).toString("base64") }],
  }
  const root = { ...TRUST_ROOT_TEMPLATE, keys: [{ ...TRUST_ROOT_TEMPLATE.keys[0]!, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }] }
  const verified = verifyManifest(manifest, root)
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues))
  cachedManifest = verified.value
  return verified.value
}

export interface WorldOptions {
  /** Seed an existing machine credential in config:hub/config.json. */
  readonly oldCredential?: boolean
  /** The hubctl download returns other bytes (a tampered mirror). */
  readonly tamperedHubctl?: boolean
  readonly tamperedHarness?: boolean
  readonly failedEvidence?: boolean
  /** verify-harness fails (harness_not_ready). */
  readonly verifyFails?: boolean
  /** v1.1: build the executors without a service manager client (deactivate-service then cannot run). */
  readonly noServiceControl?: boolean
}

/** A fake host: a sandbox with seeded user files, a signed manifest, the built-in executors and fakes for the rest. */
export class World {
  readonly box: Sandbox
  readonly manifest: VerifiedManifest
  readonly calls: string[] = []
  verifyFails: boolean
  private ids = 0
  private nonces = 0
  now = T0 + MINUTE

  constructor(readonly options: WorldOptions = {}) {
    this.box = sandbox()
    this.manifest = signedManifest()
    this.verifyFails = Boolean(options.verifyFails)
    mkdirSync(this.box.path("config", "opencode"), { recursive: true })
    writeFileSync(this.box.path("config", "opencode/opencode.json"), OPENCODE_JSON, { mode: 0o644 })
    if (options.oldCredential) {
      mkdirSync(this.box.path("config", "hub"), { recursive: true, mode: 0o700 })
      writeFileSync(this.box.path("config", "hub/config.json"), `${JSON.stringify({ ...OLD_CREDENTIAL, theme: "kept" }, null, 2)}\n`, { mode: 0o600 })
    }
  }

  cleanup() {
    this.box.cleanup()
  }

  /** The plan a fresh discovery of this host would produce now (preconditions from the disk). */
  plan(extra: { readonly actions?: readonly Action[]; readonly omit?: readonly string[] } = {}): SetupPlan {
    const opencode = this.box.path("config", "opencode/opencode.json")
    let precondition: { exists: boolean; sha256?: string } = { exists: false }
    try {
      precondition = { exists: true, sha256: digestOfText(readFileSync(opencode, "utf8")) }
    } catch {}
    const actions: Action[] = [
      ACTIONS["ensure-directory"],
      { ...(ACTIONS["install-artifact"] as Extract<Action, { kind: "install-artifact" }>), sha256: digestOfText(HUBCTL_BYTES) },
      ACTIONS["link-executable"],
      { ...(ACTIONS["write-file"] as Extract<Action, { kind: "write-file" }>), sha256: digestOfText(NODE_JSON) },
      { ...(ACTIONS["merge-config"] as Extract<Action, { kind: "merge-config" }>), precondition },
      { ...(ACTIONS["install-harness"] as Extract<Action, { kind: "install-harness" }>), size: enc(HARNESS_ARCHIVE).byteLength, sha256: digestOfText(HARNESS_ARCHIVE) },
      ACTIONS["select-harness-version"],
      ACTIONS["verify-harness"],
      { ...(ACTIONS["install-service"] as Extract<Action, { kind: "install-service" }>), sha256: digestOfText(SERVICE_UNIT) },
      ACTIONS["enroll-machine"],
      ACTIONS["activate-service"],
      ACTIONS["launch-session"],
      ...(extra.actions ?? []),
    ].filter((a) => !extra.omit?.includes(a.id))
    return {
      schema: "hub.setup-plan",
      version: 1,
      hostFingerprint: HOST,
      snapshotDigest: SNAPSHOT_DIGEST,
      target: "darwin-arm64",
      profile: { id: "launch-node", version: 2 },
      requiresEscalation: actions.some((a) => a.escalation === "elevated"),
      activatesServices: actions.some((a) => a.kind === "activate-service"),
      actions,
    }
  }

  token(plan: SetupPlan, patch: Partial<PreviewToken> = {}): PreviewToken {
    this.nonces++
    return { ...PREVIEW, planDigest: planDigest(plan), issuedAt: this.now - 1000, expiresAt: this.now + 10 * MINUTE, nonce: `nonce-${this.nonces}-0123456789abcdef`, ...patch }
  }

  /** apply's re-plan hook: a fresh plan from the disk as it is now. */
  replan(patch: (plan: SetupPlan) => SetupPlan = (p) => p, more: Partial<FreshPlan> = {}): () => Promise<FreshPlan> {
    return async () => ({ plan: patch(this.plan()), ...more })
  }

  executors(): ExecutorMap {
    const world = this
    const builtin = builtinExecutors({
      assets: (asset) => (asset === "config/node.json" ? enc(NODE_JSON) : undefined),
      renderService: (action) => (action.service === "node" && action.manager === "launchd" ? enc(SERVICE_UNIT) : undefined),
      hubctl: {
        manifest: this.manifest,
        fetch: async () => enc(this.options.tamperedHubctl ? `${HUBCTL_BYTES} (evil)` : HUBCTL_BYTES),
      },
      harness: {
        manifest: this.manifest,
        fetch: async () => ({
          bytes: enc(this.options.tamperedHarness ? `${HARNESS_ARCHIVE}!` : HARNESS_ARCHIVE),
          evidence: this.options.failedEvidence ? [{ kind: "sigstore", status: "failed" }] : [],
        }),
        unpack: async () => txOk(HARNESS_FILES.map((f) => ({ rel: f.rel, bytes: enc(f.text), mode: f.mode }))),
      },
      ...(this.options.noServiceControl
        ? {}
        : {
            services: {
              deactivate: async (service, manager) => (world.calls.push(`deactivate ${service} ${manager}`), txOk(undefined)),
              activate: async (service, manager) => (world.calls.push(`reactivate ${service} ${manager}`), txOk(undefined)),
            },
          }),
    })
    const enroll: ActionExecutor<"enroll-machine"> = {
      kind: "enroll-machine",
      plan: () => ({ class: "credential", path: { root: "config", rel: "hub/config.json" } }),
      change: async (action, ctx) => ({
        ok: true,
        value: {
          type: "effect",
          perform: async () => {
            // A fake CredentialStore: lossless merge, atomic write, 0600.
            const path = ctx.target!
            let raw: Record<string, unknown> = {}
            if (ctx.fs.lstat(path)) raw = JSON.parse(new TextDecoder().decode(ctx.fs.readFile(path)))
            const next = { ...raw, server: action.server, machineID: "mach_new", token: NEW_TOKEN }
            const dir = path.slice(0, path.lastIndexOf("/"))
            if (!ctx.fs.lstat(dir)) ctx.fs.mkdirp(dir, 0o700)
            writeCredentialFile(ctx.fs, path, next)
            world.calls.push(`enroll ${action.machineName}`)
            return txOk(undefined)
          },
        },
      }),
      undo: async (_action, ctx) => {
        const path = ctx.target!
        if (!ctx.fs.lstat(path)) return txOk(undefined)
        const raw = JSON.parse(new TextDecoder().decode(ctx.fs.readFile(path))) as Record<string, unknown>
        const { token: _t, machineID: _m, server: _s, ...rest } = raw
        writeCredentialFile(ctx.fs, path, rest)
        world.calls.push("clear-credential")
        return txOk(undefined)
      },
    }
    const external = <K extends "verify-harness" | "activate-service" | "launch-session">(kind: K, run: () => ReturnType<NonNullable<ActionExecutor<K>["undo"]>>, undo?: () => void): ActionExecutor<K> => ({
      kind,
      plan: () => ({ class: "external" }),
      change: async () => txOk({ type: "effect", perform: run }),
      ...(undo ? { undo: async () => (undo(), txOk(undefined)) } : {}),
    })
    return {
      ...builtin,
      "enroll-machine": enroll,
      "verify-harness": external("verify-harness", async () => {
        world.calls.push("verify opencode")
        return world.verifyFails ? txFail("harness_not_ready", "opencode provider-auth failed") : txOk(undefined)
      }),
      "activate-service": external(
        "activate-service",
        async () => (world.calls.push("activate node"), txOk(undefined)),
        () => world.calls.push("deactivate node"),
      ),
      "launch-session": external("launch-session", async () => (world.calls.push("launch opencode"), txOk(undefined))),
    }
  }

  applier(patch: Partial<ApplierConfig> = {}): Applier {
    return createApplier({
      roots: this.box.roots,
      host: { fingerprint: HOST, target: "darwin-arm64" },
      executors: this.executors(),
      now: () => this.now,
      pid: 4242,
      isAlive: () => true,
      newID: () => `tx_t${++this.ids}`,
      ...patch,
    })
  }

  /** Every entry under the sandbox (rel → kind, mode, digest), excluding the applier's own state directory. */
  snapshot(options: { includeBootstrapState?: boolean } = {}): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (abs: string, rel: string) => {
      for (const name of readdirSync(abs).sort()) {
        const a = `${abs}/${name}`
        const r = rel ? `${rel}/${name}` : name
        if (!options.includeBootstrapState && r === `${ROOT_DIRS.state}/hub/bootstrap`) continue
        const s = lstatSync(a)
        if (s.isSymbolicLink()) out[r] = `link ${readlinkSync(a).replace(this.box.dir, "<sandbox>")}`
        else if (s.isDirectory()) {
          // state:hub holds the applier's own lock and journal (contract LOCK_PATH), so it exists after any apply.
          if (r !== `${ROOT_DIRS.state}/hub`) out[r] = `dir ${(s.mode & 0o7777).toString(8)}`
          walk(a, r)
        } else out[r] = `file ${(s.mode & 0o7777).toString(8)} ${sha256Hex(readFileSync(a))}`
      }
    }
    walk(this.box.dir, "")
    return out
  }

  read(root: string, rel: string): string {
    return readFileSync(this.box.path(root, rel), "utf8")
  }

  /** Text of every journal this host has (to check that no secret ever reaches one). */
  journalTexts(): string[] {
    const dir = this.box.path("state", "hub/bootstrap/journal")
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    } catch {
      return []
    }
  }
}

/** The fake CredentialStore's atomic, owner-only write (it cleans its temporary file up when the write fails). */
function writeCredentialFile(fs: TxFs, path: string, value: unknown): void {
  const tmp = `${path}.cred.tmp`
  if (fs.lstat(tmp)) fs.unlink(tmp)
  try {
    fs.writeExclusive(tmp, `${JSON.stringify(value, null, 2)}\n`, 0o600)
    fs.rename(tmp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && fs.lstat(tmp)) fs.unlink(tmp)
    throw error
  }
}

/** Hooks that pause at a chosen step so a test can act "between steps". */
export function pauseAt(actionID: string, phase: "before" | "after" = "before"): { hooks: JournalHooks; reached: Promise<void>; resume: () => void } {
  let reach!: () => void
  let resume!: () => void
  const reached = new Promise<void>((r) => (reach = r))
  const gate = new Promise<void>((r) => (resume = r))
  const at = async (entry: { actionID: string; status: string }) => {
    if (entry.actionID !== actionID) return
    reach()
    await gate
  }
  return { hooks: phase === "before" ? { beforeAction: at } : { afterAction: at }, reached, resume }
}

// ---------- crash helpers ----------

/** Staging, temporary and set-aside files the applier owns, anywhere in the sandbox (the fake store's own excluded). */
export function stagingFiles(w: World): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`
      if (/\.hub-tx_|\.broken-/.test(name) || (name.endsWith(".tmp") && !name.endsWith(".cred.tmp"))) found.push(p)
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(w.box.dir)
  return found
}

export const CRASH_CONSENT = { confirmActivation: true } as const

/**
 * Runs an apply that is killed after `killAfter` filesystem mutations. Returns whether the fs died (it always
 * should); the apply itself may throw Killed or return a failure from its doomed rollback attempt.
 */
export async function killedApply(w: World, killAfter: number): Promise<boolean> {
  const fs = new FaultyFs(nodeFs, { killAfter })
  try {
    await w.applier({ fs }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
  } catch (error) {
    if (!(error instanceof Killed)) throw error
  }
  return fs.dead
}

/** A fresh process after a kill: another pid, and the killed one (4242) is dead. */
export const nextProcess = (w: World) => w.applier({ pid: 777, isAlive: (pid) => pid === 777 })

export const isCommitted = (w: World) => w.journalTexts().some((t) => t.includes('"state":"committed"'))
export const isStarted = (w: World) => w.journalTexts().some((t) => t.includes('"hub.transaction-journal"'))

/** How many mutations a run makes, and the host it leaves (to enumerate every kill point). */
export async function countMutations(options: WorldOptions = {}): Promise<{ ok: boolean; total: number; final: Record<string, string> }> {
  const w = new World(options)
  try {
    const fs = new FaultyFs(nodeFs)
    const r = await w.applier({ fs }).apply({ token: w.token(w.plan()), replan: w.replan(), consent: CRASH_CONSENT })
    return { ok: r.ok, total: fs.mutations, final: w.snapshot() }
  } finally {
    w.cleanup()
  }
}
