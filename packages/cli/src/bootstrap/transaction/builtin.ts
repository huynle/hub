// The built-in executors: the local file, config and directory steps, plus the two artifact installs whose bytes
// must be authenticated before use. Each only computes what the target should become; the engine stages, journals
// and replaces it atomically.
//
//   ensure-directory   a directory (an existing directory is left as it is)
//   write-file         an embedded/rendered asset whose bytes must match the plan's digest; never overwrites
//   merge-config       a lossless JSON merge, only if the file is still as previewed (precondition digest)
//   link-executable    the hub ↔ hubctl alias symlink (an existing entry is backed up and replaced)
//   install-service    the rendered unit, whose bytes must match the plan's digest
//   install-artifact   hubctl from a verified manifest: exact target, pinned digest, downgrade policy, bytes checked
//   install-harness    a harness pinned by the verified manifest: checkHarnessPin, downgrade policy, the pinned
//                      digest of the download first, then the upstream evidence, then the adapter's unpacker
//
// Fetching and unpacking come from injected, typed sources (no shell, no generic exec); verification always
// happens here, so a source cannot skip it.
import {
  checkArtifactBytes,
  checkHarnessEvidence,
  checkHarnessPin,
  decideHarnessInstall,
  decideInstall,
  isSafeRel,
  selectArtifact,
  type ArtifactEntry,
  type EvidenceResult,
  type HarnessID,
  type InstallHarness,
  type InstallService,
  type VerifiedManifest,
} from "../contracts/index.ts"
import type { ActionExecutor, ExecutorMap, StepContext, TreeFile } from "./executor.ts"
import { mergeConfigText } from "./json-merge.ts"
import { fromResult, txFail, txOk, type TxResult } from "./result.ts"
import { sha256Of } from "./state.ts"

export interface HubctlSource {
  /** The release manifest, already verified against the shipped trust root. */
  readonly manifest: VerifiedManifest
  /** Downloads the release file for `entry` (bytes only; the executor checks them). */
  fetch(entry: ArtifactEntry): Promise<Uint8Array>
  /** The hubctl currently installed, if any (downgrade policy). */
  readonly installed?: { readonly version: string; readonly sha256: string }
  /** The highest security floor this machine has seen. */
  readonly floor?: string
  /** Explicit --allow-downgrade. */
  readonly allowDowngrade?: boolean
}

export interface HarnessSource {
  readonly manifest: VerifiedManifest
  /** Downloads the pinned file and runs the upstream evidence checks the action lists (adapter-specific). */
  fetch(action: InstallHarness): Promise<{ readonly bytes: Uint8Array; readonly evidence: readonly EvidenceResult[] }>
  /** Unpacks verified bytes into the install tree (adapter-specific; pure: no writes). */
  unpack(action: InstallHarness, bytes: Uint8Array): Promise<TxResult<readonly TreeFile[]>>
  installed?(harness: HarnessID): { readonly version: string; readonly sha256: string } | undefined
  floor?(harness: HarnessID): string | undefined
  readonly allowDowngrade?: boolean
}

export interface BuiltinDeps {
  /** Embedded or rendered assets by id (write-file). */
  readonly assets?: (asset: string) => Uint8Array | undefined
  /** The rendered unit for an install-service action (HBS-13 renders EMBEDDED_ASSETS with serviceArgv). */
  readonly renderService?: (action: InstallService) => Uint8Array | undefined
  readonly hubctl?: HubctlSource
  readonly harness?: HarnessSource
}

const ok = txOk(undefined)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export const ensureDirectoryExecutor = (): ActionExecutor<"ensure-directory"> => ({
  kind: "ensure-directory",
  plan: (action) => ({ class: "directory", path: action.path }),
  change: async (action) => txOk({ type: "directory", mode: action.mode }),
})

