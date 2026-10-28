// What `hubctl setup` keeps between commands (HBS-13 integration item 7). Everything is secret-free, validated when
// read and written, and reached only through symlink-checked paths under the state root (next to the applier's own
// journal, contract LOCK_PATH):
//
//   the setup request    `setup preview --out <file>`: the SetupPreview plus the profile and choices apply must
//                        re-plan with, so `setup apply --preview <file>` needs nothing else (the Ansible role's argv)
//   state:hub/bootstrap/state.json
//                        the applied profile, its choices and catalog revision, the last committed transaction and
//                        plan digest, and the security floors this machine has seen (hubctl and each harness's
//                        pinned minimumVersion), which only rise
//   state:hub/bootstrap/requests/<hex>.json
//                        the request each applied plan was made from, by plan digest (resume, drift and verify
//                        re-plan from it); the plan itself is the engine's journal/<txID>.plan.json
//
// The journals stay the record of used preview nonces (the engine reads them).
import {
  bool,
  Checker,
  compareVersions,
  digest,
  ENROLLMENT_MODES,
  findSecrets,
  HARNESS_ORDER,
  header,
  int,
  isRecord,
  oneOf,
  semver,
  shape,
  text,
  validatePathRef,
  validateSetupPreview,
  type ArtifactManifest,
  type EnrollmentMode,
  type HarnessID,
  type PathRef,
  type Profile,
  type Result,
  type RootMapping,
  type SetupPreview,
} from "../bootstrap/contracts/index.ts"
import { loadProfile } from "../bootstrap/profiles/versions.ts"
import { nodeFs, type TxFs } from "../bootstrap/transaction/fs.ts"
import { resolveTarget } from "../bootstrap/transaction/resolve.ts"
import { errnoOf } from "../bootstrap/transaction/result.ts"

export const SETUP_REQUEST_SCHEMA = "hub.setup-request"
export const BOOTSTRAP_STATE_SCHEMA = "hub.bootstrap-state"

/** What the user chose at preview, besides the profile; apply re-plans with exactly these. */
export interface SetupChoices {
  /** Inline (a planned enroll-machine, with `server`) or separate (`hubctl machine enroll`). */
  readonly enrollment?: EnrollmentMode
  /** --confirm-activation at preview: plan loading the services (apply needs the flag again). */
  readonly activate?: boolean
  /** --allow-downgrade at preview (apply needs the flag again). */
  readonly allowDowngrade?: boolean
  /** node.json settings for a launch node. */
  readonly node?: { readonly workspaceRoots: readonly string[]; readonly slots?: number; readonly labels?: Readonly<Record<string, string>> }
  /** One bounded verification launch. */
  readonly launch?: { readonly harness: HarnessID; readonly workspace: PathRef }
  /** The hub to enroll with inline. */
  readonly server?: string
  readonly machineName?: string
}

export interface SetupRequest {
  readonly schema: typeof SETUP_REQUEST_SCHEMA
  readonly version: 1
  readonly preview: SetupPreview
  readonly profile: Profile
  readonly choices: SetupChoices
}

export interface Floors {
  readonly hubctl?: string
  readonly harnesses: Partial<Record<HarnessID, string>>
}

export interface BootstrapState {
  readonly schema: typeof BOOTSTRAP_STATE_SCHEMA
  readonly version: 1
  /** The profile of the last committed apply. */
  readonly profile?: Profile
  readonly choices?: SetupChoices
  /** The built-in catalog revision that profile was made from (profile.revision). */
  readonly catalogRevision?: number
  readonly txID?: string
  readonly planDigest?: string
  readonly floors: Floors
}

const EMPTY: BootstrapState = { schema: BOOTSTRAP_STATE_SCHEMA, version: 1, floors: { harnesses: {} } }

