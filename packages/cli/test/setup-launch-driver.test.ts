// The LaunchDriver of `hubctl setup`'s bounded verification launch (HBS-13 integration item 4), over the existing hub
// launch API (the SDK's hub.launches, as `hub launch` uses it): one launch pinned to this machine, in the workspace,
// ending when idle, cleaned up by the hub (cleanup: remove); then the node's slot must be free again. Driven through
// node-services' verifyLaunch, which bounds every wait and recovers on failure.
import { describe, expect, test } from "bun:test"
import type { LaunchSpec, LaunchView } from "../../sdk/src/index.ts"
import { verifyLaunch } from "../src/bootstrap/adapters/node-services/launch.ts"
import { hubLaunchDriver } from "../src/setup/launch-driver.ts"

function fakeLaunches(script: (Partial<LaunchView> & { state: LaunchView["state"] })[]) {
  const created: LaunchSpec[] = []
  const stopped: string[] = []
  let step = 0
  const view = (): LaunchView => ({ id: "l_1", reason: "", spec: created[0]!, created: 1, updated: 1, history: [], ...script[Math.min(step, script.length - 1)]! }) as LaunchView
  return {
    created,
    stopped,
    launches: {
      create: async (spec: LaunchSpec) => (created.push(spec), { launch: view(), created: true }),
      get: async () => {
        step++
        return { launch: view() }
      },
      stop: async (id: string) => (stopped.push(id), { launch: view() }),
      list: async () => ({ launches: view().state === "ended" ? [] : [view()] }),
    },
  }
}

const request = { harness: "opencode" as const, workspace: "/Users/dev/projects/demo", maxDurationS: 600 }
const fast = { pollMs: 1, sleep: async () => {} }

describe("hubLaunchDriver", () => {
  test("one bounded launch on this machine, idle, nothing left, slot free: the verification passes", async () => {
    const f = fakeLaunches([{ state: "queued" }, { state: "running", sessionID: "ses_1" }, { state: "running", sessionID: "ses_1" }, { state: "ended", outcome: "idle", artifacts: { dirty: false, commits: 0 } }])
    const driver = hubLaunchDriver({ launches: f.launches, machineID: async () => "mch_1", ...fast })
    const report = await verifyLaunch(driver, request)
    expect(report.ok).toBe(true)
    const spec = f.created[0]!
    expect(spec).toMatchObject({ harness: "opencode", workspace: { repo: "/Users/dev/projects/demo", mode: "checkout" }, placement: { machine: "mch_1", mode: "require" }, end: { when: "idle", timeout: "10m", cleanup: "remove" } })
    expect(spec.key).toMatch(/^hubctl-verify-/)
    expect(JSON.stringify(spec)).not.toMatch(/token/i)
  })

  test("a launch that fails, or leaves uncommitted changes, fails the verification and is stopped", async () => {
    const failing = fakeLaunches([{ state: "ended", outcome: "failed" }])
    const r = await verifyLaunch(hubLaunchDriver({ launches: failing.launches, machineID: async () => "mch_1", ...fast }), request)
    expect(r.ok).toBe(false)
    const dirty = fakeLaunches([{ state: "queued" }, { state: "running", sessionID: "ses_1" }, { state: "ended", outcome: "idle", artifacts: { dirty: true } }])
    const d = await verifyLaunch(hubLaunchDriver({ launches: dirty.launches, machineID: async () => "mch_1", ...fast }), request)
    expect(d.ok).toBe(false)
    expect(d.stages.find((s) => s.stage === "artifacts")?.ok).toBe(false)
  })

  test("not enrolled: the launch is refused before anything is created", async () => {
    const f = fakeLaunches([{ state: "queued" }])
    const r = await verifyLaunch(hubLaunchDriver({ launches: f.launches, machineID: async () => undefined, ...fast }), request)
    expect(r.ok).toBe(false)
    expect(f.created).toEqual([])
  })

  test("Ctrl-C stops waiting and the launch is cancelled", async () => {
    const f = fakeLaunches([{ state: "running" }])
    const controller = new AbortController()
    const sleep = async (_ms: number, signal: AbortSignal) => {
      controller.abort()
      if (signal.aborted) throw new Error("aborted")
    }
    const r = await verifyLaunch(hubLaunchDriver({ launches: f.launches, machineID: async () => "mch_1", pollMs: 1, sleep }), request, { signal: controller.signal })
    expect(r.ok).toBe(false)
    expect(f.stopped).toEqual(["l_1"])
  })
})
