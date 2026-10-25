// The spoke's use of the local hub starter: only for loopback servers with autoStartLocalHub on, the
// service process at once and standalone processes after a grace delay, a cooldown after failures,
// and an immediate reconnect once the hub answers. Enrolling against a local server starts it too.
import { networkInterfaces } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaults, writeConfig, type VoiceConfig } from "../src/config"
import type { LocalHubResult } from "../src/spoke/localhub"
import { Spoke, type SpokeHost, type SpokeOptions } from "../src/spoke/spoke"
import { EventQueue, fakeCentral, freePort, until, type FakeCentral } from "./spoke-fake"

/**
 * A server URL that is not loopback and fails fast without DNS: port 1 on this machine's first external IPv4
 * address (connection refused at once). A .invalid hostname would depend on the resolver, and some (e.g.
 * Tailscale MagicDNS) take seconds to answer for it.
 */
const REMOTE = (() => {
  const address = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address
  return `http://${address ?? "192.0.2.1"}:1`
})()

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function host(): SpokeHost {
  const events = new EventQueue<{ type: string; data: Record<string, unknown> }>()
  return {
    directory: "/work",
    opencodeVersion: "2.0.25",
    events: (signal) => events.iterate(signal),
    prompt: async () => ({ id: "msg_1" }),
    context: async () => [],
    getSession: async (id) => ({ id, location: { directory: "/work" }, time: { updated: 1 } }),
    replyPermission: async () => ({}),
    interrupt: async () => ({}),
    switchAgent: async () => ({}),
    switchModel: async () => undefined,
    hasAgent: async () => false,
    defaultAgent: async () => "build",
  }
}

interface Starter {
  calls: string[]
  /** What the next call does (default: start a fake hub on the server's port). */
  next: (server: string) => Promise<LocalHubResult>
  hubs: FakeCentral[]
  fn: (server: string) => Promise<LocalHubResult>
}

function starter(): Starter {
  const s: Starter = {
    calls: [],
    hubs: [],
    next: async (server) => {
      const hub = fakeCentral({ port: Number(new URL(server).port) })
      s.hubs.push(hub)
      cleanups.push(() => hub.stop())
      return { status: "started", pid: 1 }
    },
    fn: (server) => {
      s.calls.push(server)
      return s.next(server)
    },
  }
  return s
}

