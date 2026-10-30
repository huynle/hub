// Service control for the launch node: fixed-argv calls to `systemctl --user` and `launchctl` only, behind an
// injectable runner (every test uses a fake; nothing here touches the real service manager), activation that rolls
// back to the service's prior state, a health check after loading (a crash-looping unit is service_failed, never
// "applied"), and the activate-service executor inside the transactional applier.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { exitFor, type Action, type SetupPlan } from "../src/bootstrap/contracts/index.ts"
import {
  activateServiceExecutor,
  checkManagerCall,
  createServiceControl,
  HEALTH_WINDOW,
  launchdHealth,
  spawnManagerRunner,
  systemdHealth,
  unitPathResolver,
  type ManagerCall,
  type ManagerRunner,
} from "../src/bootstrap/adapters/node-services/control.ts"
import { ACTIONS, DISCOVERY_DARWIN } from "./bootstrap/fixtures.ts"
import { FakeManager, type FakeHealth } from "./bootstrap/node-services-fixtures.ts"
import { digestOfText, SERVICE_UNIT, World } from "./bootstrap/transaction-fixtures.ts"

const LINUX_ROOTS = [{ id: "systemd-user" as const, path: "/home/dev/.config/systemd/user" }]
const unitPath = unitPathResolver(DISCOVERY_DARWIN.roots, "host")
const linuxUnitPath = unitPathResolver(LINUX_ROOTS, "host")
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)
const SHOW_NODE = "systemctl --user show --property=ActiveState,SubState,NRestarts hub-node.service"
const PRINT_NODE = "launchctl print gui/501/io.github.huynle.hub-node"

/** A clock that only moves when the control sleeps: the health window takes no real time. */
function fakeClock() {
  const clock = { t: 0, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) }
  return clock
}
const controlOf = (run: ManagerRunner, uid: number, paths = uid === 501 ? unitPath : linuxUnitPath, clock = fakeClock()) => createServiceControl({ run, uid, unitPath: paths, clock })

describe("fixed-argv service control", () => {
  test("systemd --user activation: reload, enable, restart, then watch it stay running for the stable window", async () => {
    const m = new FakeManager()
    const control = controlOf(m.run, 1000)
    expect(codeOf(await control.activate("node", "systemd-user"))).toBe("ok")
    const polls = HEALTH_WINDOW.stableMs / HEALTH_WINDOW.pollMs + 1
    expect(m.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable hub-node.service",
      "systemctl --user restart hub-node.service",
      ...Array<string>(polls).fill(SHOW_NODE),
    ])
  })

  test("launchd activation: bootout (if loaded), bootstrap the agent from its unit path, then watch it stay running", async () => {
    const m = new FakeManager()
    const control = controlOf(m.run, 501)
    expect(codeOf(await control.activate("node", "launchd"))).toBe("ok")
    const polls = HEALTH_WINDOW.stableMs / HEALTH_WINDOW.pollMs + 1
    expect(m.calls).toEqual([
      "launchctl bootout gui/501/io.github.huynle.hub-node",
      "launchctl bootstrap gui/501 /Users/dev/Library/LaunchAgents/io.github.huynle.hub-node.plist",
      ...Array<string>(polls).fill(PRINT_NODE),
    ])
  })

  test("deactivation on both managers; an already unloaded launchd agent is fine", async () => {
    const m = new FakeManager({ loaded: ["hub-codex-spoke.service"], enabled: ["hub-codex-spoke.service"] })
    const linux = controlOf(m.run, 1000)
    expect(codeOf(await linux.deactivate("codex-spoke", "systemd-user"))).toBe("ok")
    expect(m.calls).toEqual(["systemctl --user disable hub-codex-spoke.service", "systemctl --user stop hub-codex-spoke.service", "systemctl --user daemon-reload"])
    expect(m.loaded.size + m.enabled.size).toBe(0)
    const mac = controlOf(m.run, 501)
    expect(codeOf(await mac.deactivate("codex-spoke", "launchd"))).toBe("ok")
  })

  test("a service that does not come up is a failure that names the unit and the exit, nothing else", async () => {
    const m = new FakeManager()
    m.broken.add("io.github.huynle.hub-node")
    const control = controlOf(m.run, 501)
    const r = await control.activate("node", "launchd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("launchctl bootstrap of io.github.huynle.hub-node failed (exit 5)")
    const linux = new FakeManager()
    linux.broken.add("hub-node.service")
    const r2 = await controlOf(linux.run, 1000).activate("node", "systemd-user")
    expect(r2.ok ? "" : r2.code).toBe("service_failed")
    expect(r2.ok ? "" : r2.message).toBe("hub-node.service is not running (inactive/dead); see journalctl --user -u hub-node.service")
  })

  test("state reports loaded and enabled", async () => {
    const m = new FakeManager({ loaded: ["hub-node.service"] })
    const control = controlOf(m.run, 1000)
    expect(await control.state("node", "systemd-user")).toEqual({ ok: true, value: { loaded: true, enabled: false } })
  })

  test("refuses a launchd agent without a mapped unit directory, and a bad uid, before any call", async () => {
    const m = new FakeManager()
    const control = controlOf(m.run, 501, unitPathResolver([], "host"))
    expect(codeOf(await control.activate("node", "launchd"))).toBe("invalid")
    expect(() => createServiceControl({ run: m.run, uid: -1, unitPath })).toThrow()
    expect(m.calls).toEqual([])
  })
})

