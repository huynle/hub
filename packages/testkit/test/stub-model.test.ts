import { afterEach, describe, expect, test } from "bun:test"
import { parseSSE, stubModel, type StubModel, type StubModelOptions } from "../src/index.ts"

let stubs: StubModel[] = []
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.stop()
})
const start = (options?: StubModelOptions) => {
  const s = stubModel(options)
  stubs.push(s)
  return s
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

describe("parseSSE", () => {
  test("splits events, joins data lines and keeps the event name", () => {
    expect(parseSSE("event: a\ndata: {\"x\":1}\n\ndata: one\ndata: two\n\n: comment\n\ndata: [DONE]\n\n")).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: undefined, data: "one\ntwo" },
      { event: undefined, data: "[DONE]" },
    ])
  })
})

describe("stubModel: OpenAI chat completions", () => {
  test("streams 'ack' by default and records the request", async () => {
    const stub = start()
    expect(stub.openaiBaseURL).toBe(`${stub.url}/v1`)
    const res = await post(`${stub.openaiBaseURL}/chat/completions`, {
      model: "stub",
      stream: true,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "there" }] },
      ],
    }, { authorization: "Bearer dummy" })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseSSE(await res.text())
    expect(events.at(-1)!.data).toBe("[DONE]")
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data))
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true)
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("ack")
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop")
    expect(stub.requests.length).toBe(1)
    const req = stub.requests[0]!
    expect(req).toMatchObject({ format: "chat", method: "POST", path: "/v1/chat/completions", user: "hello\nthere", toolResults: [] })
    expect(req.headers.authorization).toBe("Bearer dummy")
    expect(req.body.model).toBe("stub")
  })

  test("streams scripted tool calls with finish_reason tool_calls", async () => {
    const stub = start()
    stub.queue({ toolCalls: [{ name: "hub", input: { verb: "msg" }, id: "call_1" }] })
    const res = await post(`${stub.openaiBaseURL}/chat/completions`, { stream: true, messages: [{ role: "user", content: "go" }] })
    const chunks = parseSSE(await res.text()).slice(0, -1).map((e) => JSON.parse(e.data))
    const calls = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])
    expect(calls[0]).toMatchObject({ index: 0, id: "call_1", type: "function", function: { name: "hub" } })
    expect(JSON.parse(calls.map((c: any) => c.function.arguments).join(""))).toEqual({ verb: "msg" })
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls")
  })

  test("answers without streaming and records tool results", async () => {
    const stub = start()
    stub.queue({ text: "done", toolCalls: [{ name: "bash", input: { command: "ls" } }] })
    const res = await post(`${stub.openaiBaseURL}/chat/completions`, {
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", tool_calls: [{ id: "c0", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c0", content: "file.txt" },
      ],
    })
    const body = await res.json()
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0].message.content).toBe("done")
    expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "bash", arguments: '{"command":"ls"}' })
    expect(body.choices[0].finish_reason).toBe("tool_calls")
    expect(stub.requests[0]).toMatchObject({ user: "run", toolResults: ["file.txt"] })
  })

  test("lists models", async () => {
    const stub = start()
    const body = await (await fetch(`${stub.openaiBaseURL}/models`)).json()
    expect(body).toEqual({ object: "list", data: [{ id: "stub", object: "model", created: 0, owned_by: "stub" }] })
  })
})

describe("stubModel: Anthropic Messages", () => {
  test("streams text as message_start … message_stop", async () => {
    const stub = start()
    stub.queue({ text: "hi there" })
    const res = await post(`${stub.anthropicBaseURL}/v1/messages`, { model: "claude-x", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hello" }] }, { "x-api-key": "dummy" })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseSSE(await res.text())
    expect(events.map((e) => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    const data = events.map((e) => JSON.parse(e.data))
    expect(data.every((d, i) => d.type === events[i]!.event)).toBe(true)
    expect(data[0].message).toMatchObject({ type: "message", role: "assistant", model: "claude-x", content: [] })
    expect(data[1]).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    expect(data[2]).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi there" } })
    expect(data[4].delta.stop_reason).toBe("end_turn")
    expect(stub.requests[0]).toMatchObject({ format: "anthropic", path: "/v1/messages", user: "hello" })
    expect(stub.requests[0]!.headers["x-api-key"]).toBe("dummy")
  })

  test("streams tool_use after text with input_json_delta", async () => {
    const stub = start()
    stub.queue({ text: "running", toolCalls: [{ name: "Bash", input: { command: "echo hi", description: "d" }, id: "toolu_1" }] })
    const res = await post(`${stub.anthropicBaseURL}/v1/messages`, { stream: true, messages: [{ role: "user", content: [{ type: "text", text: "BASH" }] }] })
    const data = parseSSE(await res.text()).map((e) => JSON.parse(e.data))
    const starts = data.filter((d) => d.type === "content_block_start")
    expect(starts.map((s) => [s.index, s.content_block.type])).toEqual([[0, "text"], [1, "tool_use"]])
    expect(starts[1].content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "Bash", input: {} })
    const json = data.filter((d) => d.type === "content_block_delta" && d.index === 1).map((d) => d.delta.partial_json).join("")
    expect(JSON.parse(json)).toEqual({ command: "echo hi", description: "d" })
    expect(data.find((d) => d.type === "message_delta").delta.stop_reason).toBe("tool_use")
  })

  test("answers without streaming, counts tokens and records tool results", async () => {
    const stub = start()
    stub.queue({ toolCalls: [{ name: "Bash", input: { command: "ls" } }] })
    const res = await post(`${stub.anthropicBaseURL}/v1/messages`, {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: [{ type: "text", text: "out" }] }, { type: "text", text: "next" }] },
      ],
    })
    const body = await res.json()
    expect(body).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use" })
    expect(body.content[0]).toMatchObject({ type: "tool_use", name: "Bash", input: { command: "ls" } })
    expect(body.content[0].id).toMatch(/^toolu_/)
    expect(stub.requests[0]).toMatchObject({ user: "next", toolResults: ["out"] })
    const count = await (await post(`${stub.anthropicBaseURL}/v1/messages/count_tokens`, { messages: [] })).json()
    expect(count).toEqual({ input_tokens: 10 })
  })
})

