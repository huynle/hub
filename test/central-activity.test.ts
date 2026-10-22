// Activity feed over HTTP: SSE `activity` messages and `activity` in GET /api/sessions/:id.
import { afterEach, describe, expect, test } from "bun:test"
import { harness, session, spoke, sse, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })

describe("activity", () => {
  test("SSE carries create and state changes with sessionID and rootID; GET includes the root's recent items", async () => {
    h = harness()
    const client = await spoke(h, {
      sessions: [session("ses_1", { owned: true }), session("ses_kid", { parentID: "ses_1" })],
    })
    const events = sse(await h.api("/api/events"))
    const tool = { sessionID: "ses_kid", assistantMessageID: "msg_1", id: "tool_1" }
    client.send(event("session.tool.input.started", { ...tool, name: "bash" }))
    client.send(event("session.tool.called", { ...tool, summary: "bun test", background: false }))
    client.send(event("session.tool.success", tool))
    const first = await events.next((m) => m.type === "activity")
    expect(first).toEqual({
      type: "activity",
      sessionID: "ses_kid",
      rootID: "ses_1",
      item: { id: "tool_1", sessionID: "ses_kid", kind: "tool", tool: "bash", state: "running", at: expect.any(Number) },
    })
    const done = await events.next((m) => m.type === "activity" && m.item.state === "done")
    expect(done.item).toMatchObject({ id: "tool_1", tool: "bash", summary: "bun test", state: "done" })
    await events.cancel()

    for (const id of ["ses_1", "ses_kid"]) {
      const view = (await (await h.api(`/api/sessions/${id}`)).json()) as any
      expect(view.activity).toEqual([done.item])
    }
  })

  test("SSE streams subagent text and reasoning with rootID, and reasoning.ended closes the thinking item", async () => {
    h = harness()
    const client = await spoke(h, {
      sessions: [session("ses_1", { owned: true }), session("ses_kid", { parentID: "ses_1" })],
    })
    const events = sse(await h.api("/api/events"))
    client.send(event("session.reasoning.delta", { sessionID: "ses_kid", assistantMessageID: "msg_k", delta: "Checking the tests" }))
    expect(await events.next((m) => m.type === "reasoning")).toEqual({ type: "reasoning", sessionID: "ses_kid", rootID: "ses_1", messageID: "msg_k", delta: "Checking the tests" })
    client.send(event("session.text.delta", { sessionID: "ses_kid", assistantMessageID: "msg_k2", delta: "Fixed." }))
    expect(await events.next((m) => m.type === "delta")).toEqual({ type: "delta", sessionID: "ses_kid", rootID: "ses_1", messageID: "msg_k2", text: "Fixed." })
    client.send(event("session.reasoning.ended", { sessionID: "ses_kid", assistantMessageID: "msg_k" }))
    const done = await events.next((m) => m.type === "activity" && m.item.state === "done")
    expect(done.item).toMatchObject({ id: "thinking:msg_k", sessionID: "ses_kid", kind: "thinking" })
    await events.cancel()
  })

  test("a subagent tool item learns its child session; text deltas keep their text part ordinal", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const events = sse(await h.api("/api/events"))
    const tool = { sessionID: "ses_1", assistantMessageID: "msg_1", id: "tool_s" }
    client.send(event("session.tool.input.started", { ...tool, name: "subagent" }))
    client.send(event("session.tool.called", { ...tool, summary: "Research", background: true }))
    client.send(event("session.tool.called", { ...tool, childSessionID: "ses_kid" }))
    const linked = await events.next((m) => m.type === "activity" && m.item.childSessionID)
    expect(linked.item).toMatchObject({ id: "tool_s", tool: "subagent", summary: "Research", background: true, childSessionID: "ses_kid", state: "running" })
    client.send(event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_2", ordinal: 1, delta: "Second part" }))
    expect(await events.next((m) => m.type === "delta")).toEqual({ type: "delta", sessionID: "ses_1", rootID: "ses_1", messageID: "msg_2", ordinal: 1, text: "Second part" })
    await events.cancel()
  })

  test("a session without activity has an empty list", async () => {
    h = harness()
    await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    await waitFor(() => h.registry.hasSession("ses_1"))
    expect(((await (await h.api("/api/sessions/ses_1")).json()) as any).activity).toEqual([])
  })
})
