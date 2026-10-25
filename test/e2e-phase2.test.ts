// Phase 2 (agent messaging) end to end: one in-process hub, a real OpenCode spoke with "deliver" carrying two
// sessions, a raw spoke without it, and the `hub` CLI acting as each session (its pushed session token), as an
// app token, as the user's device and as a second user. Every message a session gets is what OpenCode would be
// handed: the spoke's host.synthetic call (envelope text + metadata.source "hub").
//
// - Spoke 1: the real Spoke class (fake host with synthetic) on "laptop-a", sessions ALPHA ("Alpha work", derived
//   @alpha-work) and BRAVO (named @bravo by itself through the CLI, which primes it once).
// - Spoke 2: a raw protocol client on "laptop-b" (harness fake, no features) with GAMMA: messages to it are
//   unsupported {feature: "deliver"} (exit 7) and nothing is stored.
// - Replies from BRAVO go through the OpenCode `hub` tool's code path (runHubTool, as the plugin's tool execute
//   calls it) with the real spoke as BRAVO.
// - `hub mcp` runs as a real process over stdin/stdout pipes with the app token's login file.
// - An ask to @me opens a Decision; the user answers it on the console route (cookie), and the asker's waiting
//   `hub ask --wait` gets the reply.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { PAIR_LIMIT } from "../src/central/agent/message-limits"
import { defaults, writeConfig } from "../src/config"
import { runHubTool } from "../src/spoke/hub-tool"
import { Spoke, type SpokeHost } from "../src/spoke/spoke"
import { harness, session, spoke as rawSpoke, waitFor, type FakeSpoke, type Harness } from "./central-harness"
import { EventQueue } from "./spoke-fake"

const ROOT = path.resolve(import.meta.dir, "..")
const ALPHA = "ses_alpha02"
const BRAVO = "ses_bravo02"
const GAMMA = "ses_gamma02"
const TITLES: Record<string, string> = { [ALPHA]: "Alpha work", [BRAVO]: "Bravo task" }

type Ev = { type: string; data: Record<string, unknown> }
/** One host.synthetic call: what the OpenCode session is handed. */
interface Admitted {
  sessionID: string
  id: string
  text: string
  metadata: Record<string, unknown>
  delivery: string
  resume: boolean
}

let h: Harness
let tmp: string
let spokeA: Spoke
let rawB: FakeSpoke & { token: string }
const admitted: Admitted[] = []
const ids: Record<string, { token: string; url: string }> = {}

function host(events: EventQueue<Ev>): SpokeHost {
  return {
    directory: "/work/alpha",
    opencodeVersion: "2.0.26",
    events: (signal) => events.iterate(signal),
    prompt: async () => ({ id: "msg_1" }),
    synthetic: async (input) => {
      admitted.push({ ...input })
      return { id: input.id }
    },
    context: async () => [],
    getSession: async (id) => ({ id, title: TITLES[id] ?? id, location: { directory: "/work/alpha" }, time: { updated: 1 } }),
    replyPermission: async () => "replied",
    interrupt: async () => undefined,
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    hasAgent: async () => true,
    defaultAgent: async () => "build",
  }
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

async function cli(argv: string[], env: Record<string, string>, home: string): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const code = await run(argv, { env, home, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}
const json = (r: Result) => JSON.parse(r.stdout)
const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))
/** What a session was handed, in order. */
const to = (sessionID: string) => admitted.filter((a) => a.sessionID === sessionID)
const messagesTo = (sessionID: string) => to(sessionID).filter((a) => a.metadata.kind !== "primer")
/** Waits for the next message handed to the session after `seen` of them. */
async function nextTo(sessionID: string, seen: number, timeoutMs = 5000): Promise<Admitted> {
  await waitFor(() => messagesTo(sessionID).length > seen, timeoutMs)
  return messagesTo(sessionID)[seen]!
}

