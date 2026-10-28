// Canonical JSON and digests. A plan digest, a preview token and a manifest signature all hash the same bytes on
// every machine and every run: object keys sorted at every depth, no whitespace, `undefined` fields dropped, and
// anything JSON cannot represent exactly (NaN, Infinity, dates, functions, class instances) refused outright.
import { createHash } from "node:crypto"

export function canonicalJSON(value: unknown): string {
  return encode(value, "")
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "string":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJSON: ${path || "value"} is not a finite number`)
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => encode(v === undefined ? null : v, `${path}/${i}`)).join(",")}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJSON: ${path || "value"} is not a plain object`)
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, `${path}/${k}`)}`).join(",")}}`
    }
    default:
      throw new TypeError(`canonicalJSON: ${path || "value"} (${typeof value}) has no JSON form`)
  }
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")

/** "sha256:<hex>" of the canonical JSON of `value`. */
export const digestOf = (value: unknown): string => `sha256:${sha256Hex(canonicalJSON(value))}`

/** What identifies the host a plan was made for. The raw machine ID never leaves this function. */
export interface HostIdentity {
  /** /etc/machine-id (Linux) or IOPlatformUUID (macOS). */
  readonly machineID: string
  readonly platform: string
  readonly arch: string
  readonly uid: number
  readonly home: string
}

/**
 * The host fingerprint previews and journals are bound to: a digest over the machine ID, platform, architecture,
 * user and home, so a preview made for another machine or another account never applies here.
 */
export const hostFingerprint = (host: HostIdentity): string =>
  digestOf({ kind: "hub.host-fingerprint", machineID: sha256Hex(host.machineID), platform: host.platform, arch: host.arch, uid: host.uid, home: host.home })
