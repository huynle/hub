// ClaudeSessions: what the daemon does with each Claude Code hook (fixture stdin from the P7-T0 spike) and each hub
// op. Hooks become the harness event subset (protocol harness-events.ts), permission requests wait for the hub (and
// lose the race to the local dialog honestly), hub messages reach the model at the next hook that can carry them or
// wake an idle session through the asyncRewake Stop hook, and a hub stop applies at the next hook.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { harnessEventProblem, type DeliverMeta, type HarnessEvent, type SessionInfo } from "../../protocol/src/index.ts"
import { parseHookInput, type HookInput } from "../src/hook-input.ts"
import { childSessionID, claudeSessionID } from "../src/ids.ts"
import { ClaudeSessions, type HookContext, type SessionsOptions, type SpokePort } from "../src/sessions.ts"

const SID = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"
const HUB = claudeSessionID(SID)
const fixture = (name: string, extra: Record<string, unknown> = {}): HookInput => {
  const input = parseHookInput({ ...JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")), ...extra })
  if (!input) throw new Error(`bad fixture ${name}`)
  return input
}
const meta: DeliverMeta = { kind: "msg", from: "@api", to: "@me" }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSpoke implements SpokePort {
  events: HarnessEvent[] = []
  sessions = new Map<string, SessionInfo>()
  ended: string[] = []
  tokens = new Map<string, { token: string; url?: string }>()
  upsertSession(info: SessionInfo): void {
    this.sessions.set(info.id, info)
  }
  endSession(id: string): void {
    this.sessions.delete(id)
    this.ended.push(id)
  }
  emit(event: HarnessEvent): boolean {
    const problem = harnessEventProblem(event)
    if (problem) throw new Error(problem)
    this.events.push(event)
    return true
  }
  sessionToken(id: string) {
    return this.tokens.get(id)
  }
  types(): string[] {
    return this.events.map((e) => e.type)
  }
  take(): HarnessEvent[] {
    return this.events.splice(0)
  }
}

function make(options: Partial<SessionsOptions> = {}) {
  const spoke = new FakeSpoke()
  const sessions = new ClaudeSessions({ spoke, tokenWaitMs: 0, projectOf: () => "/work", ...options })
  return { spoke, sessions }
}

async function started(options: Partial<SessionsOptions> = {}, ctx: HookContext = {}) {
  const made = make(options)
  await made.sessions.hook(fixture("session-start"), ctx)
  await made.sessions.hook(fixture("user-prompt-submit"), ctx)
  made.spoke.take()
  return made
}

const deliver = (sessions: ClaudeSessions, messageID: string, text: string, wake = true, extra: Partial<DeliverMeta> = {}) =>
  sessions.deliver({ op: "deliver", sessionID: HUB, messageID, text, wake, meta: { ...meta, ...extra } })

describe("session lifecycle", () => {
  test("SessionStart reports the session under its ses_cc ID and announces it once", async () => {
    const { spoke, sessions } = make()
    expect(await sessions.hook(fixture("session-start"), {})).toEqual({})
    expect(spoke.sessions.get(HUB)).toMatchObject({ id: HUB, directory: "/work", project: "/work", owned: true, title: "work" })
    expect(spoke.take()).toEqual([{ type: "session.created", data: { sessionID: HUB, title: "work" } }])
    await sessions.hook(fixture("session-start", { source: "resume" }), {})
    expect(spoke.take()).toEqual([])
  })

  test("SessionStart hands the session's hub URL and token to the env file once the hub sent it", async () => {
    const { spoke, sessions } = make({ tokenWaitMs: 500 })
    setTimeout(() => spoke.tokens.set(HUB, { token: "hst1.SESSION", url: "https://hub.example" }), 30)
    expect(await sessions.hook(fixture("session-start"), {})).toEqual({ env: { HUB_URL: "https://hub.example", HUB_SESSION_TOKEN: "hst1.SESSION" } })
  })

  test("SessionStart without a token in time writes no env (fail open)", async () => {
    const { sessions } = make({ tokenWaitMs: 20 })
    expect(await sessions.hook(fixture("session-start"), {})).toEqual({})
  })

  test("a prompt starts a turn the user typed; Stop ends it with the reply", async () => {
    const { spoke, sessions } = make()
    await sessions.hook(fixture("session-start"), {})
    spoke.take()
    expect(await sessions.hook(fixture("user-prompt-submit"), {})).toEqual({})
    const turnID = "53091e89-c478-4187-ac33-c5a395bdc751"
    expect(spoke.take()).toEqual([
      { type: "session.execution.started", data: { sessionID: HUB, turnID } },
      { type: "session.inbox.delivered", data: { sessionID: HUB, inboxID: `prompt_${turnID}`, origin: "user" } },
    ])
    await sessions.hook(fixture("stop"), {})
    expect(spoke.take()).toEqual([
      { type: "session.text.ended", data: { sessionID: HUB, assistantMessageID: `msg_${turnID}`, ordinal: 0, text: "DONE after tool" } },
      { type: "session.execution.succeeded", data: { sessionID: HUB, turnID } },
    ])
  })

  test("a prompt from a session the daemon has not seen (it restarted) reports the session first", async () => {
    const { spoke, sessions } = make()
    await sessions.hook(fixture("user-prompt-submit"), {})
    expect(spoke.sessions.has(HUB)).toBe(true)
    expect(spoke.types()).toEqual(["session.created", "session.execution.started", "session.inbox.delivered"])
  })

  test("StopFailure fails the turn with the error", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("stop-failure"), {})
    expect(spoke.take()).toEqual([
      { type: "session.execution.failed", data: { sessionID: HUB, turnID: "53091e89-c478-4187-ac33-c5a395bdc751", error: { message: "429 Too Many Requests" } } },
    ])
  })

  test("a turn without Stop (Esc) ends as an inferred interruption at the next prompt or idle notification", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("user-prompt-submit", { prompt_id: "second", prompt: "again" }), {})
    expect(spoke.take().slice(0, 2)).toEqual([
      { type: "session.execution.interrupted", data: { sessionID: HUB, turnID: "53091e89-c478-4187-ac33-c5a395bdc751", inferred: true } },
      { type: "session.execution.started", data: { sessionID: HUB, turnID: "second" } },
    ])
    await sessions.hook(fixture("notification-idle"), {})
    expect(spoke.take()).toEqual([{ type: "session.execution.interrupted", data: { sessionID: HUB, turnID: "second", inferred: true } }])
    await sessions.hook(fixture("notification-idle"), {})
    expect(spoke.take()).toEqual([])
  })

  test("SessionEnd ends the session and its subagents, inferring an interruption of a running turn", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("subagent-start"), {})
    spoke.take()
    await sessions.hook(fixture("session-end"), {})
    expect(spoke.take()).toEqual([{ type: "session.execution.interrupted", data: { sessionID: HUB, turnID: "53091e89-c478-4187-ac33-c5a395bdc751", inferred: true } }])
    expect(spoke.ended.sort()).toEqual([HUB, childSessionID(SID, "a1b2c3d4")].sort())
  })
})

