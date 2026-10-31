// Session error and retry wording (web/src/core/error-core.ts): labels for OpenCode error types, HTTP status,
// retry countdowns, and the error of a session tree from the hub's status entries.
import { describe, expect, test } from "bun:test"
import { countdown, errorLabel, errorLine, httpStatus, retryLine, treeError } from "../web/src/core/error-core"

describe("errorLabel", () => {
  test("labels the error types of OpenCode", () => {
    expect(errorLabel("provider.quota")).toBe("Quota exceeded")
    expect(errorLabel("provider.free-limit")).toBe("Quota exceeded")
    expect(errorLabel("budget.exceeded")).toBe("Quota exceeded")
    expect(errorLabel("provider.budget")).toBe("Quota exceeded")
    expect(errorLabel("provider.auth")).toBe("Authentication failed")
    expect(errorLabel("provider.rate-limit")).toBe("Rate limited")
    expect(errorLabel("provider.internal")).toBe("Provider unavailable")
    expect(errorLabel("provider.transport")).toBe("Provider unavailable")
    expect(errorLabel("provider.timeout")).toBe("Provider unavailable")
    expect(errorLabel("provider.content-filter")).toBe("Blocked by content filter")
    expect(errorLabel("provider.no-route")).toBe("No route to model")
    expect(errorLabel("provider.invalid-request")).toBe("Invalid request")
    expect(errorLabel("provider.invalid-output")).toBe("Invalid model output")
    expect(errorLabel("provider.unsupported-operation")).toBe("Unsupported operation")
    expect(errorLabel("tool.execution")).toBe("Tool failed")
    expect(errorLabel("permission.rejected")).toBe("Permission rejected")
  })

  test("unknown or missing types have no label (the caller shows the message)", () => {
    expect(errorLabel("provider.unknown")).toBeUndefined()
    expect(errorLabel("unknown")).toBeUndefined()
    expect(errorLabel("something.new")).toBeUndefined()
    expect(errorLabel(undefined)).toBeUndefined()
    expect(errorLabel(42 as any)).toBeUndefined()
  })
})

describe("httpStatus", () => {
  test("HTTP status codes only", () => {
    expect(httpStatus(429)).toBe("HTTP 429")
    expect(httpStatus(undefined)).toBeUndefined()
    expect(httpStatus(0)).toBeUndefined()
    expect(httpStatus(42.5)).toBeUndefined()
    expect(httpStatus("429" as any)).toBeUndefined()
  })
})

describe("countdown", () => {
  test("time left until `next`; nothing when missing or past", () => {
    expect(countdown(1000 + 250_000, 1000)).toBe("4m 10s")
    expect(countdown(1000 + 4_200, 1000)).toBe("5s")
    expect(countdown(1000 + 2 * 3600_000 + 60_000, 1000)).toBe("2h 1m")
    expect(countdown(1000, 1000)).toBeUndefined()
    expect(countdown(500, 1000)).toBeUndefined()
    expect(countdown(undefined, 1000)).toBeUndefined()
  })
})

describe("errorLine", () => {
  test("label, HTTP status and message", () => {
    expect(errorLine({ errorType: "provider.quota", errorStatus: 429, message: "You exceeded your current quota" })).toBe(
      "Quota exceeded (HTTP 429): You exceeded your current quota",
    )
    expect(errorLine({ errorType: "provider.auth" })).toBe("Authentication failed")
    expect(errorLine({ message: "Boom" })).toBe("Boom")
    expect(errorLine({ errorType: "unknown", errorStatus: 500, message: "Boom" })).toBe("Boom (HTTP 500)")
    expect(errorLine({})).toBe("Error")
    // A message that only repeats the label is not repeated.
    expect(errorLine({ errorType: "provider.rate-limit", message: "Rate limited" })).toBe("Rate limited")
  })
})

describe("retryLine", () => {
  const now = 1_000_000
  test("old data keeps its wording", () => {
    expect(retryLine({ attempt: 2, message: "Rate limited" }, now)).toBe("Retrying (attempt 2): Rate limited")
    expect(retryLine({}, now)).toBe("Retrying")
  })
  test("error type label and countdown to the next attempt", () => {
    expect(retryLine({ attempt: 3, errorType: "provider.quota", message: "Quota exceeded for model", next: now + 250_000 }, now)).toBe(
      "Retrying (attempt 3) · next in 4m 10s: Quota exceeded — Quota exceeded for model",
    )
    expect(retryLine({ attempt: 1, errorType: "provider.rate-limit", next: now + 5_000 }, now)).toBe("Retrying (attempt 1) · next in 5s: Rate limited")
    // Past `next`: no countdown.
    expect(retryLine({ attempt: 1, errorType: "provider.rate-limit", message: "Slow down", next: now - 1 }, now)).toBe("Retrying (attempt 1): Rate limited — Slow down")
  })
})

describe("treeError", () => {
  test("the session's own error, with label and detail", () => {
    const status = [{ id: "a", state: "error", detail: "You exceeded your current quota", errorType: "provider.quota", errorStatus: 429 }]
    expect(treeError(status, "a")).toEqual({ sessionID: "a", label: "Quota exceeded", message: "You exceeded your current quota", status: "HTTP 429", text: "Quota exceeded (HTTP 429): You exceeded your current quota" })
  })
  test("an unknown type falls back to the message", () => {
    expect(treeError([{ id: "a", state: "error", detail: "Boom" }], "a")).toMatchObject({ label: "Boom", text: "Boom" })
    expect(treeError([{ id: "a", state: "error" }], "a")).toMatchObject({ label: "Error", text: "Error" })
  })
  test("a subagent's error shows while the session itself is not running", () => {
    const status = [
      { id: "a", state: "idle" },
      { id: "kid", parentID: "a", title: "Research", state: "error", detail: "bad key", errorType: "provider.auth" },
    ]
    expect(treeError(status, "a")).toMatchObject({ sessionID: "kid", label: "Authentication failed", message: "bad key", title: "Research" })
    expect(treeError([{ ...status[0]!, state: "working" }, status[1]!], "a")).toBeUndefined()
  })
  test("nothing once a new run starts or without errors", () => {
    expect(treeError([{ id: "a", state: "working" }], "a")).toBeUndefined()
    expect(treeError([{ id: "a", state: "idle" }], "a")).toBeUndefined()
    expect(treeError(undefined, "a")).toBeUndefined()
    expect(treeError("junk", "a")).toBeUndefined()
  })
  test("without a session ID, the root (first entry) is the session", () => {
    expect(treeError([{ id: "r", state: "error", detail: "x" }])).toMatchObject({ sessionID: "r" })
  })
})
