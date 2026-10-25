// A launch-bound spoke (inside a launch's sandbox, design §6.4): it connects with the launch's token and announces the
// launchID in its hello, never enrols, never starts a local hub, never reads or writes the machine config.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LaunchConfig } from "../src/config"
import type { LocalHubResult } from "../src/spoke/localhub"
import { Spoke, SpokeError, type SpokeHost, type SpokeOptions } from "../src/spoke/spoke"
import { EventQueue, fakeCentral, freePort, until } from "./spoke-fake"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function host(): SpokeHost {
  const events = new EventQueue<{ type: string; data: Record<string, unknown> }>()
  return {
    directory: "/sandbox/work",
    opencodeVersion: "2.0.25",
    events: (signal) => events.iterate(signal),
    prompt: async () => ({ id: "msg_1" }),
    context: async () => [],
    getSession: async (id) => ({ id, location: { directory: "/sandbox/work" }, time: { updated: 1 } }),
    replyPermission: async () => ({}),
    interrupt: async () => ({}),
    switchAgent: async () => ({}),
    switchModel: async () => undefined,
    hasAgent: async () => false,
    defaultAgent: async () => "build",
  }
}

function setup(launch: LaunchConfig, extra: Partial<SpokeOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-launch-spoke-"))
  // The machine config path: a launch-bound spoke must never create it.
  const file = path.join(dir, "config.json")
  const localHub: string[] = []
  const herdr: string[][] = []
  const spoke = new Spoke(host(), {
    configFile: file,
    machineName: "sandbox",
    kind: "service",
    processID: "proc_launch",
    pid: 7,
    pluginVersion: "9.9.9",
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    pollMs: 20,
    backoff: { minMs: 10, maxMs: 20 },
    localHubDelayMs: 0,
    localHub: async (server): Promise<LocalHubResult> => {
      localHub.push(server)
      return { status: "started", pid: 1 }
    },
    herdr: async (args) => {
      herdr.push(args)
      return "[]"
    },
    herdrPollMs: { agents: 10, workspaces: 10 },
    launch,
    ...extra,
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => spoke.stop())
  spoke.start()
  return { spoke, file, localHub, herdr }
}

describe("launch-bound spoke", () => {
  test("connects with the launch token and sends launchID in its hello, mode always", async () => {
    const server = fakeCentral()
    cleanups.push(() => server.stop())
    const { spoke, file } = setup({ hubURL: server.url, token: "hlt1.tok", launchID: "lch_1" })
    await until(() => spoke.status().connection === "connected")
    expect(server.auth).toEqual(["Bearer hlt1.tok"])
    const hello = server.frames[0] as unknown as Record<string, unknown>
    expect(hello.t).toBe("hello")
    expect(hello.launchID).toBe("lch_1")
    expect(hello.mode).toBe("always")
    expect(spoke.status()).toMatchObject({ server: server.url, mode: "always", enrolled: true, connection: "connected" })
    expect(existsSync(file)).toBe(false)
  })

  test("never enrols and never writes a config", async () => {
    const server = fakeCentral()
    cleanups.push(() => server.stop())
    const { spoke, file } = setup({ hubURL: server.url, token: "hlt1.tok", launchID: "lch_1" })
    await expect(spoke.enroll()).rejects.toMatchObject({ name: "invalid", message: expect.stringMatching(/launch/) })
    for (const change of [() => spoke.setServer("http://elsewhere:1"), () => spoke.setMode("off"), () => spoke.setSession("ses_a", true)]) {
      expect(change).toThrow(SpokeError)
      expect(change).toThrow(/launch/)
    }
    expect(existsSync(file)).toBe(false)
  })

  test("never starts a local hub, on failure or when asked", async () => {
    const { spoke, localHub } = setup({ hubURL: `http://127.0.0.1:${freePort()}`, token: "hlt1.tok", launchID: "lch_1" })
    await until(() => spoke.status().connection === "error")
    await Bun.sleep(100)
    expect(localHub).toEqual([])
    await expect(spoke.startLocalHub()).rejects.toMatchObject({ name: "invalid", message: expect.stringMatching(/launch/) })
    expect(localHub).toEqual([])
  })

  test("never reads Herdr, even as the service process", async () => {
    const server = fakeCentral()
    cleanups.push(() => server.stop())
    const { spoke, herdr } = setup({ hubURL: server.url, token: "hlt1.tok", launchID: "lch_1" })
    await until(() => spoke.status().connection === "connected")
    await Bun.sleep(60)
    expect(herdr).toEqual([])
  })
})

test("without a launch config (and no machine config) the spoke stays off", async () => {
  const server = fakeCentral()
  cleanups.push(() => server.stop())
  const { spoke } = setup({ hubURL: server.url, token: "x", launchID: "lch_1" }, { launch: undefined })
  // Not launch-bound and no machine config: stays off and never connects.
  await Bun.sleep(60)
  expect(spoke.status().connection).toBe("off")
  expect(server.frames).toEqual([])
})