describe("tools", () => {
  test("tool calls are reported compacted: an ID and a short summary, never the input or output", async () => {
    const { spoke, sessions } = await started()
    expect(await sessions.hook(fixture("pre-tool-use"), {})).toEqual({})
    expect(await sessions.hook(fixture("post-tool-use"), {})).toEqual({})
    await sessions.hook(fixture("post-tool-use-failure"), {})
    const events = spoke.take()
    expect(events).toEqual([
      { type: "session.tool.called", data: { sessionID: HUB, id: "toolu_stub5", summary: "echo hi-from-bash; echo ENVV=$SPIKEVAR" } },
      { type: "session.tool.success", data: { sessionID: HUB, id: "toolu_stub5" } },
      { type: "session.tool.failed", data: { sessionID: HUB, id: "toolu_stub6", error: "Command failed with exit code 1" } },
    ])
    expect(JSON.stringify(events)).not.toContain("from-sessionstart")
  })

  test("a subagent is a child session with its own runs and tools", async () => {
    const { spoke, sessions } = await started()
    const child = childSessionID(SID, "a1b2c3d4")
    await sessions.hook(fixture("subagent-start"), {})
    expect(spoke.sessions.get(child)).toMatchObject({ id: child, parentID: HUB, title: "Explore" })
    await sessions.hook(fixture("pre-tool-use", { agent_id: "a1b2c3d4", agent_type: "Explore" }), {})
    await sessions.hook(fixture("subagent-stop"), {})
    expect(spoke.take()).toEqual([
      { type: "session.created", data: { sessionID: child, parentID: HUB, title: "Explore" } },
      { type: "session.execution.started", data: { sessionID: child } },
      { type: "session.tool.called", data: { sessionID: child, id: "toolu_stub5", summary: "echo hi-from-bash; echo ENVV=$SPIKEVAR" } },
      { type: "session.text.ended", data: { sessionID: child, assistantMessageID: "msg_a1b2c3d4", ordinal: 0, text: "Found 3 files" } },
      { type: "session.execution.succeeded", data: { sessionID: child } },
    ])
  })
})