/** The CLI as a session: its shells' HUB_URL + HUB_SESSION_TOKEN. */
const asSession = (sessionID: string) => ({ env: { HUB_URL: ids[sessionID]!.url, HUB_SESSION_TOKEN: ids[sessionID]!.token }, home: dir(`home-${sessionID}`) })

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "hub-e2e-p2-"))
  h = harness()
  const a = h.store.addMachine("laptop-a")
  const b = h.store.addMachine("laptop-b")

  const configFile = path.join(tmp, "spoke-a.json")
  writeConfig(configFile, { ...defaults("laptop-a"), server: h.url, mode: "always", token: a.token, autoStartLocalHub: false, herdr: false })
  const events = new EventQueue<Ev>()
  spokeA = new Spoke(host(events), {
    configFile,
    machineName: "laptop-a",
    kind: "standalone",
    processID: "proc_a2",
    pid: 4101,
    pluginVersion: "9.9.9",
    snapshotDebounceMs: 10,
    snapshotIntervalMs: 60_000,
    seedDebounceMs: 10,
    pollMs: 20,
    backoff: { minMs: 10, maxMs: 50 },
  })
  spokeA.start()
  await waitFor(() => spokeA.status().connection === "connected", 5000)
  for (const id of [ALPHA, BRAVO]) events.push({ type: "session.created", data: { sessionID: id, title: TITLES[id]!, location: { directory: "/work/alpha" }, slug: id } })

  rawB = await rawSpoke(h, { machine: b, processID: "proc_b2", hello: { harness: "fake", harnessVersion: "0.1.0", evidence: "hooks", features: [], directory: "/work/gamma" } })
  rawB.ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.t === "req") rawB.send({ t: "res", id: frame.id, ok: true, result: {} })
  })
  rawB.send({ t: "sessions", sessions: [session(GAMMA, { title: "Gamma hooks", directory: "/work/gamma" })] })
  await waitFor(() => h.registry.hasSession(ALPHA) && h.registry.hasSession(BRAVO) && h.registry.hasSession(GAMMA), 5000)
  await waitFor(() => spokeA.shellIdentity(ALPHA) !== undefined && spokeA.shellIdentity(BRAVO) !== undefined, 5000)
  for (const id of [ALPHA, BRAVO]) {
    const identity = spokeA.shellIdentity(id)!
    ids[id] = { token: identity.token, url: identity.url! }
  }
})

