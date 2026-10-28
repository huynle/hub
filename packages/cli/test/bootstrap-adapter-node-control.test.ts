// Service control for the launch node: fixed-argv calls to `systemctl --user` and `launchctl` only, behind an
// injectable runner (every test uses a fake; nothing here touches the real service manager), activation that rolls
// back to the service's prior state, and the activate-service executor inside the transactional applier.
import { afterEach, describe, expect, test } from "bun:test"
import type { Action, SetupPlan } from "../src/bootstrap/contracts/index.ts"
import {
  activateServiceExecutor,
  checkManagerCall,
  createServiceControl,
  spawnManagerRunner,
  unitPathResolver,
  type ManagerCall,
} from "../src/bootstrap/adapters/node-services/control.ts"
import { ACTIONS, DISCOVERY_DARWIN } from "./bootstrap/fixtures.ts"
import { FakeManager } from "./bootstrap/node-services-fixtures.ts"
import { digestOfText, SERVICE_UNIT, World } from "./bootstrap/transaction-fixtures.ts"

const LINUX_ROOTS = [{ id: "systemd-user" as const, path: "/home/dev/.config/systemd/user" }]
const unitPath = unitPathResolver(DISCOVERY_DARWIN.roots, "host")
const linuxUnitPath = unitPathResolver(LINUX_ROOTS, "host")
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

describe("fixed-argv service control", () => {
  test("systemd --user activation: reload, enable, restart, then check it is active", async () => {
    const m = new FakeManager()
    const control = createServiceControl({ run: m.run, uid: 1000, unitPath: linuxUnitPath })
    expect(codeOf(await control.activate("node", "systemd-user"))).toBe("ok")
    expect(m.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable hub-node.service",
      "systemctl --user restart hub-node.service",
      "systemctl --user is-active --quiet hub-node.service",
    ])
  })

  test("launchd activation: bootout (if loaded), bootstrap the agent from its unit path, then check it is loaded", async () => {
    const m = new FakeManager()
    const control = createServiceControl({ run: m.run, uid: 501, unitPath })
    expect(codeOf(await control.activate("node", "launchd"))).toBe("ok")
    expect(m.calls).toEqual([
      "launchctl bootout gui/501/io.github.huynle.hub-node",
      "launchctl bootstrap gui/501 /Users/dev/Library/LaunchAgents/io.github.huynle.hub-node.plist",
      "launchctl print gui/501/io.github.huynle.hub-node",
    ])
  })

  test("deactivation on both managers; an already unloaded launchd agent is fine", async () => {
    const m = new FakeManager({ loaded: ["hub-codex-spoke.service"], enabled: ["hub-codex-spoke.service"] })
    const linux = createServiceControl({ run: m.run, uid: 1000, unitPath: linuxUnitPath })
    expect(codeOf(await linux.deactivate("codex-spoke", "systemd-user"))).toBe("ok")
    expect(m.calls).toEqual(["systemctl --user disable hub-codex-spoke.service", "systemctl --user stop hub-codex-spoke.service", "systemctl --user daemon-reload"])
    expect(m.loaded.size + m.enabled.size).toBe(0)
    const mac = createServiceControl({ run: m.run, uid: 501, unitPath })
    expect(codeOf(await mac.deactivate("codex-spoke", "launchd"))).toBe("ok")
  })

  test("a service that does not come up is a failure that names the unit and the exit, nothing else", async () => {
    const m = new FakeManager()
    m.broken.add("io.github.huynle.hub-node")
    const control = createServiceControl({ run: m.run, uid: 501, unitPath })
    const r = await control.activate("node", "launchd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("launchctl bootstrap of io.github.huynle.hub-node failed (exit 5)")
    const linux = new FakeManager()
    linux.broken.add("hub-node.service")
    const r2 = await createServiceControl({ run: linux.run, uid: 1000, unitPath: linuxUnitPath }).activate("node", "systemd-user")
    expect(r2.ok ? "" : r2.message).toBe("hub-node.service did not start (systemctl --user is-active)")
  })

  test("state reports loaded and enabled", async () => {
    const m = new FakeManager({ loaded: ["hub-node.service"] })
    const control = createServiceControl({ run: m.run, uid: 1000, unitPath: linuxUnitPath })
    expect(await control.state("node", "systemd-user")).toEqual({ ok: true, value: { loaded: true, enabled: false } })
  })

  test("refuses a launchd agent without a mapped unit directory, and a bad uid, before any call", async () => {
    const m = new FakeManager()
    const control = createServiceControl({ run: m.run, uid: 501, unitPath: unitPathResolver([], "host") })
    expect(codeOf(await control.activate("node", "launchd"))).toBe("invalid")
    expect(() => createServiceControl({ run: m.run, uid: -1, unitPath })).toThrow()
    expect(m.calls).toEqual([])
  })
})

