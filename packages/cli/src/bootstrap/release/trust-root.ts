// The trust root a standalone hubctl ships (contracts §3.6, I6): public keys only, embedded at build time with
// `bun build --compile --define HUBCTL_TRUST_ROOT=<JSON string>` (trustRootDefine). It is never read from the
// environment or the disk at run time, so nothing on the machine can swap it; replacing it goes through
// rotateTrustRoot. A build without it (a source run, the npm bundle, a dev build) has no trust root and refuses
// every manifest, rather than trusting one by default.
import { canonicalJSON, fail, findSecrets, validateTrustRoot, type Result, type TrustRoot } from "../contracts/index.ts"

/** The identifier `bun build --define` replaces with the trust root's canonical JSON (a string literal). */
export const TRUST_ROOT_DEFINE = "HUBCTL_TRUST_ROOT"

declare const HUBCTL_TRUST_ROOT: string | undefined

/** The embedded trust root text, or undefined when this build has none. */
export function embeddedTrustRootText(): string | undefined {
  return typeof HUBCTL_TRUST_ROOT === "string" ? HUBCTL_TRUST_ROOT : undefined
}

/** The shipped trust root, validated; signature_invalid when the build has none or it is unusable. */
export function shippedTrustRoot(text: string | undefined = embeddedTrustRootText()): Result<TrustRoot> {
  if (text === undefined) return fail("", "signature_invalid", "this hubctl build has no trust root, so it cannot verify releases (use a signed release build)")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail("", "signature_invalid", "the embedded trust root is not JSON")
  }
  const r = validateTrustRoot(value)
  if (!r.ok) return fail("", "signature_invalid", `the embedded trust root is unusable: ${r.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`)
  if (findSecrets(value).length > 0) return fail("", "signature_invalid", "the embedded trust root carries key material that is not a public key")
  return r
}

/** The `bun build` words that embed `root`; throws on anything but a valid, public-keys-only trust root. */
export function trustRootDefine(root: TrustRoot): string[] {
  const text = canonicalJSON(root)
  const r = shippedTrustRoot(text)
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join("; "))
  return ["--define", `${TRUST_ROOT_DEFINE}=${JSON.stringify(text)}`]
}
