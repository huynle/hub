// Hub session IDs for a harness's native session IDs (decision fx04e42c point 2). The hub's rule is `ses_` + 1–200
// letters and digits (isHubSessionID); a Claude Code UUID or a Codex thread ID is not, so the spoke maps it, and maps
// it back when the hub names the session in an op. The mapping is a pure function of (namespace, native ID), so it
// survives restarts and needs no table:
//
// - a UUID (any version, any case)  → ses_<ns><32 lowercase hex>        (Claude Code: ses_cc…, Codex: ses_cx…)
// - any other native ID             → ses_<ns>0<hex of its UTF-8 bytes>  (at most MAX_NATIVE_BYTES bytes)
//
// The namespace is two lowercase letters, one per harness, so IDs of different harnesses never collide (OpenCode's
// own IDs are not mapped). The two forms cannot be confused: the UUID form has 32 characters after the namespace,
// the other an odd number (the 0 marker plus pairs of hex digits). UUIDs come back in lower case.

/** A session namespace: two lowercase letters (e.g. "cc" for Claude Code, "cx" for Codex). */
export const SESSION_NAMESPACE = /^[a-z]{2}$/

/** Longest native ID (UTF-8 bytes) that is not a UUID: ses_ + ns + 0 + 2 hex per byte stays within 200 characters. */
export const MAX_NATIVE_BYTES = 98

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_HEX = /^[0-9a-f]{32}$/
const OTHER_HEX = /^0((?:[0-9a-f]{2})+)$/

function checkNamespace(ns: string): void {
  if (typeof ns !== "string" || !SESSION_NAMESPACE.test(ns)) throw new Error(`Session namespace must be two lowercase letters (got ${JSON.stringify(ns)})`)
}

/** The hub session ID for a native session ID in namespace `ns`. Throws on a bad namespace or an unmappable ID. */
export function hubSessionID(ns: string, nativeID: string): string {
  checkNamespace(ns)
  if (typeof nativeID !== "string" || nativeID === "") throw new Error("Native session ID is empty")
  if (UUID.test(nativeID)) return `ses_${ns}${nativeID.replace(/-/g, "").toLowerCase()}`
  const bytes = Buffer.from(nativeID, "utf8")
  if (bytes.length > MAX_NATIVE_BYTES) throw new Error(`Native session ID is too long (${bytes.length} bytes, at most ${MAX_NATIVE_BYTES})`)
  return `ses_${ns}0${bytes.toString("hex")}`
}

/** The native session ID a hub session ID in namespace `ns` stands for; undefined when it is not one of them. */
export function nativeSessionID(ns: string, hubID: string): string | undefined {
  if (typeof ns !== "string" || !SESSION_NAMESPACE.test(ns) || typeof hubID !== "string") return undefined
  const prefix = `ses_${ns}`
  if (!hubID.startsWith(prefix)) return undefined
  const rest = hubID.slice(prefix.length)
  if (UUID_HEX.test(rest)) return `${rest.slice(0, 8)}-${rest.slice(8, 12)}-${rest.slice(12, 16)}-${rest.slice(16, 20)}-${rest.slice(20)}`
  const other = OTHER_HEX.exec(rest)
  if (!other || other[1]!.length / 2 > MAX_NATIVE_BYTES) return undefined
  const native = Buffer.from(other[1]!, "hex").toString("utf8")
  // Only IDs hubSessionID makes: valid UTF-8 that round-trips, and not a UUID (those use the short form).
  return native !== "" && !UUID.test(native) && hubSessionID(ns, native) === hubID ? native : undefined
}
