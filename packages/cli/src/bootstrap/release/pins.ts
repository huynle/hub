// The reviewed harness pin list: the checked-in input (PIN_LIST_FILE, schema `hub.harness-pin-list` v1) that the
// release job turns into the signed manifest's `harnesses` (contracts §3.6.1, I5).
//
// Format:
//   { "schema": "hub.harness-pin-list", "version": 1,
//     "pins": [ { "pin": <HarnessPin, exactly as the manifest lists it>,
//                 "review": { "by": "<GitHub handle>", "on": "YYYY-MM-DD",
//                             "checked": ["upstream-release", "digest-redownloaded", "evidence-listed"] } } ] }
//
// Review process (see README.md next to this file):
//   - A pin changes only through a pull request that touches this file; the reviewer is someone other than the
//     author, and the `review` record names who checked the pin, when, and that every required check was done:
//       upstream-release     the URL is the upstream's own release asset for exactly this version and target;
//       digest-redownloaded  the reviewer downloaded the file and computed the size and sha256 themselves;
//       evidence-listed      `evidence` lists exactly the upstream evidence published for this file.
//   - Each pin is checked with the manifest's own rules (supported target, exact version, https, plain file name,
//     one per harness and target, evidence the harness can offer) plus: the file is the URL's last path segment,
//     and the URL has no credentials, query or fragment. Nothing secret-shaped may appear anywhere.
//   - The release job re-downloads every pinned file and refuses to sign on any size or digest mismatch
//     (verifyPinDownloads), so the signature never vouches for a file nobody fetched in that release.
import { createHash } from "node:crypto"
import {
  Checker,
  HARNESS_ORDER,
  fail,
  findSecrets,
  header,
  isRecord,
  list,
  ok,
  pointer,
  shape,
  text,
  validateArtifactManifest,
  type HarnessPin,
  type Result,
} from "../contracts/index.ts"

export const PIN_LIST_SCHEMA = "hub.harness-pin-list"
export const PIN_LIST_VERSION = 1
/** The checked-in pin list, relative to the repository root. */
export const PIN_LIST_FILE = "packages/cli/src/bootstrap/release/harness-pins.json"

/** What a reviewer must have checked for each pin (all of them, every time). */
export const PIN_CHECKS = ["upstream-release", "digest-redownloaded", "evidence-listed"] as const
export type PinCheck = (typeof PIN_CHECKS)[number]

export interface PinReview {
  /** The reviewer's GitHub handle. */
  readonly by: string
  /** The review date, YYYY-MM-DD. */
  readonly on: string
  readonly checked: readonly PinCheck[]
}

export interface ReviewedPin {
  readonly pin: HarnessPin
  readonly review: PinReview
}

export interface PinList {
  readonly schema: typeof PIN_LIST_SCHEMA
  readonly version: typeof PIN_LIST_VERSION
  readonly pins: readonly ReviewedPin[]
}

const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const MAX_PINS = 64

/** A stand-in hubctl artifact, so the pins can be checked by the manifest validator itself. */
const SKELETON = {
  schema: "hub.artifact-manifest",
  version: 1,
  product: "hubctl",
  release: "0.0.0",
  channel: "stable",
  minimumVersion: "0.0.0",
  issuedAt: 0,
  artifacts: [{ target: "linux-x64", file: "hubctl-linux-x64", size: 1, sha256: `sha256:${"0".repeat(64)}` }],
  signatures: [],
} as const

/** "/harnesses/3/url" → "/pins/3/pin/url"; "/harnesses/3" → "/pins/3". */
function pinPath(path: string): string | undefined {
  const m = /^\/harnesses\/(\d+)(\/.*)?$/.exec(path)
  if (!m) return undefined
  return m[2] ? `/pins/${m[1]}/pin${m[2]}` : `/pins/${m[1]}`
}

function checkReview(c: Checker, p: string, v: unknown) {
  const r = shape(c, p, v, ["by", "on", "checked"])
  if (!r) return
  text(c, pointer(p, "by"), r.by, 39, HANDLE)
  text(c, pointer(p, "on"), r.on, 10, DATE)
  if (!list(c, pointer(p, "checked"), r.checked, PIN_CHECKS.length, (q, item) => {
    if (typeof item !== "string" || !(PIN_CHECKS as readonly string[]).includes(item)) c.add(q, "invalid_value", `expected one of ${PIN_CHECKS.join(", ")}`)
  }, (item) => (typeof item === "string" ? item : undefined))) return
  for (const check of PIN_CHECKS) if (!(r.checked as unknown[]).includes(check)) c.add(pointer(p, "checked"), "missing_field", `the review did not record ${check}`)
}

