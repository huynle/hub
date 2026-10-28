// `machine enroll` and `machine status` against a real hub server (src/central) on 127.0.0.1, port 0: the
// device-code endpoints, the one-time redemption, and the credential check (GET /spoke/ws without an upgrade:
// 426 accepted, 401 revoked) that status relies on. The machine identity is then used by a real spoke WebSocket.
import { afterEach, describe, expect, test } from "bun:test"
import { harness, hello, connect, type Harness } from "../../../test/central-harness.ts"
import { findSecrets } from "../src/bootstrap/contracts/index.ts"
import { ConfigCredentialStore, machineEnroll, machineStatus, renderMachineResult, type EnrollPrompt } from "../src/bootstrap/enrollment/index.ts"
import { tempConfig } from "./bootstrap-enrollment-fake.ts"

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

describe("machine enroll against the real hub", () => {
  test("approve on the hub → stored → verified → used by a spoke → revoked", async () => {
    h = await harness()
    const central = h
    const store = new ConfigCredentialStore(tempConfig())
    const prompts: EnrollPrompt[] = []
    const result = await machineEnroll({
      server: central.url,
      machineName: "ci-box",
      store,
      minIntervalMs: 0,
      onPrompt: (prompt) => {
        prompts.push(prompt)
        void central.api(`/api/enrollments/${prompt.userCode}/approve`, { method: "POST" })
      },
    })
    expect(result.envelope).toMatchObject({ ok: true, data: { state: "verified", server: central.url, machineName: "ci-box" } })
    // The hub's link is on its public URL (another origin than the one enrolled with), so it is rebuilt.
    expect(prompts[0]?.approveURL).toBe(`${central.url}/approve?code=${prompts[0]?.userCode}`)
    const credential = (await store.read())!
    expect(credential.machineID).toMatch(/^mch_/)
    const shown = JSON.stringify(result.envelope) + renderMachineResult(result.envelope) + JSON.stringify(prompts)
    expect(shown).not.toContain(credential.token)
    expect(findSecrets(result.envelope)).toEqual([])

    const client = await connect(central, credential.token)
    client.send(hello("p1"))
    expect((await client.next()).machineID).toBe(credential.machineID)
    client.close()

    expect((await machineStatus({ store })).envelope.data).toMatchObject({ state: "verified", machineID: credential.machineID })
    await central.store.revokeMachine(credential.machineID)
    const revoked = await machineStatus({ store })
    expect(revoked.envelope).toMatchObject({ ok: false, error: { code: "revoked" }, data: { state: "revoked" } })
    expect(JSON.stringify(revoked.envelope)).not.toContain(credential.token)
  })

  test("deny on the hub → forbidden, nothing stored", async () => {
    h = await harness()
    const central = h
    const store = new ConfigCredentialStore(tempConfig())
    const result = await machineEnroll({
      server: central.url,
      machineName: "ci-box",
      store,
      minIntervalMs: 0,
      onPrompt: (prompt) => void central.api(`/api/enrollments/${prompt.userCode}/deny`, { method: "POST" }),
    })
    expect(result.envelope.error?.code).toBe("forbidden")
    expect(await store.read()).toBeUndefined()
  })
})