function checkChoices(c: Checker, path: string, value: unknown): void {
  const r = shape(c, path, value, [], ["enrollment", "activate", "allowDowngrade", "node", "launch", "server", "machineName"])
  if (!r) return
  oneOf(c, `${path}/enrollment`, r.enrollment, ENROLLMENT_MODES)
  bool(c, `${path}/activate`, r.activate)
  bool(c, `${path}/allowDowngrade`, r.allowDowngrade)
  if (r.node !== undefined) {
    const n = shape(c, `${path}/node`, r.node, ["workspaceRoots"], ["slots", "labels"])
    if (n) {
      if (!Array.isArray(n.workspaceRoots) || n.workspaceRoots.length > 64) c.add(`${path}/node/workspaceRoots`, "invalid_value", "expected a list of at most 64 paths")
      else n.workspaceRoots.forEach((w, i) => text(c, `${path}/node/workspaceRoots/${i}`, w, 4096))
      int(c, `${path}/node/slots`, n.slots, 1, 64)
      if (n.labels !== undefined && (!isRecord(n.labels) || Object.values(n.labels).some((v) => typeof v !== "string"))) c.add(`${path}/node/labels`, "invalid_value", "labels are strings")
    }
  }
  if (r.launch !== undefined) {
    const l = shape(c, `${path}/launch`, r.launch, ["harness", "workspace"])
    if (l) {
      oneOf(c, `${path}/launch/harness`, l.harness, HARNESS_ORDER)
      c.merge(`${path}/launch/workspace`, validatePathRef(l.workspace))
    }
  }
  text(c, `${path}/server`, r.server, 2048)
  text(c, `${path}/machineName`, r.machineName, 64)
}

/** A setup request read back from a file: validated, never cast; the profile is migrated to the current version. */
export function validateSetupRequest(value: unknown): Result<SetupRequest> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "preview", "profile", "choices"])
  if (!r) return c.result(undefined)
  header(c, "", r, SETUP_REQUEST_SCHEMA, 1)
  c.merge("/preview", validateSetupPreview(r.preview))
  const profile = loadProfile(r.profile)
  c.merge("/profile", profile)
  checkChoices(c, "/choices", r.choices)
  // The preview is checked by its own validator (its token field is a preview token, not a credential).
  for (const p of findSecrets({ profile: r.profile, choices: r.choices })) c.add(p, "secret", "setup requests never carry credentials")
  if (c.issues.length > 0) return c.result(undefined)
  return c.result({ ...r, profile: profile.ok ? profile.value.profile : r.profile })
}

function validateState(value: unknown): Result<BootstrapState> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "floors"], ["profile", "choices", "catalogRevision", "txID", "planDigest"])
  if (!r) return c.result(undefined)
  header(c, "", r, BOOTSTRAP_STATE_SCHEMA, 1)
  if (r.profile !== undefined) c.merge("/profile", loadProfile(r.profile))
  if (r.choices !== undefined) checkChoices(c, "/choices", r.choices)
  int(c, "/catalogRevision", r.catalogRevision, 1, 1_000_000)
  text(c, "/txID", r.txID, 64, /^tx_[A-Za-z0-9_-]+$/)
  if (r.planDigest !== undefined) digest(c, "/planDigest", r.planDigest)
  const f = shape(c, "/floors", r.floors, ["harnesses"], ["hubctl"])
  if (f) {
    if (f.hubctl !== undefined) semver(c, "/floors/hubctl", f.hubctl)
    const h = shape(c, "/floors/harnesses", f.harnesses, [], HARNESS_ORDER)
    if (h) for (const id of HARNESS_ORDER) if (h[id] !== undefined) semver(c, `/floors/harnesses/${id}`, h[id])
  }
  for (const p of findSecrets(value)) c.add(p, "secret", "the bootstrap state never carries credentials")
  return c.result(value)
}

const max = (a: string | undefined, b: string | undefined) => (a === undefined ? b : b === undefined ? a : compareVersions(a, b) >= 0 ? a : b)

