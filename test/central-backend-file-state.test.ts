// FileStateStore specifics (the shared contract is in central-backend-state.test.ts): data survives a restart,
// files live under <stateDir>/agent/ with owner-only modes, and names never escape that folder.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/central/backend/file-state"

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const stateDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-file-state-"))
  dirs.push(dir)
  return dir
}

/** Every file under a directory, relative to it. */
const files = (dir: string): string[] =>
  existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(path.join(dir, f)).isFile()).sort() : []

const mode = (file: string) => statSync(file).mode & 0o777

describe("FileStateStore persistence", () => {
  test("entries and versions survive a restart after flush", async () => {
    const dir = stateDir()
    const first = new FileStateStore({ stateDir: dir })
    await first.put("alice", "messages", "m1", { text: "hi" })
    await first.put("alice", "messages", "m1", { text: "hi again" })
    await first.put("alice", "messages", "m2", 2)
    await first.put("bob", "messages", "m1", "bob's")
    await first.flush()

    const second = new FileStateStore({ stateDir: dir })
    expect(await second.get("alice", "messages", "m1")).toEqual({ value: { text: "hi again" }, version: 2 })
    expect(await second.list("alice", "messages")).toEqual([
      { key: "m1", value: { text: "hi again" }, version: 2 },
      { key: "m2", value: 2, version: 1 },
    ])
    expect((await second.get("bob", "messages", "m1"))!.value).toBe("bob's")
    expect(await second.put("alice", "messages", "m1", "x", { ifVersion: 2 })).toEqual({ ok: true, version: 3 })
  })

  test("deletes survive a restart; an emptied collection leaves no file", async () => {
    const dir = stateDir()
    const first = new FileStateStore({ stateDir: dir })
    await first.put("alice", "c", "a", 1)
    await first.put("alice", "c", "b", 2)
    await first.flush()
    await first.delete("alice", "c", "a")
    await first.flush()
    expect((await new FileStateStore({ stateDir: dir }).list("alice", "c")).map((e) => e.key)).toEqual(["b"])
    await first.delete("alice", "c", "b")
    await first.flush()
    expect(await new FileStateStore({ stateDir: dir }).list("alice", "c")).toEqual([])
    expect(files(path.join(dir, "agent")).filter((f) => f.endsWith(".json"))).toEqual([])
  })

  test("claims survive a restart, releases too", async () => {
    const dir = stateDir()
    const first = new FileStateStore({ stateDir: dir, now: () => 42 })
    await first.claim("alice:names", "scout", "agent_1")
    await first.claim("alice:names", "gone", "agent_2")
    await first.release("alice:names", "gone", "agent_2")
    await first.flush()

    const second = new FileStateStore({ stateDir: dir, now: () => 99 })
    expect(await second.claimOf("alice:names", "scout")).toEqual({ namespace: "alice:names", key: "scout", owner: "agent_1", at: 42 })
    expect(await second.claimOf("alice:names", "gone")).toBeUndefined()
    expect(await second.claim("alice:names", "scout", "agent_3")).toMatchObject({ ok: false, conflict: { owner: "agent_1" } })
  })

  test("files are 0600 and folders 0700, all under <stateDir>/agent", async () => {
    const dir = stateDir()
    const state = new FileStateStore({ stateDir: dir })
    await state.put("alice", "messages", "m1", 1)
    await state.claim("ns", "k", "o")
    await state.flush()
    expect(readdirSync(dir)).toEqual(["agent"])
    const agent = path.join(dir, "agent")
    expect(mode(agent)).toBe(0o700)
    const written = files(agent)
    expect(written.length).toBe(2)
    for (const file of written) {
      expect(file.endsWith(".json")).toBe(true)
      expect(mode(path.join(agent, file))).toBe(0o600)
      let parent = path.dirname(path.join(agent, file))
      while (parent !== agent) {
        expect(mode(parent)).toBe(0o700)
        parent = path.dirname(parent)
      }
    }
  })

  test("hostile or case-differing ids and names stay inside the folder and apart", async () => {
    const dir = stateDir()
    const state = new FileStateStore({ stateDir: dir })
    const names = ["../../escape", "/abs", "a/b", "A", "a", ".", "..", "x".repeat(400), "nul\u0000byte", "ünï"]
    for (const name of names) {
      await state.put(name, name, "k", name)
      await state.claim(name, "k", name)
    }
    await state.flush()
    expect(readdirSync(dir)).toEqual(["agent"])
    expect(readdirSync(path.dirname(dir)).filter((f) => f === "escape")).toEqual([])

    const again = new FileStateStore({ stateDir: dir })
    for (const name of names) {
      expect((await again.get(name, name, "k"))!.value).toBe(name)
      expect((await again.claimOf(name, "k"))!.owner).toBe(name)
    }
  })

  test("an unreadable file is an error naming the file, and is left as it is", async () => {
    const dir = stateDir()
    const first = new FileStateStore({ stateDir: dir })
    await first.put("alice", "c", "k", 1)
    await first.flush()
    const [file] = files(path.join(dir, "agent"))
    await Bun.write(path.join(dir, "agent", file!), "{not json")
    const second = new FileStateStore({ stateDir: dir })
    await expect(second.get("alice", "c", "k")).rejects.toThrow(file!.split("/").pop()!)
    expect(await Bun.file(path.join(dir, "agent", file!)).text()).toBe("{not json")
  })
})
