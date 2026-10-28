// Secret detection for everything the bootstrap writes outside the credential store: plans, previews, journals,
// discovery snapshots, status output, logs and generated Ansible. A document that findSecrets flags is refused,
// not redacted: the only place a machine token may live is the credential store (credentials.ts).
import { isRecord, pointer } from "./validate.ts"

/** Key names (case-insensitive, "-" and "_" ignored) that mean the value is a credential. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "passphrase", "apikey", "privatekey", "credential", "authorization", "cookie", "devicecode"] as const

/** Value shapes of known credentials (anywhere in a string, at a word start): hub app (hat_), session (hst1.), launch (hlt1) and machine test tokens, common vendor keys, PEM keys, bearer headers. */
const B = "(?:^|[^A-Za-z0-9_])"
const SECRET_VALUES: readonly RegExp[] = [
  new RegExp(`${B}hat_[A-Za-z0-9_-]{8,}`),
  new RegExp(`${B}hst1\\.[A-Za-z0-9_-]`),
  new RegExp(`${B}hlt1[A-Za-z0-9._-]{8,}`),
  new RegExp(`${B}mt_[A-Za-z0-9_-]+`),
  new RegExp(`${B}sk-[A-Za-z0-9_-]{8,}`),
  new RegExp(`${B}(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{8,}`),
  new RegExp(`${B}github_pat_`),
  new RegExp(`${B}xox[abprs]-`),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+\S/i,
]

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replaceAll(/[-_]/g, "")
  return SECRET_KEY_PARTS.some((part) => k === part || k.endsWith(part) || k.startsWith(part))
}

export const isSecretValue = (value: string): boolean => SECRET_VALUES.some((re) => re.test(value))

/**
 * JSON pointers of every credential-named key (with a value) and every credential-shaped string in `value`.
 * `allowKeys` exempts exact pointers whose key name only looks like a credential (a preview's `/token`); their
 * values are still scanned.
 */
export function findSecrets(value: unknown, base = "", allowKeys: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (isSecretValue(v)) found.push(path)
    } else if (Array.isArray(v)) v.forEach((item, i) => walk(item, pointer(path, i)))
    else if (isRecord(v))
      for (const [key, item] of Object.entries(v)) {
        if (item === undefined) continue
        const p = pointer(path, key)
        if (isSecretKey(key) && !allowKeys.has(p)) found.push(p)
        else walk(item, p)
      }
  }
  walk(value, base)
  return found
}
