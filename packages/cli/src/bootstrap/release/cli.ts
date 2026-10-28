// The hubctl release tool (`bun scripts/hubctl-release.ts <command>`), used by .github/workflows/release.yml and by
// maintainers. It is not part of the hub/hubctl command surface.
//
//   build [TARGET…] [--outdir dist] [--trust-root FILE] [--require-trust-root]
//       Compiles packages/cli/src/main.ts into dist/hubctl-<target> for the supported targets (all by default),
//       embedding the trust root (public keys only). --require-trust-root refuses a build without one.
//   manifest --minimum-version V --out FILE [--dist dist] [--pins FILE] [--release V] [--issued-at MS]
//       Writes the unsigned manifest body: every dist/hubctl-<target> with its size and sha256, and the reviewed
//       harness pins after re-downloading and digesting every pinned file.
//   sign --in FILE --out FILE [--trust-root FILE] [--key-id ID]
//       Signs the body with the key in $HUB_RELEASE_SIGNING_KEY (never printed) and verifies the result against
//       the trust root the binaries embed. Writes nothing unless it verifies.
//   verify --manifest FILE [--trust-root FILE] (--dist DIR | --target T --file BIN)
//          [--installed V --installed-sha256 D] [--floor V] [--allow-downgrade]
//       Runs the installer's checks (verify.ts) on one or every artifact.
//   trust-root [--key-id ID]
//       Prints the v1 trust root (public key only) for the key in $HUB_RELEASE_SIGNING_KEY, for the maintainer
//       who sets up the release key (README.md next to this file).
//
// Exit codes: 0 ok, 1 other, 2 usage, 11 artifact rejected (contracts §3.11).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import pkg from "../../../package.json" with { type: "json" }
import {
  BOOTSTRAP_EXIT,
  SUPPORTED_TARGETS,
  canonicalJSON,
  checkTarget,
  exitFor,
  isRecord,
  supportedTarget,
  type Issue,
  type Result,
  type TrustRoot,
} from "../contracts/index.ts"
import { buildManifestBody, manifestJSON, parseSigningKey, signVerified, trustRootFor } from "./manifest.ts"
import { PIN_LIST_FILE, validatePinList, verifyPinDownloads, type Downloader } from "./pins.ts"
import { shippedTrustRoot, trustRootDefine } from "./trust-root.ts"
import { digestBytes, parseManifest, verifyHubctlRelease } from "./verify.ts"

/** The environment variable holding the release signing key (a GitHub Actions secret; decision Q5). */
export const SIGNING_KEY_ENV = "HUB_RELEASE_SIGNING_KEY"
/** The trust root the release binaries embed, relative to the repository root (checked in once the key exists). */
export const TRUST_ROOT_FILE = "packages/cli/src/bootstrap/release/trust-root.json"
/** The program compiled into hubctl (I3). */
export const HUBCTL_ENTRY = "packages/cli/src/main.ts"
export const DEFAULT_KEY_ID = "hub-release-1"
/** The version hubctl --version prints, and the release the manifest names. */
export const HUBCTL_VERSION: string = pkg.version

export interface ReleaseIo {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The repository root; relative paths resolve against it. */
  readonly cwd: string
  readonly stdout: (s: string) => void
  readonly stderr: (s: string) => void
  /** Runs a word list (no shell) in `cwd`; resolves to its exit code. */
  readonly run: (argv: string[]) => Promise<number>
  readonly download: Downloader
  readonly now: () => number
}

const EXIT_USAGE = BOOTSTRAP_EXIT.usage
const EXIT_OTHER = BOOTSTRAP_EXIT.other

class Usage extends Error {}
class Failure extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

interface Parsed {
  readonly values: Map<string, string>
  readonly flags: Set<string>
  readonly positional: string[]
}

function parseArgs(argv: readonly string[], valued: readonly string[], booleans: readonly string[], positional = false): Parsed {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (valued.includes(word)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith("--")) throw new Usage(`${word} needs a value`)
      values.set(word, value)
    } else if (booleans.includes(word)) flags.add(word)
    else if (word.startsWith("-") || !positional) throw new Usage(`unknown argument ${word}`)
    else rest.push(word)
  }
  return { values, flags, positional: rest }
}

const required = (p: Parsed, flag: string): string => {
  const value = p.values.get(flag)
  if (value === undefined) throw new Usage(`${flag} is required`)
  return value
}

const describe = (issues: readonly Issue[]) => issues.map((i) => `  ${i.code} ${i.path || "/"}: ${i.message}`).join("\n")

/** Throws a Failure carrying the exit code of the first issue. */
function unwrap<T>(r: Result<T>, what: string): T {
  if (r.ok) return r.value
  throw new Failure(`${what}:\n${describe(r.issues)}`, exitFor(r.issues[0]?.code ?? "internal"))
}