afterAll(async () => {
  spokeA?.stop()
  rawB?.close()
  await h?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe("deliver: the real spoke supports it, the raw spoke does not", () => {
  test("the spoke with host.synthetic announces deliver; the hub knows the raw one does not", () => {
    expect(spokeA.hubSupports("messaging")).toBe(true)
    const conns = (id: string) => h.registry.sessionTargets(id)
    expect(conns(ALPHA).some((c) => h.registry.supports(c, "deliver"))).toBe(true)
    expect(conns(GAMMA).some((c) => h.registry.supports(c, "deliver"))).toBe(false)
  })

  test("a msg to the session on the raw spoke is unsupported (exit 7) and nothing is stored", async () => {
    const { env, home } = asSession(ALPHA)
    const r = await cli(["msg", GAMMA, "hello gamma", "--json"], env, home)
    expect(r.code).toBe(7)
    expect(json(r).error).toMatchObject({ code: "unsupported", feature: "deliver" })
    const inbox = json(await cli(["inbox", "--json"], env, home))
    expect(inbox.messages.filter((m: { to: string }) => m.to === GAMMA)).toEqual([])
  })
})

describe("sessions message each other through the CLI and the hub tool", () => {
  test("naming @bravo primes it once (wake:false), before any message", async () => {
    const { env, home } = asSession(BRAVO)
    expect((await cli(["name", "@bravo"], env, home)).code).toBe(0)
    await waitFor(() => to(BRAVO).some((a) => a.metadata.kind === "primer"), 5000)
    const primer = to(BRAVO).find((a) => a.metadata.kind === "primer")!
    expect(primer).toMatchObject({ resume: false, metadata: { source: "hub", kind: "primer" } })
    expect(primer.text).toContain("[hub] You are @bravo.")
    expect(primer.text).toContain("not from the user's prompt")
  })

  test("the name me is reserved (invalid, exit 2)", async () => {
    const { env, home } = asSession(BRAVO)
    const r = await cli(["name", "@me", "--json"], env, home)
    expect(r.code).toBe(2)
    expect(json(r).error.message).toContain("reserved")
  })

  // The sender label is the hub's directory facts: name and machine (the hub does not add the harness today).
  test("A's msg reaches B as an envelope from @alpha-work, started as a turn", async () => {
    const seen = messagesTo(BRAVO).length
    const { env, home } = asSession(ALPHA)
    const r = await cli(["msg", "@bravo", "please look at the login bug", "--json"], env, home)
    expect(r.code).toBe(0)
    const sent = json(r)
    expect(sent.message).toMatchObject({ kind: "msg", from: { kind: "session", sessionID: ALPHA }, recipient: { kind: "session", sessionID: BRAVO } })
    expect(sent.delivery).toBe("turn")
    const got = await nextTo(BRAVO, seen)
    expect(got).toMatchObject({ id: sent.message.id, resume: true, metadata: { source: "hub", kind: "msg", messageID: sent.message.id } })
    const lines = got.text.split("\n")
    expect(lines[0]).toMatch(new RegExp(`^\\[hub\\] msg from @alpha-work \\(laptop-a\\) to you · .* · ${sent.message.id}$`))
    expect(lines).toContain("please look at the login bug")
    expect(lines.at(-1)).toBe(`↩ hub reply ${sent.message.id} "…"`)
  })

  test("A's ask --wait is answered by B's reply through the hub tool; A is handed the reply too", async () => {
    const seenB = messagesTo(BRAVO).length
    const seenA = messagesTo(ALPHA).length
    const { env, home } = asSession(ALPHA)
    const asking = cli(["ask", "@bravo", "is the fix safe to ship?", "--wait", "30"], env, home)
    const ask = await nextTo(BRAVO, seenB)
    expect(ask.metadata).toMatchObject({ source: "hub", kind: "ask" })
    const askID = String(ask.metadata.messageID)
    expect(ask.text).toContain(`hub decline ${askID} --why`)

    // The plugin's `hub` tool, as session BRAVO (the token never shows in its output).
    const replied = await runHubTool(() => spokeA, { verb: "reply", id: askID, text: "yes, tests pass" }, { sessionID: BRAVO })
    expect(replied.content).toMatch(/^Replied msg_\w+ to @alpha-work/)
    expect(JSON.stringify(replied)).not.toContain(ids[BRAVO]!.token)

    const r = await asking
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`ask ${askID} to @bravo`)
    expect(r.stdout).toContain("from @bravo")
    expect(r.stdout).toContain("yes, tests pass")
    const reply = await nextTo(ALPHA, seenA)
    expect(reply.metadata).toMatchObject({ source: "hub", kind: "reply", replyTo: askID })
    expect(reply.text.split("\n")[0]).toContain(`reply from @bravo (laptop-a) to you · re ${askID}`)
    expect(reply.text).toContain("yes, tests pass")
  })

  test("B was primed exactly once", () => {
    expect(to(BRAVO).filter((a) => a.metadata.kind === "primer")).toHaveLength(1)
    expect(to(ALPHA).filter((a) => a.metadata.kind === "primer")).toHaveLength(1)
  })

  test("B's inbox (hub tool) shows A's messages as envelopes, marked not from the user", async () => {
    const inbox = await runHubTool(() => spokeA, { verb: "inbox" }, { sessionID: BRAVO })
    expect(inbox.content).toContain("not from the user")
    expect(inbox.content).toContain("[hub] msg from @alpha-work")
  })

  test("a session's mute refuses the muted sender (exit 5); unmute accepts it again", async () => {
    const b = asSession(BRAVO)
    const a = asSession(ALPHA)
    expect(json(await cli(["mute", "@alpha-work", "--json"], b.env, b.home)).muted).toEqual([ALPHA])
    const seen = messagesTo(BRAVO).length
    const refused = await cli(["msg", "@bravo", "still there?", "--json"], a.env, a.home)
    expect(refused.code).toBe(5)
    expect(json(refused).error.code).toBe("forbidden")
    expect(json(await cli(["unmute", "@alpha-work", "--json"], b.env, b.home)).muted).toEqual([])
    expect((await cli(["msg", "@bravo", "still there?"], a.env, a.home)).code).toBe(0)
    await nextTo(BRAVO, seen)
    // Only the message sent after unmute was handed over.
    expect(messagesTo(BRAVO).slice(seen)).toHaveLength(1)
  })
})

describe("app tokens with messages:send / messages:read, and hub mcp", () => {
  let app: { env: Record<string, string>; home: string }
  let appSent = 0

  beforeAll(async () => {
    const created = await h.api("/api/agent/app-tokens", { method: "POST", json: { label: "e2e bot", scopes: ["sessions:read", "messages:send", "messages:read"] } })
    expect(created.status).toBe(201)
    const { token } = (await created.json()) as { token: string }
    const home = dir("app-home")
    app = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
    expect((await cli(["login", "--url", h.url, "--token", token], app.env, app.home)).code).toBe(0)
  })

  test("an app token without messages:send cannot send (exit 5)", async () => {
    const created = await h.api("/api/agent/app-tokens", { method: "POST", json: { label: "reader" } })
    const { token } = (await created.json()) as { token: string }
    const home = dir("reader-home")
    const env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
    expect((await cli(["login", "--url", h.url, "--token", token], env, home)).code).toBe(0)
    const r = await cli(["msg", "@bravo", "hi", "--json"], env, home)
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("forbidden")
  })

  test("the app's msg reaches B from `app e2e bot`; its inbox reads", async () => {
    const seen = messagesTo(BRAVO).length
    const r = await cli(["msg", "@bravo", "nightly build is red", "--json"], app.env, app.home)
    expect(r.code).toBe(0)
    appSent++
    expect(json(r).message.from).toMatchObject({ kind: "app", label: "e2e bot" })
    const got = await nextTo(BRAVO, seen)
    expect(got.text.split("\n")[0]).toContain("[hub] msg from app e2e bot to you")
    expect((await cli(["inbox", "--json"], app.env, app.home)).code).toBe(0)
  })

  test("hub mcp over pipes: initialize, tools/list, tools/call msg reaches B", async () => {
    const proc = Bun.spawn([process.execPath, path.join(ROOT, "packages/cli/src/main.ts"), "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: app.home, ...app.env },
    })
    const raw: string[] = []
    const reading = (async () => {
      const decoder = new TextDecoder()
      const reader = proc.stdout.getReader()
      for (let next = await reader.read(); !next.done; next = await reader.read()) raw.push(decoder.decode(next.value, { stream: true }))
    })()
    const frames = () => raw.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: number; result?: any; error?: unknown })
    const send = (frame: unknown) => {
      proc.stdin.write(`${JSON.stringify(frame)}\n`)
      proc.stdin.flush()
    }
    const answer = async (id: number) => {
      for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(10)) {
        const found = frames().find((f) => f.id === id)
        if (found) return found
      }
      throw new Error(`no answer to ${id}: ${raw.join("")}`)
    }
    const seen = messagesTo(BRAVO).length
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })
    expect((await answer(1)).result.serverInfo.name).toBe("hub")
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = (await answer(2)).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(["msg", "ask", "reply", "decline", "inbox", "who"]))
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "msg", arguments: { to: "@bravo", text: "via mcp" } } })
    const called = await answer(3)
    expect(called.result.isError ?? false).toBe(false)
    expect(called.result.content[0].text).toMatch(/^msg msg_\w+ to @bravo/)
    appSent++
    const got = await nextTo(BRAVO, seen)
    expect(got.text).toContain("[hub] msg from app e2e bot to you")
    expect(got.text).toContain("via mcp")
    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    await reading
    // stdout carries protocol frames only.
    expect(raw.join("").split("\n").filter(Boolean).every((l) => l.startsWith("{"))).toBe(true)
  })

  test(`the pair limit (${PAIR_LIMIT} per window) refuses the next message: rate_limited, exit 6`, async () => {
    let refused: Result | undefined
    for (let i = appSent; i <= PAIR_LIMIT; i++) {
      const r = await cli(["msg", "@bravo", `ping ${i}`, "--no-wake", "--json"], app.env, app.home)
      if (r.code !== 0) {
        refused = r
        break
      }
      appSent++
    }
    expect(appSent).toBe(PAIR_LIMIT)
    expect(refused?.code).toBe(6)
    expect(json(refused!).error.code).toBe("rate_limited")
    // Another pair is unaffected.
    const a = asSession(ALPHA)
    expect((await cli(["msg", "@bravo", "other pair", "--no-wake"], a.env, a.home)).code).toBe(0)
  })
})

