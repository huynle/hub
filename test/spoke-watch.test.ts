import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig, type VoiceConfig } from "../src/config"
import { watchConfig } from "../src/spoke/watch"

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-watch-"))
  dirs.push(dir)
  return dir
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("watchConfig", () => {
  test("reads the current config and reports changes", async () => {
    const file = path.join(tempDir(), "config.json")
    writeConfig(file, { ...defaults("box"), mode: "always" })
    const seen: VoiceConfig[] = []
    const watcher = watchConfig(file, "box", (c) => seen.push(c), { pollMs: 50 })
    stops.push(watcher.stop)
    expect(watcher.current().mode).toBe("always")

    writeConfig(file, { ...defaults("box"), mode: "session", sessions: ["ses_a"] })
    await until(() => seen.length > 0)
    expect(seen.at(-1)).toMatchObject({ mode: "session", sessions: ["ses_a"] })
    expect(watcher.current().mode).toBe("session")
  })

  test("identical rewrites do not report a change", async () => {
    const file = path.join(tempDir(), "config.json")
    writeConfig(file, defaults("box"))
    let calls = 0
    const watcher = watchConfig(file, "box", () => calls++, { pollMs: 20 })
    stops.push(watcher.stop)
    writeConfig(file, defaults("box"))
    await Bun.sleep(150)
    expect(calls).toBe(0)
  })

  test("picks up a config whose directory does not exist yet (poll fallback)", async () => {
    const file = path.join(tempDir(), "later", "config.json")
    const seen: VoiceConfig[] = []
    const watcher = watchConfig(file, "box", (c) => seen.push(c), { pollMs: 20 })
    stops.push(watcher.stop)
    expect(watcher.current().mode).toBe("off")
    writeConfig(file, { ...defaults("box"), mode: "always", token: "tok" })
    await until(() => seen.length > 0)
    expect(seen.at(-1)).toMatchObject({ mode: "always", token: "tok" })
  })

  test("stop ends notifications", async () => {
    const file = path.join(tempDir(), "config.json")
    writeConfig(file, defaults("box"))
    let calls = 0
    const watcher = watchConfig(file, "box", () => calls++, { pollMs: 20 })
    watcher.stop()
    writeConfig(file, { ...defaults("box"), mode: "always" })
    await Bun.sleep(150)
    expect(calls).toBe(0)
  })

  test("refresh re-reads immediately and notifies on change", () => {
    const file = path.join(tempDir(), "config.json")
    writeConfig(file, defaults("box"))
    const seen: VoiceConfig[] = []
    const watcher = watchConfig(file, "box", (c) => seen.push(c), { pollMs: 10_000 })
    stops.push(watcher.stop)
    writeConfig(file, { ...defaults("box"), mode: "always" })
    expect(watcher.refresh().mode).toBe("always")
    expect(seen).toHaveLength(1)
  })
})