/** Bytes whose digest must equal the plan's pin. */
function pinned(bytes: Uint8Array | undefined, sha256: string, what: string): TxResult<Uint8Array> {
  if (!bytes) return txFail("not_found", `${what} is not available in this hubctl`)
  if (sha256Of(bytes) !== sha256) return txFail("integrity_mismatch", `${what} does not match the digest in the plan`)
  return txOk(bytes)
}

export const writeFileExecutor = (assets: BuiltinDeps["assets"] = () => undefined): ActionExecutor<"write-file"> => ({
  kind: "write-file",
  plan: (action) => ({ class: "file", path: action.path }),
  check: async (action) => {
    const r = pinned(assets(action.asset), action.sha256, `asset ${action.asset}`)
    return r.ok ? ok : r
  },
  change: async (action) => {
    const r = pinned(assets(action.asset), action.sha256, `asset ${action.asset}`)
    return r.ok ? txOk({ type: "file", bytes: r.value, mode: action.mode, replace: "refuse" }) : r
  },
})

function preconditionHolds(ctx: StepContext, precondition: { readonly exists: boolean; readonly sha256?: string }): boolean {
  const o = ctx.original
  if (o.symlink) return false
  return precondition.exists ? o.exists && o.sha256 === precondition.sha256 : !o.exists
}

export const mergeConfigExecutor = (): ActionExecutor<"merge-config"> => ({
  kind: "merge-config",
  plan: (action) => ({ class: "config", path: action.path }),
  check: async (action, ctx) =>
    preconditionHolds(ctx, action.precondition) ? ok : txFail("conflict", `${ctx.target} changed since the preview; nothing was overwritten (preview again)`),
  change: async (action, ctx) => {
    const text = ctx.current.exists ? decode(ctx.fs.readFile(ctx.target!)) : undefined
    const merged = mergeConfigText(text, action.format, action.set)
    if (!merged.ok) return merged
    if (merged.value === text) return txOk({ type: "none", reason: "already merged" })
    return txOk({ type: "file", bytes: new TextEncoder().encode(merged.value), mode: ctx.current.mode ?? 0o600, replace: "backup" })
  },
})

export const linkExecutableExecutor = (): ActionExecutor<"link-executable"> => ({
  kind: "link-executable",
  plan: (action) => ({ class: "link", path: action.path, resolve: { finalMayBeSymlink: true } }),
  change: async (action, ctx) => {
    const target = ctx.resolve(action.target)
    return target.ok ? txOk({ type: "symlink", target: target.value, replace: "backup" }) : target
  },
})

export const installServiceExecutor = (render: BuiltinDeps["renderService"] = () => undefined): ActionExecutor<"install-service"> => ({
  kind: "install-service",
  plan: (action) => ({ class: "service", path: action.path }),
  check: async (action) => {
    const r = pinned(render(action), action.sha256, `the ${action.service} ${action.manager} unit`)
    return r.ok ? ok : r
  },
  change: async (action) => {
    const r = pinned(render(action), action.sha256, `the ${action.service} ${action.manager} unit`)
    return r.ok ? txOk({ type: "file", bytes: r.value, mode: 0o644, replace: "backup" }) : r
  },
})

const missing = (what: string) => txFail("internal", `this hubctl was built without a ${what} source`)