describe("permissions", () => {
  const asked = (id: string): HarnessEvent => ({ type: "permission.asked", data: { sessionID: HUB, id, action: "shell", resources: ["echo hi-from-bash; echo ENVV=$SPIKEVAR"] } })

  async function waiting(decision: "once" | "always" | "reject", message?: string, input: Record<string, unknown> = {}) {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("pre-tool-use"), {})
    spoke.take()
    const reply = sessions.hook(fixture("permission-request", input), { waitMs: 2000 })
    await sleep(5)
    const ask = spoke.take()[0]!
    expect(ask).toMatchObject({ type: "permission.asked", data: { sessionID: HUB, action: "shell" } })
    const requestID = (ask.data as { id: string }).id
    expect(sessions.permission({ op: "permission", sessionID: HUB, requestID, decision, ...(message ? { message } : {}) })).toEqual({})
    return { spoke, sessions, output: await reply, requestID }
  }

  test("a PermissionRequest is asked at the hub and the hub's once allows the tool", async () => {
    const { spoke, output, requestID } = await waiting("once")
    expect(output).toEqual({ output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } })
    expect(spoke.take()).toEqual([{ type: "permission.replied", data: { sessionID: HUB, requestID, reply: "once" } }])
  })

  test("reject denies with the hub's message; always saves Claude's suggested rules", async () => {
    expect((await waiting("reject", "not in prod")).output).toEqual({ output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not in prod" } } } })
    expect((await waiting("reject")).output.output).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", message: expect.stringContaining("hub") } } })
    const rules = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo:*" }], behavior: "allow", destination: "localSettings" }]
    expect((await waiting("always", undefined, { permission_suggestions: rules })).output).toEqual({
      output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: rules } } },
    })
  })

  test("the local dialog answering first (the tool ran) makes the hub's request gone", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("pre-tool-use"), {})
    const reply = sessions.hook(fixture("permission-request"), { waitMs: 5000 })
    await sleep(5)
    const requestID = (spoke.take().find((e) => e.type === "permission.asked")!.data as { id: string }).id
    await sessions.hook(fixture("post-tool-use"), {})
    expect(await reply).toEqual({})
    expect(spoke.take()).toEqual([
      { type: "permission.replied", data: { sessionID: HUB, requestID } },
      { type: "session.tool.success", data: { sessionID: HUB, id: "toolu_stub5" } },
    ])
    expect(sessions.permission({ op: "permission", sessionID: HUB, requestID, decision: "once" })).toEqual({ gone: true })
  })

  test("another tool finishing meanwhile (parallel calls) does not resolve the request", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("pre-tool-use"), {})
    const reply = sessions.hook(fixture("permission-request"), { waitMs: 5000 })
    await sleep(5)
    const requestID = (spoke.take().find((e) => e.type === "permission.asked")!.data as { id: string }).id
    await sessions.hook(fixture("post-tool-use", { tool_use_id: "toolu_other", tool_name: "Read", tool_input: { file_path: "/work/a" } }), {})
    expect(sessions.permission({ op: "permission", sessionID: HUB, requestID, decision: "once" })).toEqual({})
    expect((await reply).output).toBeDefined()
  })

  test("without a wait (0) or after the wait, the request is reported only and cleared by the session's next activity", async () => {
    for (const waitMs of [0, 20]) {
      const { spoke, sessions } = await started()
      expect(await sessions.hook(fixture("permission-request"), { waitMs })).toEqual({})
      const [ask] = spoke.take()
      expect(ask).toEqual(asked((ask!.data as { id: string }).id))
      const requestID = (ask!.data as { id: string }).id
      expect(sessions.permission({ op: "permission", sessionID: HUB, requestID, decision: "once" })).toEqual({ gone: true })
      await sessions.hook(fixture("stop"), {})
      expect(spoke.take()[0]).toEqual({ type: "permission.replied", data: { sessionID: HUB, requestID } })
    }
  })

  test("the hook going away (Claude's hook timeout) ends the wait without a decision", async () => {
    const { sessions } = await started()
    const abort = new AbortController()
    const reply = sessions.hook(fixture("permission-request"), { waitMs: 5000, signal: abort.signal })
    abort.abort()
    expect(await reply).toEqual({})
  })

  test("a permission notification without a PermissionRequest is reported; with one, it adds nothing", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("notification-permission"), {})
    expect(spoke.take()).toEqual([{ type: "permission.asked", data: { sessionID: HUB, id: expect.any(String), action: "shell", resources: [] } }])
    const other = await started()
    await other.sessions.hook(fixture("permission-request"), { waitMs: 0 })
    other.spoke.take()
    await other.sessions.hook(fixture("notification-permission"), {})
    expect(other.spoke.take()).toEqual([])
  })
})