describe("activation health: a loaded service must stay running", () => {
  const systemd = (script: FakeHealth[]) => {
    const m = new FakeManager()
    m.health.set("hub-node.service", script)
    return { m, control: controlOf(m.run, 1000) }
  }
  const launchd = (script: FakeHealth[]) => {
    const m = new FakeManager()
    m.health.set("io.github.huynle.hub-node", script)
    return { m, control: controlOf(m.run, 501) }
  }

  test("the windows are short and bounded", () => {
    expect(HEALTH_WINDOW).toEqual({ timeoutMs: 10_000, stableMs: 3_000, pollMs: 500 })
    expect(exitFor("service_failed")).toBe(15)
  })

  test("systemd: a crash-looping unit (Restart=on-failure, auto-restart) is service_failed with a journalctl hint", async () => {
    const { control } = systemd(["running", "auto-restart"])
    const r = await control.activate("node", "systemd-user")
    expect(codeOf(r)).toBe("service_failed")
    expect(r.ok ? "" : r.message).toBe("hub-node.service is crash-looping (activating/auto-restart, 1 restart); see journalctl --user -u hub-node.service")
  })

  test("systemd: a failed unit is service_failed", async () => {
    const { control } = systemd(["failed"])
    const r = await control.activate("node", "systemd-user")
    expect(r.ok ? "" : r.message).toBe("hub-node.service failed (failed/failed, 1 restart); see journalctl --user -u hub-node.service")
  })

  test("systemd: a restart between two running samples is service_failed", async () => {
    const m = new FakeManager()
    const outputs = ["NRestarts=0\nActiveState=active\nSubState=running\n", "NRestarts=2\nActiveState=active\nSubState=running\n"]
    const run: ManagerRunner = async (call) => (call.words[1] === "show" ? { exitCode: 0, output: outputs.length > 1 ? outputs.shift()! : outputs[0]! } : m.run(call))
    const r = await controlOf(run, 1000).activate("node", "systemd-user")
    expect(codeOf(r)).toBe("service_failed")
    expect(r.ok ? "" : r.message).toContain("restarted 2 times while it was watched")
  })

  test("systemd: a slow start that settles is fine; one that never settles within the window is service_failed", async () => {
    const slow = systemd(["activating", "activating", "activating", "activating", "running"])
    expect(codeOf(await slow.control.activate("node", "systemd-user"))).toBe("ok")
    const stuck = systemd(["activating"])
    const clock = fakeClock()
    const r = await createServiceControl({ run: stuck.m.run, uid: 1000, unitPath: linuxUnitPath, clock }).activate("node", "systemd-user")
    expect(codeOf(r)).toBe("service_failed")
    expect(r.ok ? "" : r.message).toBe(`hub-node.service did not stay running within ${HEALTH_WINDOW.timeoutMs / 1000} s (activating/start); see journalctl --user -u hub-node.service`)
    expect(clock.t).toBeLessThanOrEqual(HEALTH_WINDOW.timeoutMs + HEALTH_WINDOW.pollMs)
  })

  test("launchd: a crash-looping agent is service_failed with its log path, and print output never reaches the message", async () => {
    const { m, control } = launchd(["running", "auto-restart"])
    m.printExtra = "\tenvironment = {\n\t\tHUB_TOKEN => mt_planted_secret\n\t}\n"
    const r = await control.activate("node", "launchd")
    expect(codeOf(r)).toBe("service_failed")
    expect(r.ok ? "" : r.message).toBe(
      "io.github.huynle.hub-node is crash-looping (spawn scheduled, last exit code 1, 1 restart); see ~/.local/state/hub/node.log and launchctl print gui/501/io.github.huynle.hub-node",
    )
    expect(r.ok ? "" : r.message).not.toContain("mt_planted_secret")
  })

  test("launchd: a slow first spawn that then runs is fine", async () => {
    const { control } = launchd(["activating", "activating", "running"])
    expect(codeOf(await control.activate("node", "launchd"))).toBe("ok")
  })

  test("the executor unloads a service that was not loaded before when it fails its health check", async () => {
    const m = new FakeManager()
    m.health.set("hub-node.service", ["auto-restart"])
    const exec = activateServiceExecutor(controlOf(m.run, 1000))
    const action = { ...(ACTIONS["activate-service"] as Extract<Action, { kind: "activate-service" }>), manager: "systemd-user" as const }
    const change = await exec.change(action, {} as never)
    if (!change.ok || change.value.type !== "effect") throw new Error("expected an effect")
    const r = await change.value.perform()
    expect(codeOf(r)).toBe("service_failed")
    expect(r.ok ? "" : r.message).toContain("it was unloaded again")
    expect(m.loaded.has("hub-node.service")).toBe(false)
    expect(m.enabled.has("hub-node.service")).toBe(false)
  })
})