function checkSource(c: Checker, p: string, pin: unknown) {
  if (!isRecord(pin) || typeof pin.url !== "string") return
  let url: URL
  try {
    url = new URL(pin.url)
  } catch {
    return // the manifest rules report it
  }
  if (url.username || url.password || url.search || url.hash) c.add(pointer(p, "url"), "invalid_value", "a pinned URL carries no credentials, query or fragment")
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "")
  if (typeof pin.file === "string" && last !== pin.file) c.add(pointer(p, "file"), "inconsistent", `the file must be the URL's last path segment (${last})`)
}

export function validatePinList(value: unknown): Result<PinList> {
  const c = new Checker()
  const r = shape(c, "", value, ["schema", "version", "pins"])
  if (!r) return c.result(value)
  header(c, "", r, PIN_LIST_SCHEMA, PIN_LIST_VERSION)
  const pins: unknown[] = []
  const listed = list(c, "/pins", r.pins, MAX_PINS, (p, entry) => {
    const e = shape(c, p, entry, ["pin", "review"])
    pins.push(e?.pin)
    if (!e) return
    if (e.review !== undefined) checkReview(c, pointer(p, "review"), e.review)
    checkSource(c, pointer(p, "pin"), e.pin)
  })
  if (listed) {
    const m = validateArtifactManifest({ ...SKELETON, harnesses: pins.map((p) => p ?? {}) })
    if (!m.ok) for (const issue of m.issues) {
      const path = pinPath(issue.path)
      if (path !== undefined) c.add(path, issue.code, issue.message)
    }
  }
  for (const path of findSecrets(value)) c.add(path, "secret", "a pin list never carries a secret")
  return c.result(value)
}

const targetOrder = (a: HarnessPin, b: HarnessPin) =>
  HARNESS_ORDER.indexOf(a.harness) - HARNESS_ORDER.indexOf(b.harness) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)

/** The manifest's `harnesses`: the pins in HARNESS_ORDER, then by target (deterministic). */
export function harnessPins(list: PinList): HarnessPin[] {
  return list.pins.map((p) => p.pin).sort(targetOrder)
}

export type Downloader = (url: string) => Promise<{ readonly size: number; readonly sha256: string }>

/**
 * Re-downloads every pinned file and compares its size and digest with the pin. Any mismatch or failed download is
 * integrity_mismatch; every pin is checked and reported. Returns the manifest's `harnesses` when all match.
 */
export async function verifyPinDownloads(value: unknown, download: Downloader): Promise<Result<HarnessPin[]>> {
  const valid = validatePinList(value)
  if (!valid.ok) return valid
  const c = new Checker()
  for (const [i, { pin }] of valid.value.pins.entries()) {
    const at = `/pins/${i}/pin`
    try {
      const got = await download(pin.url)
      if (got.size !== pin.size) c.add(`${at}/size`, "integrity_mismatch", `${pin.harness} ${pin.version} ${pin.target}: expected ${pin.size} bytes, downloaded ${got.size}`)
      else if (got.sha256 !== pin.sha256) c.add(`${at}/sha256`, "integrity_mismatch", `${pin.harness} ${pin.version} ${pin.target}: the download does not match the pinned digest`)
    } catch (error) {
      c.add(`${at}/url`, "integrity_mismatch", `${pin.harness} ${pin.version} ${pin.target}: could not download (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (c.issues.length > 0) return { ok: false, issues: c.issues }
  return ok(harnessPins(valid.value))
}

/** Streams a URL and returns its size and digest (redirects followed); throws on an HTTP error. */
export async function httpDigest(url: string, fetcher: typeof fetch = fetch): Promise<{ size: number; sha256: string }> {
  const response = await fetcher(url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const hash = createHash("sha256")
  let size = 0
  const reader = response.body.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    hash.update(next.value)
    size += next.value.byteLength
  }
  return { size, sha256: `sha256:${hash.digest("hex")}` }
}

/** Reads a pin list document (JSON text). */
export function parsePinList(text: string): Result<PinList> {
  try {
    return validatePinList(JSON.parse(text))
  } catch {
    return fail("", "invalid_value", "the pin list is not JSON")
  }
}
