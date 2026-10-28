// Test fixtures for the Codex bootstrap adapter (packages/cli/src/bootstrap/adapters/codex). Owned by the Codex
// adapter tests; the shared contract fixtures stay in ./fixtures.ts. Nothing here is real upstream material:
// archives are built in memory, and sigstore material (CA, leaf certificate, Rekor key) is generated per test
// process from ephemeral keys, so no key, certificate or digest of a real release is committed.
import { gzipSync } from "node:zlib"

// ---------- tar archives ----------

export interface TarEntry {
  readonly name: string
  /** "0" file (default), "5" directory, "2" symlink, "1" hard link, "x" pax header for the next entry. */
  readonly type?: "0" | "5" | "2" | "1" | "x" | "L" | "3"
  readonly text?: string
  readonly bytes?: Uint8Array
  readonly mode?: number
  readonly linkname?: string
}

const enc = (s: string) => new TextEncoder().encode(s)

function header(entry: TarEntry, size: number, corruptChecksum = false): Uint8Array {
  const h = new Uint8Array(512)
  const put = (offset: number, length: number, value: string) => h.set(enc(value).slice(0, length), offset)
  const octal = (offset: number, length: number, n: number) => put(offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`)
  put(0, 100, entry.name)
  octal(100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644))
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 1_793_000_000)
  h.fill(0x20, 148, 156)
  put(156, 1, entry.type ?? "0")
  if (entry.linkname) put(157, 100, entry.linkname)
  put(257, 6, "ustar\0")
  put(263, 2, "00")
  let sum = 0
  for (const b of h) sum += b
  if (corruptChecksum) sum += 1
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return h
}

/** An uncompressed ustar archive of `entries`. */
export function tar(entries: readonly TarEntry[], options: { corruptChecksum?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    const body = entry.bytes ?? enc(entry.text ?? "")
    parts.push(header(entry, body.byteLength, options.corruptChecksum))
    if (body.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512)
      padded.set(body)
      parts.push(padded)
    }
  }
  parts.push(new Uint8Array(1024))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** A pax extended header record list ("<len> key=value\n" each). */
export function pax(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([k, v]) => {
      const body = ` ${k}=${v}\n`
      let len = body.length + 1
      while (`${len}${body}`.length !== len) len = `${len}${body}`.length
      return `${len}${body}`
    })
    .join("")
}

export const tgz = (entries: readonly TarEntry[], options?: { corruptChecksum?: boolean }) => new Uint8Array(gzipSync(tar(entries, options)))

/** The upstream package layout (codex-package-<triple>.tar.gz): bin/codex plus its helpers. */
export const PACKAGE_ENTRIES: readonly TarEntry[] = [
  { name: "bin/", type: "5" },
  { name: "bin/codex", text: "#!codex 0.165.0", mode: 0o755 },
  { name: "bin/codex-code-mode-host", text: "#!code-mode-host", mode: 0o755 },
  { name: "codex-package.json", text: '{"version":"0.165.0"}', mode: 0o644 },
  { name: "codex-path/", type: "5" },
  { name: "codex-path/rg", text: "#!rg", mode: 0o755 },
  { name: "codex-resources/", type: "5" },
  { name: "codex-resources/bwrap", text: "#!bwrap", mode: 0o755 },
  { name: "codex-resources/voice/lib/libz.so.1", text: "lib", mode: 0o555 },
]