describe("deliver", () => {
  test("into a running turn: queued, then added at the next tool boundary (PostToolUse additionalContext)", async () => {
    const { spoke, sessions } = await started()
    const admission = await deliver(sessions, "msg_1", "[hub] from @api\n---\nhello\n---")
    expect(admission).toEqual({ result: { delivered: "queued", inboxID: expect.stringMatching(/^in_/) }, resumed: false })
    const reply = await sessions.hook(fixture("post-tool-use"), {})
    const context = (reply.output as any).hookSpecificOutput
    expect(context.hookEventName).toBe("PostToolUse")
    expect(context.additionalContext).toContain("hello")
    expect(context.additionalContext).toContain("not from the user")
    expect(spoke.take()).toContainEqual({ type: "session.inbox.delivered", data: { sessionID: HUB, inboxID: admission.result.inboxID!, origin: "hub" } })
    expect((await sessions.hook(fixture("post-tool-use"), {})).output).toBeUndefined()
  })

  test("into an idle session without a rewake hook: queued for the next prompt (UserPromptSubmit additionalContext)", async () => {
    const { sessions } = await started()
    await sessions.hook(fixture("stop"), {})
    await deliver(sessions, "msg_1", "hello there")
    const reply = await sessions.hook(fixture("user-prompt-submit", { prompt_id: "p2" }), {})
    expect((reply.output as any).hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("hello there") })
  })

  test("an idle session's rewake Stop hook wakes it with the message; the woken prompt is the hub's, not the user's", async () => {
    const { spoke, sessions } = await started()
    await sessions.hook(fixture("stop"), {})
    const rewake = sessions.hook(fixture("stop"), { rewake: true })
    await sleep(5)
    spoke.take()
    const admission = await deliver(sessions, "msg_1", "wake up")
    expect(admission).toEqual({ result: { delivered: "turn", inboxID: expect.stringMatching(/^in_/) }, resumed: true })
    const woke = await rewake
    expect(woke.exit).toBe(2)
    expect(woke.stderr).toContain("wake up")
    await sessions.hook(fixture("user-prompt-rewake"), {})
    const events = spoke.take()
    expect(events).toContainEqual({ type: "session.inbox.delivered", data: { sessionID: HUB, inboxID: admission.result.inboxID!, origin: "hub" } })
    expect(events.some((e) => e.type === "session.inbox.delivered" && (e.data as { origin?: string }).origin === "user")).toBe(false)
  })

  test("a rewake hook takes waking messages already queued at once; others wait for a prompt", async () => {
    const { sessions } = await started()
    await sessions.hook(fixture("stop"), {})
    await deliver(sessions, "msg_quiet", "no wake", false)
    expect((await deliver(sessions, "msg_1", "first")).result.delivered).toBe("queued")
    const woke = await sessions.hook(fixture("stop"), { rewake: true })
    expect(woke).toMatchObject({ exit: 2 })
    expect(woke.stderr).toContain("first")
    expect(woke.stderr).not.toContain("no wake")
  })

  test("a message without wake never wakes; a new prompt releases the rewake hook", async () => {
    const { sessions } = await started()
    await sessions.hook(fixture("stop"), {})
    const rewake = sessions.hook(fixture("stop"), { rewake: true })
    expect((await deliver(sessions, "msg_1", "later", false)).result.delivered).toBe("queued")
    await sessions.hook(fixture("user-prompt-submit", { prompt_id: "p3" }), {})
    expect(await rewake).toEqual({ exit: 0 })
  })

  test("a retry that asks to wake a queued message wakes it without queueing it twice", async () => {
    const { sessions } = await started()
    await sessions.hook(fixture("stop"), {})
    await deliver(sessions, "msg_1", "once only", false)
    const rewake = sessions.hook(fixture("stop"), { rewake: true })
    await sleep(5)
    expect((await deliver(sessions, "msg_1", "once only", true)).result.delivered).toBe("turn")
    expect((await rewake).stderr!.split("once only").length).toBe(2)
    const next = await sessions.hook(fixture("user-prompt-rewake"), {})
    expect(next.output).toBeUndefined()
  })

  test("an agent's prompt (kind prompt) arrives in its provenance envelope", async () => {
    const { sessions } = await started()
    await deliver(sessions, "msg_p", "run the tests", true, { kind: "prompt", grant: "gr_1" })
    const reply = await sessions.hook(fixture("post-tool-use"), {})
    expect((reply.output as any).hookSpecificOutput.additionalContext).toContain("[hub] prompt from @api · grant gr_1")
  })
})

