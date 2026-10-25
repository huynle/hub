// `hub mcp`'s MCP server (JSON-RPC 2.0) in process: the protocol (initialize, ping, notifications, errors), and the
// tools (the CLI's verbs) against a fake hub (Bun.serve).
import { describe, expect, test } from "bun:test"
import { createMcpServer, MCP_PROTOCOL_VERSIONS } from "../src/mcp"

const server = (credentials = () => ({ url: "http://127.0.0.1:9", token: "tok", source: "env" as const })) => createMcpServer({ credentials, version: "9.9.9" })

describe("JSON-RPC core", () => {
  test("initialize echoes a supported protocolVersion, names the server and announces tools", async () => {
    const r = await server().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "hub", version: "9.9.9" }, capabilities: { tools: {} } } })
  })

  test("initialize with an unknown protocolVersion answers the newest the server supports", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any
    expect(r.id).toBe("a")
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
    expect(MCP_PROTOCOL_VERSIONS).toContain("2024-11-05")
  })

  test("ping answers an empty result", async () => {
    expect(await server().handle({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 7, result: {} })
  })

  test("notifications (no id) get no answer, known or not", async () => {
    const s = server()
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/whatever", params: {} })).toBeUndefined()
  })

  test("unknown methods are -32601", async () => {
    const r = (await server().handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })) as any
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32601 } })
    expect(r.error.message).toContain("resources/list")
  })

  test("invalid requests are -32600 (with the id when it has one); responses from the client are ignored", async () => {
    const s = server()
    expect(await s.handle({ jsonrpc: "1.0", id: 4, method: "ping" })).toMatchObject({ id: 4, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: 5, method: 42 })).toMatchObject({ id: 5, error: { code: -32600 } })
    expect(await s.handle("nope")).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle([{ jsonrpc: "2.0", id: 6, method: "ping" }])).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } })
    expect(await s.handle({ jsonrpc: "2.0", id: 8, result: {} })).toBeUndefined()
  })
})
