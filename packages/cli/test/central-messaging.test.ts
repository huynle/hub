// The CLI's messaging verbs against the real hub (test/central-harness.ts): sessions on a spoke that announces
// "deliver" message, ask (with --wait), reply, decline, read the inbox and mute each other with their session
// tokens (fake verifiers); a spoke without "deliver" is unsupported (exit 7); messaging off is paused (exit 5).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BearerVerifier } from "../../../src/central/agent/actor"
import { harness, session, spoke, waitFor, type Harness } from "../../../test/central-harness"
import { run } from "../src/cli"

const USER = "local"
const TOKENS: Record<string, string> = { ses_1: "hst_fake_ses_1", ses_2: "hst_fake_ses_2", ses_3: "hst_fake_ses_3", ses_old: "hst_fake_ses_old" }
const verifiers: BearerVerifier[] = [
  {
    kind: "session",
    verify: (token) => {
      const sessionID = Object.keys(TOKENS).find((id) => TOKENS[id] === token)
      return sessionID ? { kind: "session", userID: USER, machineID: "mch_x", sessionID } : undefined
    },
  },
]

let h: Harness
afterEach(async () => {
  await h?.stop()
})

/** Runs the CLI as a session (HUB_URL + its HUB_SESSION_TOKEN). */
async function as(sessionID: string, argv: string[], stdin?: string) {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, {
    env: { HUB_URL: h.url, HUB_SESSION_TOKEN: TOKENS[sessionID]! },
    home: mkdtempSync(path.join(tmpdir(), "hub-cli-central-msg-")),
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
  })
  return { code, stdout, stderr }
}

/** ses_1 @api-refactor, ses_2 @web-work, ses_3 @docs on a spoke with deliver; with old: ses_old @old-box without it. */
async function start(options: { old?: boolean } = {}) {
  h = harness({ agent: { verifiers } } as any)
  const sessions = [session("ses_1", { title: "API refactor", owned: true }), session("ses_2", { title: "Web work", owned: true }), session("ses_3", { title: "Docs", owned: true })]
  const client = await spoke(h, { hello: { harness: "opencode", harnessVersion: "2.1.4", evidence: "native", features: ["deliver"] }, sessions })
  const delivered: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req" || frame.req.op !== "deliver") return
    delivered.push(frame.req)
    client.send({ t: "res", id: frame.id, ok: true, result: { delivered: frame.req.wake ? "turn" : "queued" } })
  })
  let names = 3
  if (options.old) {
    await spoke(h, { processID: "p2", hello: { harness: "opencode", harnessVersion: "2.0.0", evidence: "native", features: [] }, sessions: [session("ses_old", { title: "Old box", owned: true })] })
    names = 4
  }
  await waitFor(() => (h.store.agentData(USER).names?.length ?? 0) === names)
  return { delivered }
}

describe("hub messaging verbs against the hub", () => {
  test("msg is delivered into the recipient session; --no-wake queues it; --json is the hub's answer", async () => {
    const { delivered } = await start()
    const sent = await as("ses_1", ["msg", "@web-work", "hello there"])
    expect(sent).toMatchObject({ code: 0, stderr: "" })
    expect(sent.stdout).toMatch(/^msg msg_\S+ to @web-work: delivered \(started a turn\)/)
    expect(delivered[0]).toMatchObject({ sessionID: "ses_2" })
    expect(delivered[0].text).toContain("hello there")
    const queued = await as("ses_1", ["msg", "@web-work", "-", "--no-wake", "--json"], "later\n")
    expect(queued.code).toBe(0)
    expect(JSON.parse(queued.stdout)).toMatchObject({ message: { text: "later", recipient: { sessionID: "ses_2" } }, delivery: "queued" })
  })

  test("ask --wait gets the answer the recipient sends with hub reply (found in its hub inbox)", async () => {
    await start()
    const asking = as("ses_1", ["ask", "@web-work", "ready to merge?", "--wait", "10"])
    let id = ""
    for (const deadline = Date.now() + 5000; !id && Date.now() < deadline; await Bun.sleep(20)) {
      const r = await as("ses_2", ["inbox", "--json"])
      id = r.code === 0 ? (JSON.parse(r.stdout).asks[0]?.id ?? "") : ""
    }
    expect(id).toMatch(/^msg_/)
    const inbox = await as("ses_2", ["inbox"])
    expect(inbox.stdout).toContain(`hub reply ${id}`)
    expect(inbox.stdout).toContain("@api-refactor")
    const replied = await as("ses_2", ["reply", id, "yes, merge it"])
    expect(replied.code).toBe(0)
    expect(replied.stdout).toContain(`answers ${id}`)
    const asked = await asking
    expect(asked.code).toBe(0)
    expect(asked.stdout).toContain("yes, merge it")
    // answered: a second reply is gone (exit 8); a stranger's reply not_found (exit 3)
    expect((await as("ses_2", ["reply", id, "again"])).code).toBe(8)
    expect((await as("ses_3", ["reply", id, "me too"])).code).toBe(3)
  })

  test("a declined ask exits 1 with the reason; an ask without --wait is open (exit 0)", async () => {
    await start()
    const open = await as("ses_1", ["ask", "@docs", "write the changelog?", "--expires", "2h", "--json"])
    expect(open.code).toBe(0)
    const ask = JSON.parse(open.stdout).message
    expect(ask).toMatchObject({ kind: "ask", state: "open" })
    expect(ask.expiresAt - ask.at).toBe(2 * 3600_000)
    expect((await as("ses_3", ["decline", ask.id, "--why", "busy with the release"])).code).toBe(0)
    const waited = await as("ses_1", ["ask", "@docs", "then tomorrow?", "--wait", "1"])
    expect(waited.code).toBe(1)
    expect(waited.stderr).toContain("no answer within 1 s")
    const inbox = await as("ses_1", ["inbox", "--json"])
    expect(JSON.parse(inbox.stdout).messages.some((m: any) => m.kind === "decline" && m.text === "busy with the release")).toBe(true)
  })

  test("mute refuses messages from a session (exit 5); unmute lets them through again", async () => {
    await start()
    const muted = await as("ses_2", ["mute", "@api-refactor"])
    expect(muted.code).toBe(0)
    expect(muted.stdout).toContain("ses_1")
    expect((await as("ses_1", ["msg", "@web-work", "hello"])).code).toBe(5)
    expect((await as("ses_2", ["unmute", "@api-refactor"])).stdout).toContain("nobody")
    expect((await as("ses_1", ["msg", "@web-work", "hello"])).code).toBe(0)
  })

  test("a recipient whose spoke cannot deliver is unsupported (exit 7, feature deliver); messaging off is paused (exit 5)", async () => {
    await start({ old: true })
    const old = await as("ses_1", ["msg", "@old-box", "hello"])
    expect(old.code).toBe(7)
    expect(old.stderr).toContain("deliver")
    expect((await h.api("/api/agent/messaging", { method: "PUT", json: { enabled: false } })).status).toBe(200)
    const paused = await as("ses_1", ["msg", "@web-work", "hello"])
    expect(paused.code).toBe(5)
    expect(paused.stderr).toContain("off")
    expect((await as("ses_1", ["inbox"])).code).toBe(0)
  })

  test("unknown addresses are not_found (exit 3); self-messages invalid (exit 2)", async () => {
    await start()
    expect((await as("ses_1", ["msg", "@nobody", "hi"])).code).toBe(3)
    expect((await as("ses_1", ["msg", "@api-refactor", "hi"])).code).toBe(2)
  })
})
