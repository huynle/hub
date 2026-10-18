// Console API calls (web/src/app/api.ts): HTTP errors carry the status and the hub's message; a network-level
// failure (the browser's bare "Failed to fetch" TypeError) becomes a NetworkError with a readable message.
import { afterEach, describe, expect, test } from "bun:test"
import { api, errorText, HttpError, NetworkError } from "../web/src/app/api"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("api", () => {
  test("a dropped connection is a NetworkError with a clear message, never the raw 'Failed to fetch'", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    const error = await api("/api/sessions/s/turn", { method: "POST", json: { text: "hi" } }).catch((e) => e)
    expect(error).toBeInstanceOf(NetworkError)
    expect(errorText(error)).not.toMatch(/failed to fetch/i)
    expect(errorText(error)).toMatch(/hub/i)
  })

  test("an aborted request stays an AbortError", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The user aborted a request.", "AbortError")
    }) as unknown as typeof fetch
    const error = await api("/api/x").catch((e) => e)
    expect(error).not.toBeInstanceOf(NetworkError)
    expect((error as Error).name).toBe("AbortError")
  })

  test("HTTP errors keep the hub's message and status", async () => {
    globalThis.fetch = (async () => Response.json({ error: "No OpenCode process", code: "offline" }, { status: 409 })) as unknown as typeof fetch
    const error = await api("/api/x").catch((e) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 409, message: "No OpenCode process", code: "offline" })
  })
})