describe("stop", () => {
  test("a running turn stops at its next hook (continue false) and ends interrupted; an idle session has nothing to stop", async () => {
    const { spoke, sessions } = await started()
    expect(sessions.stop({ op: "stop", sessionID: HUB })).toEqual({ stopped: [HUB] })
    // Claude Code 2.1.296 still runs the tool after a PreToolUse continue:false (live check, P7-T11): the stop also
    // denies the call.
    expect(await sessions.hook(fixture("pre-tool-use"), {})).toEqual({
      output: {
        continue: false,
        stopReason: expect.stringContaining("hub"),
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("hub") },
      },
    })
    expect(spoke.take()).toContainEqual({ type: "session.execution.interrupted", data: { sessionID: HUB, turnID: "53091e89-c478-4187-ac33-c5a395bdc751" } })
    expect(sessions.stop({ op: "stop", sessionID: HUB })).toEqual({ stopped: [] })
  })

  test("after a tool ran (PostToolUse) the stop is continue false alone: nothing left to deny", async () => {
    const { sessions } = await started()
    sessions.stop({ op: "stop", sessionID: HUB })
    expect(await sessions.hook(fixture("post-tool-use"), {})).toEqual({ output: { continue: false, stopReason: expect.stringContaining("hub") } })
  })

  test("a waiting permission request is denied with an interrupt", async () => {
    const { sessions } = await started()
    const reply = sessions.hook(fixture("permission-request"), { waitMs: 5000 })
    await sleep(5)
    sessions.stop({ op: "stop", sessionID: HUB })
    expect((await reply).output).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: expect.any(String), interrupt: true } } })
  })
})

describe("prompt references and launches", () => {
  test("a user's prompt gets the hub's reference context; a hub-woken prompt does not", async () => {
    const seen: string[] = []
    const { sessions } = make({
      references: async (prompt, sessionID) => {
        seen.push(`${sessionID}:${prompt}`)
        return "hub: @api = session ses_x"
      },
    })
    await sessions.hook(fixture("session-start"), {})
    const reply = await sessions.hook(fixture("user-prompt-submit", { prompt: "ask @api" }), {})
    expect((reply.output as any).hookSpecificOutput.additionalContext).toContain("@api = session ses_x")
    await sessions.hook(fixture("user-prompt-rewake"), {})
    expect(seen).toEqual([`${HUB}:ask @api`])
  })

  test("a launch (one `hub claude` run) maps to its current session; ending it ends its sessions", async () => {
    const { spoke, sessions } = make()
    await sessions.hook(fixture("session-start"), { launch: "L1" })
    expect(sessions.sessionForLaunch("L1")).toBe(HUB)
    expect(sessions.sessionForLaunch("L2")).toBeUndefined()
    sessions.endLaunch("L1")
    expect(spoke.ended).toEqual([HUB])
    expect(sessions.sessionForLaunch("L1")).toBeUndefined()
  })
})