describe("asks to @me are Decisions the user answers in the console", () => {
  test("A asks @me with options and waits; the console answers (cookie); A gets the reply", async () => {
    const seenA = messagesTo(ALPHA).length
    const { env, home } = asSession(ALPHA)
    const asking = cli(["ask", "@me", "Ship the login fix?", "--option", "ship=Ship it", "--option", "hold=Hold:safe", "--recommend", "ship", "--wait", "30", "--json"], env, home)
    let decision: { id: string; question: string; from: unknown; state: string } | undefined
    await waitFor(() => {
      void h
        .api("/api/decisions?state=open")
        .then((r) => r.json())
        .then((b: any) => (decision = b.decisions?.[0]))
      return decision !== undefined
    }, 5000)
    expect(decision).toMatchObject({ question: "Ship the login fix?", from: { kind: "session", sessionID: ALPHA }, state: "open" })
    // Sessions cannot answer Decisions: there is no agent route for it, and the console route wants the user.
    const bySession = await fetch(`${h.url}/api/decisions/${decision!.id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${ids[BRAVO]!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ option: "ship" }),
    })
    expect(bySession.ok).toBe(false)
    const answered = await h.api(`/api/decisions/${decision!.id}/answer`, { method: "POST", json: { option: "ship" } })
    expect(answered.status).toBe(200)
    expect(((await answered.json()) as any).decision).toMatchObject({ state: "answered", answer: { option: "ship", answeredBy: "user" } })
    const r = await asking
    expect(r.code).toBe(0)
    const body = json(r)
    expect(body.message).toMatchObject({ to: "@me", state: "answered" })
    expect(body.answer).toMatchObject({ kind: "reply", from: { kind: "user" } })
    const reply = await nextTo(ALPHA, seenA)
    expect(reply.text.split("\n")[0]).toContain("[hub] reply from the user to you")
  })
})

describe("a second user cannot see or answer the first user's messages and Decisions", () => {
  let bob: { env: Record<string, string>; home: string; cookie: string }
  let askID = ""
  let decisionID = ""

  beforeAll(async () => {
    // Something open of alice's: an ask from A to B, and a Decision.
    const a = asSession(ALPHA)
    askID = json(await cli(["ask", "@bravo", "open question", "--no-wake", "--json"], a.env, a.home)).message.id
    decisionID = json(await cli(["ask", "@me", "Another decision?", "--json"], a.env, a.home)).decision.id
    const user = h.store.upsertUser({ email: "bob@example.com", role: "user" })
    const cookie = `voice_device=${h.store.addDevice("bob laptop", user.id).token}`
    const { code } = (await (await h.api("/api/devices/link", { method: "POST", json: {}, cookie })).json()) as { code: string }
    const { token } = (await (await h.api("/api/devices/redeem", { method: "POST", json: { code }, cookie: null, origin: null })).json()) as { token: string }
    const home = dir("bob-home")
    bob = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home, cookie }
    expect((await cli(["login", "--url", h.url, "--token", token], bob.env, bob.home)).code).toBe(0)
  })

  test("bob's reply, decline and messaging of alice's sessions are not found (exit 3)", async () => {
    for (const argv of [["reply", askID, "mine now"], ["decline", askID, "--why", "no"], ["msg", "@bravo", "hi"], ["msg", ALPHA, "hi"], ["ask", "@@reviewer", "hi"]]) {
      const r = await cli([...argv, "--json"], bob.env, bob.home)
      expect({ argv, code: r.code }).toEqual({ argv, code: 3 })
      expect(json(r).error.code).toBe("not_found")
    }
    const inbox = json(await cli(["inbox", "--json"], bob.env, bob.home))
    expect(inbox).toMatchObject({ asks: [], waiting: [], messages: [] })
  })

  test("bob sees no Decisions and cannot answer alice's (404 not_found)", async () => {
    const list = (await (await h.api("/api/decisions", { cookie: bob.cookie })).json()) as { decisions: unknown[] }
    expect(list.decisions).toEqual([])
    expect((await h.api(`/api/decisions/${decisionID}`, { cookie: bob.cookie })).status).toBe(404)
    const answer = await h.api(`/api/decisions/${decisionID}/answer`, { method: "POST", json: { text: "sure" }, cookie: bob.cookie })
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { code: string }).code).toBe("not_found")
    const still = (await (await h.api(`/api/decisions/${decisionID}`)).json()) as { decision: { state: string } }
    expect(still.decision.state).toBe("open")
  })
})

describe("the user's messaging switch", () => {
  test("paused: msg is refused (paused, exit 5) while reading works; resumed: msg works", async () => {
    const off = await h.api("/api/agent/messaging", { method: "PUT", json: { enabled: false } })
    expect(off.status).toBe(200)
    const a = asSession(ALPHA)
    const r = await cli(["msg", "@bravo", "while paused", "--json"], a.env, a.home)
    expect(r.code).toBe(5)
    expect(json(r).error.code).toBe("paused")
    expect((await cli(["inbox"], a.env, a.home)).code).toBe(0)
    expect((await h.api("/api/agent/messaging", { method: "PUT", json: { enabled: true } })).status).toBe(200)
    expect((await cli(["msg", "@bravo", "resumed", "--no-wake"], a.env, a.home)).code).toBe(0)
  })
})
