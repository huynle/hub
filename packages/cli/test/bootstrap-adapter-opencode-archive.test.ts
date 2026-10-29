// HBS-06: unpacking a verified OpenCode release archive into the immutable version tree (contract §3.6.1). Upstream
// ships one file, `opencode`, in a zip (macOS) or a tar.gz (Linux). The unpacker only turns bytes the executor
// already checked against hub's pinned digest into tree files, and refuses anything else an archive could smuggle
// in: links, devices, paths that climb out, absolute names, extra files, or no binary at all. HBS-12: it streams, so
// its limits hold while it inflates (a gzip bomb stops at the limit; a zip member never inflates past its size).
import { describe, expect, test } from "bun:test"
import { OPENCODE_BINARY_REL, unpackOpencodeArchive } from "../src/bootstrap/adapters/opencode/archive.ts"
import { FAKE_BINARY, tarGz, zip } from "./bootstrap/opencode-adapter-fixtures.ts"

const text = (b: Uint8Array) => new TextDecoder().decode(b)
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

describe("unpackOpencodeArchive", () => {
  test("the binary lands at bin/opencode, executable", async () => {
    expect(OPENCODE_BINARY_REL).toBe("bin/opencode")
    for (const [file, bytes] of [
      ["opencode-darwin-arm64.zip", zip([{ name: "opencode", content: FAKE_BINARY }])],
      ["opencode-darwin-x64.zip", zip([{ name: "opencode", content: FAKE_BINARY }], { store: true })],
      ["opencode-linux-x64.tar.gz", tarGz([{ name: "opencode", content: FAKE_BINARY }])],
      ["opencode-linux-arm64.tar.gz", tarGz([{ name: "./", type: "5" }, { name: "./opencode", content: FAKE_BINARY, mode: 0o644 }])],
    ] as const) {
      const r = await unpackOpencodeArchive(file, bytes)
      if (!r.ok) throw new Error(`${file}: ${r.message}`)
      expect(r.value.map((f) => ({ rel: f.rel, mode: f.mode, text: "bytes" in f ? text(f.bytes) : "" }))).toEqual([{ rel: "bin/opencode", mode: 0o755, text: FAKE_BINARY }])
    }
  })

  test("refuses links, devices, climbing or absolute paths", async () => {
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "opencode", type: "2", linkTarget: "/bin/sh" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "opencode", type: "1", linkTarget: "x" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "opencode", type: "3" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "../opencode", content: FAKE_BINARY }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "/usr/bin/opencode", content: FAKE_BINARY }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.zip", zip([{ name: "opencode", type: "link", linkTarget: "/bin/sh" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.zip", zip([{ name: "../../opencode", content: FAKE_BINARY }])))).toBe("invalid")
  })

  test("refuses an archive without the binary, or with anything beside it", async () => {
    expect(code(await unpackOpencodeArchive("o.zip", zip([{ name: "README", content: "x" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.zip", zip([{ name: "opencode", content: FAKE_BINARY }, { name: "postinstall.sh", content: "rm -rf ~" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([{ name: "opencode", content: FAKE_BINARY }, { name: "opencode", content: "again" }])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", tarGz([])))).toBe("invalid")
  })

  test("refuses unknown formats and corrupt bytes", async () => {
    expect(code(await unpackOpencodeArchive("opencode-desktop-mac-arm64.dmg", new Uint8Array([1, 2, 3])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.zip", new Uint8Array([1, 2, 3, 4])))).toBe("invalid")
    expect(code(await unpackOpencodeArchive("o.tar.gz", new Uint8Array([0x1f, 0x8b, 0, 0])))).toBe("invalid")
    const good = zip([{ name: "opencode", content: FAKE_BINARY }])
    expect(code(await unpackOpencodeArchive("o.zip", good.slice(0, good.byteLength - 30)))).toBe("invalid")
  })

  test("limits hold while streaming: a gzip bomb stops at the limit, a zip member never inflates past its size", async () => {
    const bomb = tarGz([{ name: "opencode", content: new Uint8Array(2 * 1024 * 1024) }])
    const r = await unpackOpencodeArchive("o.tar.gz", bomb, { maxBytes: 1024 * 1024 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/inflates beyond/)
    // A zip whose central directory understates the binary's size.
    const big = zip([{ name: "opencode", content: FAKE_BINARY.repeat(100) }])
    const view = new DataView(big.buffer, big.byteOffset, big.byteLength)
    for (let at = big.byteLength - 22; at >= 0; at--)
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 24, 10, true)
        break
      }
    const lying = await unpackOpencodeArchive("o.zip", big)
    expect(lying.ok).toBe(false)
    if (!lying.ok) expect(lying.message).toMatch(/recorded size/)
  })
})
