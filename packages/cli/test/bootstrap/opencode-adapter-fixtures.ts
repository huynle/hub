// Fixtures for the OpenCode adapter tests (HBS-06). Plain text and fakes only: no real home, config, binary or
// credential appears here. Provider settings use placeholder env references, never key material.

/** The stable hubctl authority (the installed standalone hubctl in user-bin), as resolved on the fake host. */
export const AUTHORITY = "/Users/dev/.local/bin/hubctl"

/**
 * A real-world-shaped OpenCode 2 config: comments everywhere, trailing commas, other plugins (one commented out),
 * MCP servers (local and remote), a provider, and fields hubctl does not know.
 */
export const CONFIG_WITH_EVERYTHING = `// OpenCode config, synced from dotfiles
{
  "$schema": "https://opencode.ai/config.json",
  /* the user's look */
  "theme": "tokyonight", // always dark
  "plugins": [
    // "opencode-old-plugin",
    "other-plugin", // keep me
    { "package": "@acme/opencode-tools", "options": { "level": 2 } },
  ],
  "providers": {
    // a provider the user configured; never touched
    "local-llm": { "baseURL": "http://127.0.0.1:11434/v1", "models": { "qwen": {} } },
  },
  "mcp": {
    "servers": {
      "notes": { "type": "remote", "url": "https://notes.example/mcp", "disabled": true },
      "tools": {
        "type": "local",
        "command": ["npx", "-y", "some-mcp"], // the user's own server
      },
    },
  },
  "x-unknown-field": { "kept": [1, 2, 3,], },
}
`

/** True when `a` is a subsequence of `b` (b is a plus insertions only); returns the inserted characters. */
export function insertionsOf(a: string, b: string): string | undefined {
  let i = 0
  let extra = ""
  for (const ch of b) {
    if (i < a.length && ch === a[i]) i++
    else extra += ch
  }
  return i === a.length ? extra : undefined
}

// ---------- archives (built in memory, the layouts upstream ships: a zip on macOS, a tar.gz on Linux) ----------

import { deflateRawSync, gzipSync } from "node:zlib"

export interface ArchiveEntry {
  readonly name: string
  readonly content?: string | Uint8Array
  readonly mode?: number
  /** tar type flag ("0" file, "2" symlink, "5" directory, …) or, for zip, "dir"/"link". */
  readonly type?: string
  readonly linkTarget?: string
}

const bytesOf = (c: string | Uint8Array | undefined) => (typeof c === "string" ? new TextEncoder().encode(c) : (c ?? new Uint8Array()))

/** A ustar archive, gzipped. */
export function tarGz(entries: readonly ArchiveEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    const data = bytesOf(e.content)
    const h = new Uint8Array(512)
    const put = (s: string, at: number, len: number) => h.set(new TextEncoder().encode(s).slice(0, len), at)
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0")
    put(e.name, 0, 100)
    put(octal(e.mode ?? 0o755, 8), 100, 8)
    put(octal(0, 8), 108, 8)
    put(octal(0, 8), 116, 8)
    put(octal(e.type === undefined || e.type === "0" ? data.byteLength : 0, 12), 124, 12)
    put(octal(0, 12), 136, 12)
    put("        ", 148, 8)
    put(e.type ?? "0", 156, 1)
    if (e.linkTarget) put(e.linkTarget, 157, 100)
    put("ustar\u000000", 257, 8)
    let sum = 0
    for (const b of h) sum += b
    put(`${octal(sum, 7)}\u0000`, 148, 8)
    blocks.push(h)
    if (e.type === undefined || e.type === "0") {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
      padded.set(data)
      blocks.push(padded)
    }
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((n, b) => n + b.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.byteLength
  }
  return new Uint8Array(gzipSync(out))
}

/** A zip archive (deflate, or stored with `store`), unix modes in the external attributes. */
export function zip(entries: readonly ArchiveEntry[], options: { store?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name)
    const raw = e.type === "link" ? bytesOf(e.linkTarget) : bytesOf(e.content)
    const data = options.store ? raw : new Uint8Array(deflateRawSync(raw))
    const method = options.store ? 0 : 8
    const fileType = e.type === "dir" ? 0o040000 : e.type === "link" ? 0o120000 : 0o100000
    const local = new Uint8Array(30 + name.byteLength + data.byteLength)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, data.byteLength, true)
    lv.setUint32(22, raw.byteLength, true)
    lv.setUint16(26, name.byteLength, true)
    local.set(name, 30)
    local.set(data, 30 + name.byteLength)
    const central = new Uint8Array(46 + name.byteLength)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, (3 << 8) | 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, data.byteLength, true)
    cv.setUint32(24, raw.byteLength, true)
    cv.setUint16(28, name.byteLength, true)
    cv.setUint32(38, ((fileType | (e.mode ?? 0o755)) << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.byteLength
  }
  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, end]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Stand-in for the OpenCode binary (not a real executable). */
export const FAKE_BINARY = "\u007fELF fake opencode 2.2.0"