/** The floors after seeing a verified manifest: the highest of what was seen and what it pins for `target`. */
export function raiseFloors(floors: Floors, manifest: Pick<ArtifactManifest, "minimumVersion" | "harnesses">, target: string): Floors {
  const harnesses: Partial<Record<HarnessID, string>> = { ...floors.harnesses }
  for (const pin of manifest.harnesses) if (pin.target === target && pin.minimumVersion) harnesses[pin.harness] = max(harnesses[pin.harness], pin.minimumVersion)
  const hubctl = max(floors.hubctl, manifest.minimumVersion)
  return { ...(hubctl ? { hubctl } : {}), harnesses }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export class BootstrapStateStore {
  readonly statePath: string
  private readonly requestDir: string

  constructor(
    private readonly roots: readonly RootMapping[],
    private readonly fs: TxFs = nodeFs,
  ) {
    const state = this.resolve("hub/bootstrap/state.json")
    this.statePath = state
    this.requestDir = `${state.slice(0, state.lastIndexOf("/"))}/requests`
  }

  private resolve(rel: string): string {
    const r = resolveTarget({ root: "state", rel }, this.roots, this.fs)
    if (!r.ok) throw new Error(`the hub state directory is unusable: ${r.message}`)
    return r.value
  }

  read(): BootstrapState {
    const info = this.fs.lstat(this.resolve("hub/bootstrap/state.json"))
    if (!info) return EMPTY
    let parsed: unknown
    try {
      parsed = JSON.parse(decode(this.fs.readFile(this.statePath)))
    } catch {
      throw new Error(`the bootstrap state ${this.statePath} cannot be read; inspect it before setting up again`)
    }
    const checked = validateState(parsed)
    if (!checked.ok) throw new Error(`the bootstrap state ${this.statePath} is not valid (${checked.issues[0]!.message})`)
    return checked.value
  }

  write(state: BootstrapState): void {
    const checked = validateState(state)
    if (!checked.ok) throw new Error(`refusing to write an invalid bootstrap state: ${checked.issues[0]!.path} ${checked.issues[0]!.message}`)
    this.writeAtomic(this.resolve("hub/bootstrap/state.json"), state)
  }

  /** Records the request a plan was made from, under its plan digest. */
  writeRequest(request: SetupRequest): void {
    const checked = validateSetupRequest(request)
    if (!checked.ok) throw new Error(`refusing to store an invalid setup request: ${checked.issues[0]!.message}`)
    this.writeAtomic(this.resolve(`hub/bootstrap/requests/${request.preview.planDigest.slice("sha256:".length)}.json`), request)
  }

  readRequest(planDigest: string): SetupRequest | undefined {
    if (!/^sha256:[0-9a-f]{64}$/.test(planDigest)) return undefined
    const path = this.resolve(`hub/bootstrap/requests/${planDigest.slice("sha256:".length)}.json`)
    if (!this.fs.lstat(path)) return undefined
    try {
      const r = validateSetupRequest(JSON.parse(decode(this.fs.readFile(path))))
      return r.ok && r.value.preview.planDigest === planDigest ? r.value : undefined
    } catch {
      return undefined
    }
  }

  private writeAtomic(path: string, value: unknown): void {
    const dir = path.slice(0, path.lastIndexOf("/"))
    if (!this.fs.lstat(dir)) this.fs.mkdirp(dir, 0o700)
    else if (this.fs.lstat(dir)?.kind !== "directory") throw new Error(`${dir} is not a directory`)
    const tmp = `${path}.tmp`
    try {
      if (this.fs.lstat(tmp)) this.fs.unlink(tmp)
      this.fs.writeExclusive(tmp, `${JSON.stringify(value, null, 2)}\n`, 0o600)
      this.fs.rename(tmp, path)
      this.fs.fsyncDir(dir)
    } catch (error) {
      try {
        if (this.fs.lstat(tmp)) this.fs.unlink(tmp)
      } catch {}
      throw errnoOf(error) ? new Error(`cannot write ${path} (${errnoOf(error)})`) : error
    }
  }
}
