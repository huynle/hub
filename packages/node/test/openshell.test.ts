// The node's openshell wiring against the fake openshell CLI (no gateway, no VMs): the runtime built from node.json's
// openshell section, the backends its hello reports (the gateway's compute drivers, best effort) and the startup
// sweep that finds this machine's sandboxes from an earlier run and reports them as launches.
import { afterEach, describe, expect, test } from "bun:test"
import { OpenShellCli } from "../../runtime-openshell/src/cli.ts"
import { normalizeOpenShellProfiles } from "../../runtime-openshell/src/profiles.ts"
import { labelValue, sandboxName } from "../../runtime-openshell/src/runtime.ts"
import { createFakeOpenShell, type FakeOpenShell, type FakePhase } from "../../runtime-openshell/test/fake-openshell.ts"
import { createOpenShellRuntime, openshellBackends, sweepSandboxes } from "../src/openshell.ts"

const fakes: FakeOpenShell[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup()
})

function setup() {
  const fake = createFakeOpenShell()
  fakes.push(fake)
  const client = new OpenShellCli({ binary: fake.binary, env: { PATH: process.env.PATH ?? "" } })
  return { fake, client }
}

function addSandbox(fake: FakeOpenShell, name: string, labels: Record<string, string>, phase: FakePhase = "Ready", workspace = "hub") {
  fake.update((s) => {
    s.sandboxes[`${workspace}/${name}`] = {
      id: `id-${name}`,
      name,
      workspace,
      labels,
      phase,
      pendingGets: 0,
      createdAt: "2026-10-25T00:00:00Z",
      providers: [],
      env: {},
      command: [],
      exitCode: null,
    }
  })
}

describe("createOpenShellRuntime", () => {
  test("an openshell runtime with node.json's profiles and opencode as harness", () => {
    const { client } = setup()
    const runtime = createOpenShellRuntime({
      client,
      roots: ["/w"],
      hubURL: "http://127.0.0.1:4096",
      openshell: { enabled: true, profiles: normalizeOpenShellProfiles({ web: {} }) },
    })
    expect(runtime.kind).toBe("openshell")
    expect(runtime.info()).toEqual({ kind: "openshell", harnesses: ["opencode"], profiles: ["default", "web"] })
  })
})

describe("openshellBackends", () => {
  test("the gateway's compute drivers", async () => {
    const { client } = setup()
    expect(await openshellBackends(client)).toEqual(["vm"])
  })

  test("best effort: a failing gateway, odd names or a client without gatewayInfo give what is usable", async () => {
    const { fake, client } = setup()
    fake.fail({ command: "gateway info", stderr: "Error:   × status: Unavailable, message: gateway down\n" })
    expect(await openshellBackends(client)).toEqual([])
    fake.update((s) => (s.computeDrivers = ["vm", "Bad Name", "kata"]))
    expect(await openshellBackends(client)).toEqual(["vm", "kata"])
    const withoutInfo = { status: () => client.status() } as unknown as Parameters<typeof openshellBackends>[0]
    expect(await openshellBackends(withoutInfo)).toEqual([])
  })
})

describe("sweepSandboxes", () => {
  test("this machine's sandboxes in the hub workspace become launches: running when Ready (or coming up), else stopped", async () => {
    const { fake, client } = setup()
    addSandbox(fake, sandboxName("l1"), { "hub.launch": "l1", "hub.machine": "m1" }, "Ready")
    addSandbox(fake, sandboxName("l2"), { "hub.launch": "l2", "hub.machine": "m1" }, "Stopped")
    addSandbox(fake, sandboxName("l3"), { "hub.launch": "l3", "hub.machine": "m1" }, "Provisioning")
    addSandbox(fake, sandboxName("l4"), { "hub.launch": "l4", "hub.machine": "m1" }, "Error")
    const { launches, problems } = await sweepSandboxes(client, "m1")
    expect(problems).toEqual([])
    expect(launches).toEqual(
      expect.arrayContaining([
        { launchID: "l1", phase: "running", sandbox: sandboxName("l1") },
        { launchID: "l2", phase: "stopped", sandbox: sandboxName("l2") },
        { launchID: "l3", phase: "running", sandbox: sandboxName("l3") },
        { launchID: "l4", phase: "stopped", sandbox: sandboxName("l4") },
      ]),
    )
    expect(launches.length).toBe(4)
    const list = fake.calls().find((c) => c.command === "sandbox list")!
    expect(list.workspace).toBe("hub")
    expect(list.argv).toContain("hub.machine=m1")
  })

  test("leaves out other machines' sandboxes, other workspaces, deleting ones and names that are not the launch's", async () => {
    const { fake, client } = setup()
    addSandbox(fake, sandboxName("o1"), { "hub.launch": "o1", "hub.machine": "m2" })
    addSandbox(fake, "demo", { "hub.machine": "m1" })
    addSandbox(fake, "hub-spoofed", { "hub.launch": "l5", "hub.machine": "m1" })
    addSandbox(fake, sandboxName("l6"), { "hub.launch": "l6", "hub.machine": "m1" }, "Deleting")
    addSandbox(fake, sandboxName("l7"), { "hub.launch": "l7", "hub.machine": "m1" }, "Ready", "default")
    expect((await sweepSandboxes(client, "m1")).launches).toEqual([])
  })

  test("a machine ID that is not a label value is matched by its hash, as the runtime labels it", async () => {
    const { fake, client } = setup()
    const machineID = "machine with spaces"
    addSandbox(fake, sandboxName("l1"), { "hub.launch": "l1", "hub.machine": labelValue(machineID) })
    expect((await sweepSandboxes(client, machineID)).launches).toEqual([{ launchID: "l1", phase: "running", sandbox: sandboxName("l1") }])
  })

  test("a failing list is a problem, not a crash", async () => {
    const { fake, client } = setup()
    fake.fail({ command: "sandbox list", stderr: "Error:   × status: Unavailable, message: gateway down\n" })
    const { launches, problems } = await sweepSandboxes(client, "m1")
    expect(launches).toEqual([])
    expect(problems.join("\n")).toContain("gateway down")
  })
})
