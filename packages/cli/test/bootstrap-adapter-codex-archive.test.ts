// The Codex archive unpacker: a pinned, already digest-checked .tar.gz becomes the immutable install tree, with no
// tar binary, no links, no device files and no path that leaves the tree.
import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { unpackCodexArchive } from "../src/bootstrap/adapters/codex/archive.ts"
import { CODEX_SCRIPT, PACKAGE_ENTRIES, pax, tar, tgz } from "./bootstrap/codex-fixtures.ts"

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe("unpackCodexArchive", () => {
  test("unpacks the upstream package layout file by file, keeping modes, skipping directory entries", () => {
    const r = unpackCodexArchive(tgz(PACKAGE_ENTRIES))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((f) => [f.rel, f.mode, ("bytes" in f ? text(f.bytes) : "")])).toEqual([
      ["bin/codex", 0o755, CODEX_SCRIPT],
      ["bin/codex-code-mode-host", 0o755, "#!code-mode-host"],
      ["codex-package.json", 0o644, '{"version":"0.165.0"}'],
      ["codex-path/rg", 0o755, "#!rg"],
      ["codex-resources/bwrap", 0o755, "#!bwrap"],
      ["codex-resources/voice/lib/libz.so.1", 0o555, "lib"],
    ])
  })

  test("a standalone archive (one codex-<triple> binary) becomes bin/codex", () => {
    const r = unpackCodexArchive(tgz([{ name: "codex-x86_64-unknown-linux-musl", text: "ELF", mode: 0o755 }]))
    expect(r.ok && r.value.map((f) => [f.rel, f.mode, ("bytes" in f ? text(f.bytes) : "")])).toEqual([["bin/codex", 0o755, "ELF"]])
  })

  test("pax and GNU long names name the next entry; ./ prefixes are dropped; setuid bits are stripped", () => {
    const long = `codex-resources/${"x".repeat(120)}`
    const r = unpackCodexArchive(
      tgz([
        { name: "./bin/codex", text: "c", mode: 0o4755 },
        { name: "PaxHeaders/1", type: "x", text: pax({ path: long }) },
        { name: "truncated", text: "pax" },
        { name: "././@LongLink", type: "L", text: `${long}2\0` },
        { name: "truncated2", text: "gnu" },
      ]),
    )
    expect(r.ok && r.value.map((f) => [f.rel, f.mode])).toEqual([
      ["bin/codex", 0o755],
      [long, 0o644],
      [`${long}2`, 0o644],
    ])
  })

  const refused: Record<string, Uint8Array> = {
    symlink: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }, { name: "bin/evil", type: "2", linkname: "/etc/passwd" }]),
    hardLink: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }, { name: "bin/evil", type: "1", linkname: "bin/codex" }]),
    device: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }, { name: "dev", type: "3" }]),
    traversal: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }, { name: "../outside", text: "x" }]),
    absolute: tgz([{ name: "/bin/codex", text: "c", mode: 0o755 }]),
    paxTraversal: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }, { name: "p", type: "x", text: pax({ path: "a/../../b" }) }, { name: "ok", text: "x" }]),
    noBinary: tgz([{ name: "README.md", text: "hi" }]),
    duplicate: tgz([{ name: "bin/codex", text: "a", mode: 0o755 }, { name: "bin/codex", text: "b", mode: 0o755 }]),
    badChecksum: tgz([{ name: "bin/codex", text: "c", mode: 0o755 }], { corruptChecksum: true }),
    notGzip: tar([{ name: "bin/codex", text: "c", mode: 0o755 }]),
    truncated: new Uint8Array(gzipSync(tar([{ name: "bin/codex", text: "c".repeat(2000), mode: 0o755 }]).slice(0, 1024))),
  }
  for (const [label, bytes] of Object.entries(refused))
    test(`refuses an archive with ${label}`, () => {
      const r = unpackCodexArchive(bytes)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("invalid")
    })

  test("refuses an archive that inflates past the limit", () => {
    const r = unpackCodexArchive(tgz([{ name: "bin/codex", text: "c".repeat(4096), mode: 0o755 }]), { maxBytes: 2048 })
    expect(!r.ok && r.code).toBe("invalid")
  })
})