describe("state parsing", () => {
  test("systemctl show: the three fields, any order; anything that is not a state word is unknown", () => {
    expect(systemdHealth("SubState=running\nNRestarts=0\nActiveState=active\n")).toEqual({ state: "running", restarts: 0, detail: "active/running" })
    expect(systemdHealth("ActiveState=activating\nSubState=auto-restart-queued\nNRestarts=4\n")).toEqual({ state: "crash-looping", restarts: 4, detail: "activating/auto-restart-queued" })
    expect(systemdHealth("ActiveState=inactive\nSubState=dead\nNRestarts=0\n").state).toBe("stopped")
    expect(systemdHealth("ActiveState=mt_secret=token;rm\nSubState=x\n").detail).toBe("unknown/x")
    expect(systemdHealth("").state).toBe("stopped")
  })

  test("launchctl print: the top-level state wins over a nested one; a respawn after an exit is crash-looping", () => {
    const nested = "gui/501/x = {\n\tendpoints = {\n\t\tstate = active\n\t}\n\tstate = running\n\truns = 1\n\tlast exit code = (never exited)\n}\n"
    expect(launchdHealth(nested)).toEqual({ state: "running", restarts: 0, detail: "running" })
    expect(launchdHealth("\tstate = spawn scheduled\n\truns = 3\n\tlast exit code = 1\n")).toEqual({ state: "crash-looping", restarts: 2, detail: "spawn scheduled, last exit code 1" })
    expect(launchdHealth("\tstate = not running\n\truns = 1\n\tlast exit code = 78\n").state).toBe("stopped")
    expect(launchdHealth("\tstate = spawn scheduled\n\truns = 0\n").state).toBe("starting")
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
    ok({ program: "systemctl", words: ["--user", "show", "--property=ActiveState,SubState,NRestarts", "hub-node.service"] })
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
    refused({ program: "systemctl", words: ["--user", "show", "hub-node.service"] })
    refused({ program: "systemctl", words: ["--user", "show", "--property=Environment", "hub-node.service"] })
    refused({ program: "systemctl", words: ["--user", "show", "--property=ActiveState,SubState,NRestarts", "sshd.service"] })
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

  test("captures (bounded) output only for the two state queries; every other call reports just its exit", async () => {
    const seen: { words: readonly string[]; capture?: boolean }[] = []
    const run = spawnManagerRunner({
      programs: { systemctl: "/usr/bin/systemctl", launchctl: "/bin/launchctl" },
      spawn: async (_file, words, options) => (seen.push({ words, ...(options.capture ? { capture: true } : {}) }), options.capture ? { exitCode: 0, output: "ActiveState=active\n" } : 0),
    })
    expect(await run({ program: "systemctl", words: ["--user", "show", "--property=ActiveState,SubState,NRestarts", "hub-node.service"] })).toEqual({ exitCode: 0, output: "ActiveState=active\n" })
    expect(await run({ program: "launchctl", words: ["print", "gui/501/io.github.huynle.hub-node"] })).toEqual({ exitCode: 0, output: "ActiveState=active\n" })
    expect(await run({ program: "systemctl", words: ["--user", "restart", "hub-node.service"] })).toEqual({ exitCode: 0 })
    expect(seen.map((s) => s.capture ?? false)).toEqual([true, true, false])
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
    const control = controlOf(m.run, 501, unitPathResolver(w.box.roots, "host"))
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

  test("a crash-looping service fails the apply with service_failed and rolls back: unloaded, unit file removed", async () => {
    const m = new FakeManager()
    m.health.set("io.github.huynle.hub-node", ["running", "auto-restart"])
    const { r, w } = await apply(m, [INSTALL, ACTIONS["activate-service"]])
    expect(codeOf(r)).toBe("service_failed")
    expect(exitFor(codeOf(r)!)).toBe(15)
    expect(m.loaded.has("io.github.huynle.hub-node")).toBe(false)
    expect(existsSync(unitPathResolver(w.box.roots, "host")("node", "launchd")!)).toBe(false)
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
    const exec = activateServiceExecutor(controlOf(new FakeManager().run, 501))
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