function readJSON(file: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    throw new Failure(`cannot read ${what} ${file}`, EXIT_OTHER)
  }
  const r = parseManifest(text)
  if (!r.ok) throw new Failure(`${what} ${file} is not JSON`, EXIT_OTHER)
  return r.value
}

function loadTrustRoot(file: string): TrustRoot {
  const value = readJSON(file, "trust root")
  const r = shippedTrustRoot(JSON.stringify(value))
  if (!r.ok) throw new Failure(`trust root ${file}:\n${describe(r.issues)}`, EXIT_OTHER)
  return r.value
}

function signingKey(io: ReleaseIo) {
  const secret = io.env[SIGNING_KEY_ENV]
  if (!secret) throw new Usage(`${SIGNING_KEY_ENV} is not set (the release signing key; a GitHub Actions secret)`)
  try {
    return parseSigningKey(secret)
  } catch (error) {
    throw new Failure((error as Error).message, EXIT_OTHER)
  }
}

/** The `bun build --compile` words for one target's hubctl. */
export function hubctlBuildArgv(target: string, options: { readonly bun: string; readonly outdir: string; readonly root?: TrustRoot }): string[] {
  const t = supportedTarget(target)
  if (!t) throw new Error(`${target} is not a supported target`)
  return [
    options.bun,
    "build",
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${t.bunTarget}`,
    ...(options.root ? trustRootDefine(options.root) : []),
    HUBCTL_ENTRY,
    "--outfile",
    path.join(options.outdir, `hubctl-${t.target}`),
  ]
}

async function build(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const p = parseArgs(argv, ["--outdir", "--trust-root", "--bun"], ["--require-trust-root"], true)
  const targets = p.positional.length > 0 ? p.positional : SUPPORTED_TARGETS.map((t) => t.target)
  for (const target of targets) {
    const r = checkTarget(target)
    if (!r.ok) throw new Usage(r.issues[0]!.message)
  }
  const rootFile = path.resolve(io.cwd, p.values.get("--trust-root") ?? TRUST_ROOT_FILE)
  let root: TrustRoot | undefined
  if (existsSync(rootFile)) root = loadTrustRoot(rootFile)
  else if (p.flags.has("--require-trust-root")) throw new Failure(`no trust root at ${rootFile}: a release build must embed one (see README.md next to ${TRUST_ROOT_FILE})`, EXIT_OTHER)
  else io.stderr(`warning: no trust root at ${rootFile}; this dev build cannot verify releases\n`)
  const outdir = path.resolve(io.cwd, p.values.get("--outdir") ?? "dist")
  mkdirSync(outdir, { recursive: true })
  const bun = p.values.get("--bun") ?? process.execPath
  for (const target of targets) {
    const words = hubctlBuildArgv(target, { bun, outdir, ...(root ? { root } : {}) })
    io.stderr(`==> ${words.at(-1)}\n`)
    const code = await io.run(words)
    if (code !== 0) throw new Failure(`bun build failed for ${target} (exit ${code})`, EXIT_OTHER)
  }
  return 0
}

async function manifest(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const p = parseArgs(argv, ["--dist", "--pins", "--minimum-version", "--release", "--issued-at", "--out"], [])
  const minimumVersion = required(p, "--minimum-version")
  const out = path.resolve(io.cwd, required(p, "--out"))
  const dist = path.resolve(io.cwd, p.values.get("--dist") ?? "dist")
  const issuedText = p.values.get("--issued-at")
  const issuedAt = issuedText === undefined ? io.now() : Number(issuedText)
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Usage("--issued-at takes milliseconds since the epoch")
  const pins = unwrap(validatePinList(readJSON(path.resolve(io.cwd, p.values.get("--pins") ?? PIN_LIST_FILE), "pin list")), "the pin list is invalid")
  const artifacts = SUPPORTED_TARGETS.map((t) => {
    const file = `hubctl-${t.target}`
    let bytes: Uint8Array
    try {
      bytes = readFileSync(path.join(dist, file))
    } catch {
      throw new Failure(`missing ${path.join(dist, file)}: build every supported target first`, EXIT_OTHER)
    }
    return { target: t.target, file, ...digestBytes(bytes) }
  })
  io.stderr(`re-downloading ${pins.pins.length} pinned harness file(s)\n`)
  const harnesses = unwrap(await verifyPinDownloads(pins, io.download), "a pinned harness file does not match its pin")
  const body = unwrap(buildManifestBody({ release: p.values.get("--release") ?? HUBCTL_VERSION, minimumVersion, issuedAt, artifacts, harnesses }), "the manifest is invalid")
  writeFileSync(out, `${canonicalJSON(body)}\n`)
  io.stdout(`${out}: hubctl ${body.release} (${body.channel}), ${body.artifacts.length} artifacts, ${body.harnesses.length} harness pins\n`)
  return 0
}

async function sign(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const p = parseArgs(argv, ["--in", "--out", "--trust-root", "--key-id"], [])
  const input = path.resolve(io.cwd, required(p, "--in"))
  const out = path.resolve(io.cwd, required(p, "--out"))
  const root = loadTrustRoot(path.resolve(io.cwd, p.values.get("--trust-root") ?? TRUST_ROOT_FILE))
  const body = readJSON(input, "manifest body")
  if (!isRecord(body) || "signatures" in body) throw new Failure(`${input} is not an unsigned manifest body (it has signatures, or is not an object)`, EXIT_OTHER)
  const rebuilt = unwrap(
    buildManifestBody({
      release: body.release as string,
      minimumVersion: body.minimumVersion as string,
      issuedAt: body.issuedAt as number,
      artifacts: body.artifacts as never,
      harnesses: body.harnesses as never,
    }),
    "the manifest body is invalid",
  )
  if (canonicalJSON(rebuilt) !== canonicalJSON(body)) throw new Failure(`${input} is not a manifest body as \`manifest\` writes it`, EXIT_OTHER)
  const privateKey = signingKey(io)
  const active = root.keys.filter((k) => k.status === "active")
  const keyID = p.values.get("--key-id") ?? (active.length === 1 ? active[0]!.keyID : DEFAULT_KEY_ID)
  const verified = unwrap(signVerified(rebuilt, { keyID, privateKey }, root), "the signed manifest does not verify against the trust root (is the secret the key the binaries embed?)")
  writeFileSync(out, manifestJSON(verified))
  io.stdout(`${out}: signed by ${keyID}, verified against trust root v${root.version}\n`)
  return 0
}