describe("hub-launched sessions", () => {
  test("launched() reports the session at once (before any hook) with the launch's title, tied to its launch", () => {
    const { spoke, sessions } = make()
    expect(sessions.launched({ sessionID: SID, cwd: "/work/app", launch: "cl_l1", title: "fix-tests" })).toBe(HUB)
    expect(spoke.sessions.get(HUB)).toMatchObject({ id: HUB, title: "fix-tests", directory: "/work/app", owned: true, project: "/work" })
    expect(spoke.take()).toEqual([{ type: "session.created", data: { sessionID: HUB, title: "fix-tests" } }])
    expect(sessions.sessionForLaunch("cl_l1")).toBe(HUB)
    expect(sessions.nativeOf(HUB)).toBe(SID)
    // Its hooks then find the same session (no second session.created).
    sessions.endLaunch("cl_l1")
    expect(spoke.ended).toEqual([HUB])
    expect(sessions.nativeOf(HUB)).toBeUndefined()
  })

  test("a launched session's SessionStart does not announce it again", async () => {
    const { spoke, sessions } = make()
    sessions.launched({ sessionID: SID, cwd: "/work", launch: "cl_l1" })
    spoke.take()
    await sessions.hook(fixture("session-start"), { launch: "cl_l1" })
    expect(spoke.types()).toEqual([])
  })

  test("nativeOf answers root sessions only (not a subagent's child session)", async () => {
    const { sessions } = await started()
    await sessions.hook(fixture("subagent-start"), {})
    expect(sessions.nativeOf(HUB)).toBe(SID)
    expect(sessions.nativeOf(childSessionID(SID, fixture("subagent-start").agent_id as string))).toBeUndefined()
  })

  test("a prompt the hub wrote (hubPrompt) is delivered with origin hub, not as the user's", async () => {
    const { spoke, sessions } = make()
    sessions.launched({ sessionID: SID, cwd: "/work", launch: "cl_l1" })
    spoke.take()
    sessions.hubPrompt(SID)
    await sessions.hook(fixture("user-prompt-submit"), { launch: "cl_l1" })
    const delivered = spoke.take().filter((e) => e.type === "session.inbox.delivered")
    expect(delivered).toEqual([{ type: "session.inbox.delivered", data: { sessionID: HUB, inboxID: expect.stringMatching(/^prompt_/), origin: "hub" } }])
    // The next prompt (typed) is the user's again.
    await sessions.hook(fixture("stop"), {})
    await sessions.hook(fixture("user-prompt-submit", { prompt_id: "p2" }), {})
    expect(spoke.take().find((e) => e.type === "session.inbox.delivered")?.data).toMatchObject({ origin: "user" })
  })

  test("turnEnded: a turn the hooks did not end (an interrupt has no Stop hook) ends with the result's outcome", async () => {
    const { spoke, sessions } = await started()
    sessions.turnEnded(SID, "interrupted")
    expect(spoke.take()).toEqual([{ type: "session.execution.interrupted", data: { sessionID: HUB, turnID: expect.any(String) } }])
    // Already ended by Stop: nothing more.
    await sessions.hook(fixture("user-prompt-submit", { prompt_id: "p2" }), {})
    await sessions.hook(fixture("stop"), {})
    spoke.take()
    sessions.turnEnded(SID, "succeeded")
    expect(spoke.take()).toEqual([])
    await sessions.hook(fixture("user-prompt-submit", { prompt_id: "p3" }), {})
    spoke.take()
    sessions.turnEnded(SID, "failed", "model failed")
    expect(spoke.take()).toEqual([{ type: "session.execution.failed", data: { sessionID: HUB, turnID: expect.any(String), error: { message: "model failed" } } }])
  })
})