describe("checkManagerCall: only the fixed calls", () => {
  const ok = (call: ManagerCall) => expect(checkManagerCall(call)).toBe(true)
  const refused = (call: unknown) => expect(checkManagerCall(call)).toBe(false)

  test("accepts the calls control makes", () => {
    ok({ program: "systemctl", words: ["--user", "restart", "hub-node.service"] })
    ok({ program: "systemctl", words: ["--user", "daemon-reload"] })
    ok({ program: "launchctl", words: ["bootstrap", "gui/501", "/Users/dev/Library/LaunchAgents/io.github.huynle.hub-node.plist"] })
    ok({ program: "launchctl", words: ["print", "gui/501/io.github.huynle.hub-node"] })
  })

  test("refuses anything else", () => {
    refused({ program: "sh", words: ["-c", "true"] })
    refused({ program: "loginctl", words: ["enable-linger"] })
    refused({ program: "systemctl", words: ["restart", "hub-node.service"] })
    refused({ program: "systemctl", words: ["--system", "restart", "hub-node.service"] })
    refused({ program: "systemctl", words: ["--user", "restart", "sshd.service"] })
    refused({ program: "systemctl", words: ["--user", "edit", "hub-node.service"] })
    refused({ program: "systemctl", words: ["--user", "set-environment", "X=1"] })
    refused({ program: "launchctl", words: ["bootstrap", "system", "/Library/LaunchDaemons/evil.plist"] })
    refused({ program: "launchctl", words: ["bootstrap", "gui/501", "relative.plist"] })
    refused({ program: "launchctl", words: ["bootstrap", "gui/501", "/tmp/io.github.huynle.hub-node.plist\n"] })
    refused({ program: "launchctl", words: ["setenv", "X", "1"] })
    refused({ program: "launchctl", words: ["print", "gui/501/com.apple.evil"] })
  })
})

describe("spawnManagerRunner", () => {
  test("spawns the absolute program with the fixed words, no shell, no inherited environment", async () => {
    const seen: unknown[] = []
    const run = spawnManagerRunner({
      programs: { systemctl: "/usr/bin/systemctl", launchctl: "/bin/launchctl" },
      spawn: async (file, words, options) => (seen.push({ file, words, options }), 0),
    })
    expect(await run({ program: "systemctl", words: ["--user", "daemon-reload"] })).toEqual({ exitCode: 0 })
    expect(seen).toEqual([{ file: "/usr/bin/systemctl", words: ["--user", "daemon-reload"], options: { shell: false, env: {}, timeoutMs: 30_000 } }])
  })

  test("never spawns a call outside the fixed set, or a relative program", async () => {
    let spawned = 0
    const spawn = async () => (spawned++, 0)
    const run = spawnManagerRunner({ programs: { systemctl: "/usr/bin/systemctl", launchctl: "/bin/launchctl" }, spawn })
    await expect(run({ program: "systemctl", words: ["--user", "edit", "hub-node.service"] })).rejects.toThrow()
    expect(() => spawnManagerRunner({ programs: { systemctl: "systemctl", launchctl: "/bin/launchctl" }, spawn })).toThrow()
    expect(spawned).toBe(0)
  })
})

