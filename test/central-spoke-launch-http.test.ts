// The hub wires launch-bound connections (phase 5): Central.launchTokens mints and checks hlt1 tokens against the
// launch engine's store, /spoke/ws accepts them, a launch's end (Central.launchFeed) closes its connection, a
// sandboxed spoke gets session tokens but no act tokens, and an hlt1 token is no credential for /api (loopback is
// never trusted). Launches are written straight into the engine's store (no node is connected, so the engine never
// touches them).
import { afterEach, describe, expect, test } from "bun:test"
import { validateLaunchSpec } from "../src/central/agent/launch-spec"
import { connect, harness, hello, PUBLIC, session, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const USER = "local"

/** A launch provisioning on a new machine, with a launch token for it. */
async function provisioning(central: Harness) {
  const { machine, token: machineToken } = await central.store.addMachine("box-host")
  const { launch } = await central.launches.store.create(USER, validateLaunchSpec({ workspace: { repo: "/p/hub", branch: "feat/x" } }))
  await central.launches.store.transition(USER, launch.id, "placing", { reason: "Placing" })
  const placed = await central.launches.store.transition(USER, launch.id, "provisioning", { reason: "Placed", machineID: machine.id })
  const minted = await central.launchTokens.mint(machine.id, launch.id)
  return { machineID: machine.id, machineToken, launch: placed, token: minted!.token }
}

async function boxed(central: Harness, token: string, launchID: string, features: string[] = ["launch"]) {
  const client = await connect(central, token)
  client.send(hello("box1", { kind: "service", features, launchID }))
  const first = await client.next((f) => f.t === "welcome" || f.t === "bye")
  return Object.assign(client, { first })
}

describe("launch tokens in the hub", () => {
  test("Central.launchTokens mints for a provisioning launch; the token connects a bound spoke", async () => {
    h = await harness()
    const { token, launch, machineID } = await provisioning(h)
    expect(token).toStartWith("hlt1.")
    expect(await h.launchTokens.verify(token)).toMatchObject({ userID: USER, machineID, launchID: launch.id })
    const client = await boxed(h, token, launch.id)
    expect(client.first).toMatchObject({ t: "welcome", machineID, publicURL: PUBLIC })
    await waitFor(() => h.registry.launchConn(launch.id) !== undefined)
    expect(h.registry.serviceFor(machineID)).toBeUndefined()
  })

  test("the launch's end on launchFeed closes its connection", async () => {
    h = await harness()
    const { token, launch } = await provisioning(h)
    const client = await boxed(h, token, launch.id)
    expect(client.first.t).toBe("welcome")
    const ended = await h.launches.store.transition(USER, launch.id, "ended", { reason: "Stopped", outcome: "stopped" })
    h.launchFeed.publish(USER, ended)
    expect((await client.next((f) => f.t === "bye")).reason).toContain("ended")
    await client.closed
    await waitFor(() => h.registry.connections() === 0)
  })

  test("a running launch's change keeps its connection", async () => {
    h = await harness()
    const { token, launch } = await provisioning(h)
    const client = await boxed(h, token, launch.id)
    const running = await h.launches.store.transition(USER, launch.id, "running", { reason: "Started", sessionID: "ses_1", name: "w" })
    h.launchFeed.publish(USER, running)
    await Bun.sleep(50)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(h.registry.launchConn(launch.id)).toBeDefined()
  })

  test("a sandboxed spoke gets session tokens but never act tokens", async () => {
    h = await harness()
    const { token, launch } = await provisioning(h)
    const client = await boxed(h, token, launch.id, ["launch", "sessionTokens", "actTokens"])
    client.send({ t: "sessions", sessions: [session("ses_box")] })
    const req = await client.next((f) => f.t === "req")
    expect(req.req.op).toBe("sessionTokens")
    client.send({ t: "res", id: req.id, ok: true, result: { applied: ["ses_box"], skipped: [] } })
    await Bun.sleep(100)
    expect(client.frames.filter((f) => f.t === "req" && f.req.op === "actTokens")).toEqual([])
  })

  test("an hlt1 token is no credential for the API, from loopback too", async () => {
    h = await harness({ noDevice: true })
    const { token } = await provisioning(h)
    const res = await h.api("/api/machines", { headers: { authorization: `Bearer ${token}` }, cookie: "" })
    expect(res.status).toBe(401)
  })
})
