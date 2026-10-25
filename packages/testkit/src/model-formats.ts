// The three model wire formats the stub model server speaks: what a request asks (latest user text, tool results)
// and how a scripted reply is encoded, as JSON or as an SSE stream split around the reply's delay.
import { sseFrame } from "./sse.ts"

export type ModelFormat = "chat" | "anthropic" | "responses"

export interface StubToolCall {
  readonly name: string
  readonly input: unknown
  /** The call id (tool_call id, tool_use id or Responses call_id); generated when absent. */
  readonly id?: string
}

/** A model turn: text and/or tool calls. */
export interface StubTurn {
  readonly text?: string
  readonly toolCalls?: readonly StubToolCall[]
  /** Holds the content this long: after the stream has started (streaming) or before the answer (JSON). */
  readonly delayMs?: number
}

/** An HTTP error instead of a turn. */
export interface StubError {
  readonly status: number
  readonly body?: unknown
  readonly delayMs?: number
}

export type StubReply = StubTurn | StubError

export const isStubError = (reply: StubReply): reply is StubError => typeof (reply as StubError).status === "number"

export interface Inspected {
  /** Text of the latest user message (tool results excluded). */
  readonly user: string
  /** Text of every user message, in order. */
  readonly users: readonly string[]
  /** Text of every tool result in the request, in order. */
  readonly toolResults: readonly string[]
}

export interface Stream {
  /** Frames written before the delay. */
  readonly head: readonly string[]
  readonly tail: readonly string[]
}

export interface Format {
  inspect(body: any): Inspected
  json(body: any, turn: StubTurn, n: number): unknown
  stream(body: any, turn: StubTurn, n: number): Stream
}

const USAGE = { input_tokens: 10, output_tokens: 5 }