describe("activate-service in the applier: rollback to the prior state", () => {
  let worlds: World[] = []
  afterEach(() => {
    for (const w of worlds) w.cleanup()
    worlds = []
  })
  const INSTALL = { ...(ACTIONS["install-service"] as Extract<Action, { kind: "install-service" }>), sha256: digestOfText(SERVICE_UNIT) } as Action
  const only = (actions: readonly Action[]) => (p: SetupPlan): SetupPlan => ({ ...p, requiresEscalation: false, activatesServices: actions.some((a) => a.kind === "activate-service"), actions: [...actions] })

  async function apply(m: FakeManager, actions: readonly Action[], options: { verifyFails?: boolean; confirm?: boolean } = {}) {
    const w = new World({ verifyFails: options.verifyFails })
    worlds.push(w)
    const control = createServiceControl({ run: m.run, uid: 501, unitPath: unitPathResolver(w.box.roots, "host") })
    const executors = { ...w.executors(), "activate-service": activateServiceExecutor(control) }
    const replan = w.replan(only(actions))
    const r = await w.applier({ executors }).apply({ token: w.token((await replan()).plan), replan, consent: { confirmActivation: options.confirm ?? true } })
    return { r, w }
  }

  test("activates after the unit is written", async () => {
    const m = new FakeManager()
    const { r } = await apply(m, [INSTALL, ACTIONS["activate-service"]])
    expect(codeOf(r)).toBe("ok")
    expect(m.loaded.has("io.github.huynle.hub-node")).toBe(true)
  })

  test("a later failure unloads a service that was not loaded before", async () => {
    const m = new FakeManager()
    const { r } = await apply(m, [INSTALL, ACTIONS["activate-service"], ACTIONS["verify-harness"]], { verifyFails: true })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(m.loaded.has("io.github.huynle.hub-node")).toBe(false)
    expect(m.calls.slice(-2)).toEqual(["launchctl bootout gui/501/io.github.huynle.hub-node", "launchctl print gui/501/io.github.huynle.hub-node"])
  })

  test("a later failure leaves a service that was already loaded loaded", async () => {
    const m = new FakeManager({ loaded: ["io.github.huynle.hub-node"] })
    const { r } = await apply(m, [INSTALL, ACTIONS["activate-service"], ACTIONS["verify-harness"]], { verifyFails: true })
    expect(codeOf(r)).toBe("harness_not_ready")
    expect(m.loaded.has("io.github.huynle.hub-node")).toBe(true)
  })

  test("without --confirm-activation nothing is loaded", async () => {
    const m = new FakeManager()
    const { r } = await apply(m, [INSTALL, ACTIONS["activate-service"]], { confirm: false })
    expect(codeOf(r)).toBe("needs_user")
    expect(m.calls).toEqual([])
  })

  test("the executor itself refuses an activation that is not explicit", async () => {
    const exec = activateServiceExecutor(createServiceControl({ run: new FakeManager().run, uid: 501, unitPath }))
    const r = await exec.check!({ ...(ACTIONS["activate-service"] as Extract<Action, { kind: "activate-service" }>), confirm: "auto" as "explicit" }, {} as never)
    expect(codeOf(r)).toBe("needs_user")
  })
})

describe("nodeServiceExecutors", () => {
  test("adds the activate-service and launch-session executors; without their sources both refuse at preflight", async () => {
    const { nodeServiceExecutors } = await import("../src/bootstrap/adapters/node-services/index.ts")
    const map = nodeServiceExecutors({})
    expect(Object.keys(map).sort()).toEqual(["activate-service", "launch-session"])
    expect(codeOf(await map["activate-service"]!.check!(ACTIONS["activate-service"] as never, {} as never))).toBe("internal")
    expect(codeOf(await map["launch-session"]!.check!(ACTIONS["launch-session"] as never, {} as never))).toBe("internal")
  })
})