function setup(config: Partial<VoiceConfig>, extra: Partial<SpokeOptions> & { kind?: "service" | "standalone" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-autostart-"))
  const file = path.join(dir, "config.json")
  writeConfig(file, { ...defaults("box"), ...config })
  const spoke = new Spoke(host(), {
    configFile: file,
    machineName: "box",
    kind: "service",
    processID: "proc_test",
    pid: 4242,
    pluginVersion: "9.9.9",
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    pollMs: 20,
    // Without retryNow() the spoke would not try again within the test.
    backoff: { minMs: 60_000, maxMs: 60_000 },
    localHubDelayMs: 0,
    ...extra,
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => spoke.stop())
  spoke.start()
  return { spoke, file }
}

describe("auto-start on connection failure", () => {
  test("the service process starts the local hub and reconnects as soon as it answers", async () => {
    const s = starter()
    const server = `http://127.0.0.1:${freePort()}`
    const { spoke } = setup({ server, mode: "always", token: "tok" }, { localHub: s.fn })
    await until(() => spoke.status().connection === "connected")
    expect(s.calls).toEqual([server])
    expect(s.hubs[0]!.auth).toEqual(["Bearer tok"])
  })

  test("a standalone process waits the grace delay first (the service may start it)", async () => {
    const s = starter()
    const server = `http://127.0.0.1:${freePort()}`
    const { spoke } = setup({ server, mode: "always", token: "tok" }, { kind: "standalone", localHub: s.fn, localHubDelayMs: 300 })
    await until(() => spoke.status().connection === "error")
    await Bun.sleep(100)
    expect(s.calls).toHaveLength(0)
    await until(() => spoke.status().connection === "connected", 3000)
    expect(s.calls).toHaveLength(1)
  })

  test("never for a server that is not loopback", async () => {
    const s = starter()
    const { spoke } = setup({ server: REMOTE, mode: "always", token: "tok" }, { localHub: s.fn, backoff: { minMs: 10, maxMs: 20 } })
    await until(() => spoke.status().connection === "error")
    await Bun.sleep(150)
    expect(s.calls).toHaveLength(0)
  })

  test("never when autoStartLocalHub is off", async () => {
    const s = starter()
    const { spoke } = setup(
      { server: `http://127.0.0.1:${freePort()}`, mode: "always", token: "tok", autoStartLocalHub: false },
      { localHub: s.fn, backoff: { minMs: 10, maxMs: 20 } },
    )
    await until(() => spoke.status().connection === "error")
    await Bun.sleep(150)
    expect(s.calls).toHaveLength(0)
  })

  test("never without a starter (tests and embedders opt in)", async () => {
    const { spoke } = setup({ server: `http://127.0.0.1:${freePort()}`, mode: "always", token: "tok" }, { backoff: { minMs: 10, maxMs: 20 } })
    await until(() => spoke.status().connection === "error")
    expect(spoke.status().localHub).toBeUndefined()
  })

  test("a failed start is reported in the status and not retried before the cooldown", async () => {
    const s = starter()
    s.next = async () => ({ status: "failed", error: "The local hub exited with code 1; see /x/hub.log" })
    const { spoke } = setup(
      { server: `http://127.0.0.1:${freePort()}`, mode: "always", token: "tok" },
      { localHub: s.fn, backoff: { minMs: 10, maxMs: 20 }, localHubRetryMs: 60_000 },
    )
    await until(() => spoke.status().localHub !== undefined)
    expect(spoke.status().localHub).toContain("hub.log")
    await Bun.sleep(200)
    expect(s.calls).toHaveLength(1)
  })

  test("after the cooldown it tries again", async () => {
    const s = starter()
    let fail = true
    const start = s.next
    s.next = async (server) => (fail ? ((fail = false), { status: "failed", error: "nope" }) : start(server))
    const { spoke } = setup(
      { server: `http://127.0.0.1:${freePort()}`, mode: "always", token: "tok" },
      { localHub: s.fn, backoff: { minMs: 10, maxMs: 20 }, localHubRetryMs: 100 },
    )
    await until(() => spoke.status().connection === "connected", 10_000)
    // Tried again after the cooldown. Under load a third check may run before the WebSocket handshake
    // completes (the next cooldown is only 200 ms here), so only require the retry, not an exact count.
    expect(s.calls.length).toBeGreaterThanOrEqual(2)
    expect(spoke.status().localHub).toBeUndefined()
  })
})

describe("cooldown timer", () => {
  test("a cooldown timer that fires a little early (Linux) still retries", async () => {
    // Timers may fire a moment before Date.now() reaches the deadline. Simulate that with a wall clock
    // running at half the timers' speed, so every cooldown timer fires "early".
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0 + (realNow() - t0) / 2
    cleanups.push(() => (Date.now = realNow))
    const s = starter()
    let fail = true
    const start = s.next
    s.next = async (server) => (fail ? ((fail = false), { status: "failed", error: "nope" }) : start(server))
    const { spoke } = setup(
      { server: `http://127.0.0.1:${freePort()}`, mode: "always", token: "tok" },
      { localHub: s.fn, backoff: { minMs: 10, maxMs: 20 }, localHubRetryMs: 100 },
    )
    await until(() => spoke.status().connection === "connected", 3000)
    expect(s.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe("enroll with a local server", () => {
  test("starts the hub when nothing answers, then enrolls (even from a standalone process)", async () => {
    const s = starter()
    const server = `http://127.0.0.1:${freePort()}`
    const { spoke } = setup({ server }, { kind: "standalone", localHub: s.fn, localHubDelayMs: 60_000 })
    const result = await spoke.enroll()
    expect(result).toMatchObject({ userCode: "ABCD-EFGH", localHub: "started" })
    expect(s.calls).toEqual([server])
  })

  test("waits for a hub another process is starting", async () => {
    const s = starter()
    const port = freePort()
    s.next = async (server) => {
      setTimeout(() => {
        const hub = fakeCentral({ port })
        cleanups.push(() => hub.stop())
      }, 300)
      void server
      return { status: "busy", pid: 99 }
    }
    const { spoke } = setup({ server: `http://127.0.0.1:${port}` }, { localHub: s.fn })
    expect(await spoke.enroll()).toMatchObject({ userCode: "ABCD-EFGH" })
  })

  test("reports the starter's error when the hub cannot start", async () => {
    const s = starter()
    s.next = async () => ({ status: "failed", error: "The local hub exited with code 1; see /x/hub.log" })
    const { spoke } = setup({ server: `http://127.0.0.1:${freePort()}` }, { localHub: s.fn })
    await expect(spoke.enroll()).rejects.toMatchObject({ name: "unreachable", message: expect.stringContaining("hub.log") })
  })

  test("a remote server is never started", async () => {
    const s = starter()
    const { spoke } = setup({ server: REMOTE }, { localHub: s.fn })
    await expect(spoke.enroll()).rejects.toMatchObject({ name: "unreachable" })
    expect(s.calls).toHaveLength(0)
  })

  test("passes on a local hub's auto-approval", async () => {
    const server = fakeCentral({ enrollExtra: { autoApproved: true } })
    server.pollReplies = [{ status: "approved", machineID: "m_1", machineToken: "tok_auto" }]
    cleanups.push(() => server.stop())
    const { spoke } = setup({ server: server.url, mode: "always" })
    expect(await spoke.enroll()).toMatchObject({ autoApproved: true })
    await until(() => spoke.status().connection === "connected")
  })
})

describe("startLocalHub (explicit, from /voice)", () => {
  test("starts the hub for a loopback server and reconnects at once, even with auto-start off", async () => {
    const s = starter()
    const server = `http://127.0.0.1:${freePort()}`
    const { spoke } = setup({ server, mode: "always", token: "tok", autoStartLocalHub: false }, { kind: "standalone", localHub: s.fn, localHubDelayMs: 60_000 })
    expect(await spoke.startLocalHub()).toEqual({ status: "started" })
    expect(s.calls).toEqual([server])
    await until(() => spoke.status().connection === "connected")
  })

  test("already running: nothing is started", async () => {
    const s = starter()
    s.next = async () => ({ status: "running" })
    const { spoke } = setup({ server: `http://127.0.0.1:${freePort()}`, mode: "off" }, { localHub: s.fn })
    expect(await spoke.startLocalHub()).toEqual({ status: "running" })
  })

  test("a remote server is refused; a failed start reports why", async () => {
    const s = starter()
    const remote = setup({ server: "https://voice.example.com" }, { localHub: s.fn })
    await expect(remote.spoke.startLocalHub()).rejects.toMatchObject({ name: "invalid" })
    s.next = async () => ({ status: "failed", error: "bun exited; see /tmp/hub.log" })
    const local = setup({ server: `http://127.0.0.1:${freePort()}` }, { localHub: s.fn })
    await expect(local.spoke.startLocalHub()).rejects.toMatchObject({ name: "unreachable", message: expect.stringContaining("hub.log") })
    expect(s.calls).toHaveLength(1)
  })
})