/** Text of string content or of an array of parts with `text` (input_text, output_text, text …). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p: any) => typeof p?.text === "string" && p.type !== "tool_result")
    .map((p: any) => p.text as string)
    .join("\n")
}

const args = (input: unknown) => JSON.stringify(input ?? {})

// ---- OpenAI chat completions -------------------------------------------------------------------------------------

export const chat: Format = {
  inspect(body) {
    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const users = messages.filter((m) => m?.role === "user").map((m) => contentText(m.content))
    const toolResults = messages.filter((m) => m?.role === "tool").map((m) => contentText(m.content))
    return { user: users.at(-1) ?? "", users, toolResults }
  },
  json(body, turn, n) {
    const calls = chatCalls(turn, n)
    return {
      id: `chatcmpl-stub${n}`,
      object: "chat.completion",
      created: 0,
      model: body?.model ?? "stub",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: turn.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) },
          finish_reason: calls.length ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: USAGE.input_tokens, completion_tokens: USAGE.output_tokens, total_tokens: USAGE.input_tokens + USAGE.output_tokens },
    }
  },
  stream(body, turn, n) {
    const chunk = (delta: unknown, finish: string | null) =>
      sseFrame({ id: `chatcmpl-stub${n}`, object: "chat.completion.chunk", created: 0, model: body?.model ?? "stub", choices: [{ index: 0, delta, finish_reason: finish }] })
    const calls = chatCalls(turn, n)
    const tail: string[] = []
    if (turn.text !== undefined) tail.push(chunk({ content: turn.text }, null))
    if (calls.length) tail.push(chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) }, null))
    tail.push(chunk({}, calls.length ? "tool_calls" : "stop"), sseFrame("[DONE]"))
    return { head: [chunk({ role: "assistant", content: "" }, null)], tail }
  },
}

function chatCalls(turn: StubTurn, n: number) {
  return (turn.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_stub${n}_${i}`, type: "function", function: { name: c.name, arguments: args(c.input) } }))
}

// ---- Anthropic Messages ------------------------------------------------------------------------------------------

export const anthropic: Format = {
  inspect(body) {
    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const users = messages.filter((m) => m?.role === "user").map((m) => contentText(m.content))
    const toolResults = messages
      .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
      .filter((b: any) => b?.type === "tool_result")
      .map((b: any) => contentText(b.content))
    return { user: users.at(-1) ?? "", users, toolResults }
  },
  json(body, turn, n) {
    return { ...anthropicMessage(body, n), content: anthropicBlocks(turn, n), stop_reason: anthropicStop(turn) }
  },
  stream(body, turn, n) {
    const ev = (type: string, data: object) => sseFrame({ type, ...data }, type)
    const tail: string[] = []
    anthropicBlocks(turn, n).forEach((block, index) => {
      if (block.type === "text") {
        tail.push(ev("content_block_start", { index, content_block: { type: "text", text: "" } }))
        tail.push(ev("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }))
      } else {
        tail.push(ev("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }))
        tail.push(ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: args(block.input) } }))
      }
      tail.push(ev("content_block_stop", { index }))
    })
    tail.push(ev("message_delta", { delta: { stop_reason: anthropicStop(turn), stop_sequence: null }, usage: { output_tokens: USAGE.output_tokens } }))
    tail.push(ev("message_stop", {}))
    return { head: [ev("message_start", { message: { ...anthropicMessage(body, n), content: [], stop_reason: null } })], tail }
  },
}

function anthropicMessage(body: any, n: number) {
  return {
    id: `msg_stub${n}`,
    type: "message",
    role: "assistant",
    model: body?.model ?? "stub",
    stop_sequence: null,
    usage: { ...USAGE, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

type AnthropicBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }

function anthropicBlocks(turn: StubTurn, n: number): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = turn.text !== undefined ? [{ type: "text", text: turn.text }] : []
  for (const [i, c] of (turn.toolCalls ?? []).entries()) blocks.push({ type: "tool_use", id: c.id ?? `toolu_stub${n}_${i}`, name: c.name, input: c.input ?? {} })
  return blocks
}

const anthropicStop = (turn: StubTurn) => (turn.toolCalls?.length ? "tool_use" : "end_turn")

// ---- OpenAI Responses --------------------------------------------------------------------------------------------

export const responses: Format = {
  inspect(body) {
    const input = body?.input
    if (typeof input === "string") return { user: input, users: [input], toolResults: [] }
    const items: any[] = Array.isArray(input) ? input : []
    const users = items.filter((it) => it?.role === "user").map((it) => contentText(it.content))
    const toolResults = items
      .filter((it) => it?.type === "function_call_output" || it?.type === "custom_tool_call_output")
      .map((it) => (typeof it.output === "string" ? it.output : contentText(it.output) || JSON.stringify(it.output)))
    return { user: users.at(-1) ?? "", users, toolResults }
  },
  json(body, turn, n) {
    return responseObject(body, n, "completed", responseItems(turn, n))
  },
  stream(body, turn, n) {
    let seq = 0
    const ev = (type: string, data: object) => sseFrame({ type, sequence_number: seq++, ...data }, type)
    const head = [ev("response.created", { response: responseObject(body, n, "in_progress", []) }), ev("response.in_progress", { response: responseObject(body, n, "in_progress", []) })]
    const tail: string[] = []
    const items = responseItems(turn, n)
    items.forEach((item, output_index) => {
      if (item.type === "message") {
        const text = item.content[0]!.text
        const part = { type: "output_text", text: "", annotations: [] }
        tail.push(ev("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } }))
        tail.push(ev("response.content_part.added", { item_id: item.id, output_index, content_index: 0, part }))
        tail.push(ev("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: text }))
        tail.push(ev("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text }))
        tail.push(ev("response.content_part.done", { item_id: item.id, output_index, content_index: 0, part: { ...part, text } }))
      } else {
        tail.push(ev("response.output_item.added", { output_index, item: { ...item, status: "in_progress", arguments: "" } }))
        tail.push(ev("response.function_call_arguments.delta", { item_id: item.id, output_index, delta: item.arguments }))
        tail.push(ev("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments }))
      }
      tail.push(ev("response.output_item.done", { output_index, item }))
    })
    tail.push(ev("response.completed", { response: responseObject(body, n, "completed", items) }))
    return { head, tail }
  },
}

type ResponseItem =
  | { type: "message"; id: string; role: "assistant"; status: "completed"; content: Array<{ type: "output_text"; text: string; annotations: [] }> }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string; status: "completed" }

function responseItems(turn: StubTurn, n: number): ResponseItem[] {
  const items: ResponseItem[] = []
  if (turn.text !== undefined) items.push({ type: "message", id: `msg_stub${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.text, annotations: [] }] })
  for (const [i, c] of (turn.toolCalls ?? []).entries())
    items.push({ type: "function_call", id: `fc_stub${n}_${i}`, call_id: c.id ?? `call_stub${n}_${i}`, name: c.name, arguments: args(c.input), status: "completed" })
  return items
}

function responseObject(body: any, n: number, status: string, output: unknown[]) {
  return {
    id: `resp_stub${n}`,
    object: "response",
    created_at: 0,
    status,
    model: body?.model ?? "stub",
    output,
    usage:
      status === "completed"
        ? { ...USAGE, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: USAGE.input_tokens + USAGE.output_tokens }
        : null,
  }
}