async function verify(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const p = parseArgs(argv, ["--manifest", "--trust-root", "--dist", "--target", "--file", "--installed", "--installed-sha256", "--floor"], ["--allow-downgrade"])
  const root = loadTrustRoot(path.resolve(io.cwd, p.values.get("--trust-root") ?? TRUST_ROOT_FILE))
  const document = readJSON(path.resolve(io.cwd, required(p, "--manifest")), "manifest")
  const dist = p.values.get("--dist")
  const jobs: { target: string; file: string }[] = dist
    ? SUPPORTED_TARGETS.map((t) => ({ target: t.target, file: path.resolve(io.cwd, dist, `hubctl-${t.target}`) }))
    : [{ target: required(p, "--target"), file: path.resolve(io.cwd, required(p, "--file")) }]
  const installedVersion = p.values.get("--installed")
  const installedSha = p.values.get("--installed-sha256")
  if ((installedVersion === undefined) !== (installedSha === undefined)) throw new Usage("--installed and --installed-sha256 go together")
  const floor = p.values.get("--floor")
  for (const job of jobs) {
    let bytes: Uint8Array
    try {
      bytes = readFileSync(job.file)
    } catch {
      throw new Failure(`cannot read ${job.file}`, EXIT_OTHER)
    }
    const accepted = unwrap(
      verifyHubctlRelease({
        manifest: document,
        root,
        target: job.target,
        bytes: digestBytes(bytes),
        ...(installedVersion !== undefined && installedSha !== undefined ? { installed: { version: installedVersion, sha256: installedSha } } : {}),
        ...(floor !== undefined ? { floor } : {}),
        allowDowngrade: p.flags.has("--allow-downgrade"),
      }),
      `${job.target}: rejected`,
    )
    io.stdout(`ok ${job.target} hubctl ${accepted.manifest.release} ${accepted.kind} ${accepted.artifact.sha256}\n`)
  }
  return 0
}

async function trustRoot(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const p = parseArgs(argv, ["--key-id"], [])
  io.stdout(`${JSON.stringify(trustRootFor(signingKey(io), p.values.get("--key-id") ?? DEFAULT_KEY_ID), null, 2)}\n`)
  return 0
}

const COMMANDS: Record<string, (argv: readonly string[], io: ReleaseIo) => Promise<number>> = { build, manifest, sign, verify, "trust-root": trustRoot }

const USAGE = "usage: hubctl-release <build|manifest|sign|verify|trust-root> [options] (see packages/cli/src/bootstrap/release/cli.ts)\n"

export async function runRelease(argv: readonly string[], io: ReleaseIo): Promise<number> {
  const [name, ...rest] = argv
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) {
    io.stderr(USAGE)
    return EXIT_USAGE
  }
  try {
    return await command(rest, io)
  } catch (error) {
    if (error instanceof Usage) {
      io.stderr(`${error.message}\n${USAGE}`)
      return EXIT_USAGE
    }
    if (error instanceof Failure) {
      io.stderr(`${error.message}\n`)
      return error.code
    }
    io.stderr(`internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_OTHER
  }
}