describe("stubModel: OpenAI Responses", () => {
  test("streams a text message", async () => {
    const stub = start()
    stub.queue({ text: "reply" })
    const res = await post(`${stub.openaiBaseURL}/responses`, {
      model: "gpt-x",
      stream: true,
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseSSE(await res.text())
    const types = events.map((e) => e.event)
    expect(types[0]).toBe("response.created")
    expect(types.at(-1)).toBe("response.completed")
    expect(types).toContain("response.output_item.added")
    expect(types).toContain("response.output_text.delta")
    expect(types).toContain("response.output_item.done")
    const data = events.map((e) => JSON.parse(e.data))
    expect(data.every((d, i) => d.type === events[i]!.event)).toBe(true)
    expect(data.filter((d) => d.type === "response.output_text.delta").map((d) => d.delta).join("")).toBe("reply")
    const done = data.at(-1).response
    expect(done.status).toBe("completed")
    expect(done.output).toEqual([{ type: "message", id: expect.any(String), role: "assistant", status: "completed", content: [{ type: "output_text", text: "reply", annotations: [] }] }])
    expect(done.usage).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) })
    expect(stub.requests[0]).toMatchObject({ format: "responses", path: "/v1/responses", user: "hello" })
  })

  test("streams a function call and records function_call_output", async () => {
    const stub = start()
    stub.queue({ toolCalls: [{ name: "exec_command", input: { cmd: "ls" }, id: "call_9" }] })
    const res = await post(`${stub.openaiBaseURL}/responses`, {
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "do it" }] },
        { type: "function_call", call_id: "call_0", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_0", output: "ok" },
      ],
    })
    const data = parseSSE(await res.text()).map((e) => JSON.parse(e.data))
    const item = data.find((d) => d.type === "response.output_item.done").item
    expect(item).toMatchObject({ type: "function_call", call_id: "call_9", name: "exec_command", status: "completed" })
    expect(JSON.parse(item.arguments)).toEqual({ cmd: "ls" })
    expect(data.filter((d) => d.type === "response.function_call_arguments.delta").map((d) => d.delta).join("")).toBe(item.arguments)
    expect(stub.requests[0]).toMatchObject({ user: "do it", toolResults: ["ok"] })
  })

  test("accepts a string input and answers without streaming", async () => {
    const stub = start()
    const body = await (await post(`${stub.openaiBaseURL}/responses`, { input: "plain" })).json()
    expect(body).toMatchObject({ object: "response", status: "completed" })
    expect(body.output[0].content[0].text).toBe("ack")
    expect(stub.requests[0]!.user).toBe("plain")
  })
})

describe("stubModel: scripting", () => {
  test("queued replies win, then the respond script, then the default", async () => {
    const seen: string[] = []
    const stub = start({ respond: (req) => (seen.push(req.format), req.user === "script" ? { text: `scripted ${req.format}` } : undefined), defaultText: "fallback" })
    stub.queue({ text: "queued" })
    const ask = async (text: string) => (await (await post(`${stub.openaiBaseURL}/chat/completions`, { messages: [{ role: "user", content: text }] })).json()).choices[0].message.content
    expect(await ask("script")).toBe("queued")
    expect(await ask("script")).toBe("scripted chat")
    expect(await ask("other")).toBe("fallback")
    expect(seen).toEqual(["chat", "chat"])
  })

  test("an error reply sets the status and body", async () => {
    const stub = start()
    stub.queue({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "busy" } } })
    const res = await post(`${stub.anthropicBaseURL}/v1/messages`, { stream: true, messages: [] })
    expect(res.status).toBe(529)
    expect(await res.json()).toEqual({ type: "error", error: { type: "overloaded_error", message: "busy" } })
  })

  test("delayMs holds the content after the stream has started", async () => {
    const stub = start()
    stub.queue({ text: "slow", delayMs: 150 })
    const t0 = Date.now()
    const res = await post(`${stub.anthropicBaseURL}/v1/messages`, { stream: true, messages: [{ role: "user", content: "x" }] })
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("message_start")
    expect(first).not.toContain("slow")
    let rest = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    expect(rest).toContain("slow")
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
  })

  test("next() waits for a matching request; unknown paths are 404 and not recorded", async () => {
    const stub = start()
    const waiting = stub.next((r) => r.user === "B")
    await post(`${stub.openaiBaseURL}/chat/completions`, { messages: [{ role: "user", content: "A" }] })
    await post(`${stub.openaiBaseURL}/chat/completions`, { messages: [{ role: "user", content: "B" }] })
    expect((await waiting).user).toBe("B")
    expect((await post(`${stub.url}/v2/whatever`, {})).status).toBe(404)
    expect(stub.requests.length).toBe(2)
    await expect(stub.next((r) => r.user === "C", 30)).rejects.toThrow("timed out")
  })
})