export const installArtifactExecutor = (source?: HubctlSource): ActionExecutor<"install-artifact"> => {
  const entryFor = (action: { readonly target: string; readonly version: string; readonly sha256: string }, host: string): TxResult<ArtifactEntry> => {
    if (!source) return missing("hubctl release")
    if (action.target !== host) return txFail("wrong_platform", `the plan installs hubctl for ${action.target}, but this host is ${host}`)
    const entry = fromResult(selectArtifact(source.manifest, action.target))
    if (!entry.ok) return entry
    if (source.manifest.release !== action.version || entry.value.sha256 !== action.sha256)
      return txFail("integrity_mismatch", `the plan's hubctl ${action.version} is not the artifact the verified ${source.manifest.release} manifest pins`)
    const decision = fromResult(
      decideInstall({
        candidate: { release: source.manifest.release, minimumVersion: source.manifest.minimumVersion, sha256: entry.value.sha256 },
        installed: source.installed,
        floor: source.floor,
        allowDowngrade: source.allowDowngrade,
      }),
    )
    return decision.ok ? entry : decision
  }
  return {
    kind: "install-artifact",
    plan: (action) => ({ class: "artifact", path: action.path }),
    check: async (action, ctx) => {
      const entry = entryFor(action, ctx.host.target)
      return entry.ok ? ok : entry
    },
    change: async (action, ctx) => {
      const entry = entryFor(action, ctx.host.target)
      if (!entry.ok) return entry
      const bytes = await source!.fetch(entry.value)
      const checked = fromResult(checkArtifactBytes(entry.value, { sha256: sha256Of(bytes), size: bytes.byteLength }))
      if (!checked.ok) return checked
      return txOk({ type: "file", bytes, mode: 0o755, replace: "backup" })
    },
  }
}

export const installHarnessExecutor = (source?: HarnessSource): ActionExecutor<"install-harness"> => {
  const pinFor = (action: InstallHarness, host: string) => {
    if (!source) return missing("harness")
    if (action.target !== host) return txFail("wrong_platform", `the plan installs ${action.harness} for ${action.target}, but this host is ${host}`)
    const pin = fromResult(checkHarnessPin(source.manifest, action))
    if (!pin.ok) return pin
    const decision = fromResult(
      decideHarnessInstall(pin.value, { installed: source.installed?.(action.harness) ?? action.previous, floor: source.floor?.(action.harness), allowDowngrade: source.allowDowngrade }),
    )
    return decision.ok ? pin : decision
  }
  return {
    kind: "install-harness",
    plan: (action) => ({ class: "harness", path: action.path }),
    check: async (action, ctx) => {
      const pin = pinFor(action, ctx.host.target)
      return pin.ok ? ok : pin
    },
    change: async (action, ctx) => {
      const pin = pinFor(action, ctx.host.target)
      if (!pin.ok) return pin
      const download = await source!.fetch(action)
      // The pinned digest first (mandatory), then the upstream evidence; only verified bytes reach the unpacker.
      const evidence = fromResult(checkHarnessEvidence(action, { sha256: sha256Of(download.bytes), size: download.bytes.byteLength }, download.evidence))
      if (!evidence.ok) return evidence
      ctx.recordEvidence(evidence.value)
      const files = await source!.unpack(action, download.bytes)
      if (!files.ok) return files
      const seen = new Set<string>()
      for (const f of files.value) {
        if (!isSafeRel(f.rel) || seen.has(f.rel) || !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o777) return txFail("invalid", `the ${action.harness} archive has an unsafe entry ${JSON.stringify(f.rel)}`)
        seen.add(f.rel)
      }
      for (const rel of seen) if ([...seen].some((other) => other.startsWith(`${rel}/`))) return txFail("invalid", `the ${action.harness} archive uses ${rel} as both a file and a directory`)
      if (seen.size === 0) return txFail("invalid", `the ${action.harness} archive is empty`)
      return txOk({ type: "tree", files: files.value, mode: 0o755 })
    },
  }
}

/** The built-in executors for the local kinds; adapters add the rest (see executor.ts). */
export function builtinExecutors(deps: BuiltinDeps): ExecutorMap {
  return {
    "ensure-directory": ensureDirectoryExecutor(),
    "write-file": writeFileExecutor(deps.assets),
    "merge-config": mergeConfigExecutor(),
    "link-executable": linkExecutableExecutor(),
    "install-service": installServiceExecutor(deps.renderService),
    "install-artifact": installArtifactExecutor(deps.hubctl),
    "install-harness": installHarnessExecutor(deps.harness),
  }
}
