// A quota error end to end, with the real pieces in between: OpenCode 2.2.0 events → the spoke's compaction →
// the wire (parseSpokeMessage, as an older or current hub reads it) → the hub registry (status, push alerts) → the
// web's status and wording; and the session's messages → timeline rows → web transcript blocks.
import { beforeEach, describe, expect, test } from "bun:test"
import { compactActivity, FORWARDED_EVENTS, parseSpokeMessage, type Hello } from "../packages/protocol/src/index"
import { Registry, type Alert } from "../src/central/registry"
import { timelineItems } from "../src/spoke/timeline"
import { treeError } from "../web/src/core/error-core"
import { retryText } from "../web/src/core/jobs-core"
import { retryView, transcriptBlocks } from "../web/src/lib/transcript"

const hello: Hello = { t: "hello", v: 1, processID: "p1", kind: "standalone", directory: "/work", pid: 1, mode: "always", opencodeVersion: "2.2.0", pluginVersion: "0.7.3" }
const quota = { type: "provider.quota", message: "You exceeded your current quota, please check your plan and billing details.", status: 429, response: { body: '{"error":{"code":"insufficient_quota","secret":"SECRET"}}' } }
const rateLimit = { type: "provider.rate-limit", message: "Rate limit reached", status: 429, retryAfterMs: 20_000, response: { body: "SECRET" } }

let now: number
let registry: Registry
let alerts: Alert[]
let wire: string[]

/** What the OpenCode spoke does with a raw event: compact it, send it as a frame, the hub parses and observes it. */
const forward = (type: string, data: Record<string, unknown>) => {
  const compact = compactActivity({ type, data }, undefined, now)
  if (!compact) return
  const raw = JSON.stringify({ t: "event", event: compact })
  wire.push(raw)
  const parsed = parseSpokeMessage(raw)
  expect(parsed?.t).toBe("event")
  registry.observe("c1", (parsed as { event: { type: string; data: Record<string, unknown> } }).event)
}
const root = () => registry.status("ses_root")!.find((s) => s.id === "ses_root")!

beforeEach(() => {
  now = 1_800_000_000_000
  wire = []
  alerts = []
  registry = new Registry(() => now, { set: () => ({}), clear: () => {} })
  registry.connect("c1", { id: "mch_a", name: "laptop" }, hello)
  registry.setSessions("c1", [{ id: "ses_root", title: "Fix flaky CI", directory: "/work", updated: 1, owned: true }])
  registry.subscribeAlerts((a) => alerts.push(a))
})

describe("quota error end to end", () => {
  test("retry then quota failure: typed status, providerError push, web wording; no raw types or bodies on the wire", () => {
    forward("session.execution.started", { sessionID: "ses_root" })
    forward("session.retry.scheduled", { sessionID: "ses_root", assistantMessageID: "msg_a", attempt: 2, at: now + 250_000, error: rateLimit })

    const retrying = root()
    expect(retrying.state).toBe("working")
    expect(retrying.retry).toMatchObject({ attempt: 2, next: now + 250_000, errorType: "provider.rate-limit", errorStatus: 429 })
    expect(alerts.filter((a) => a.kind === "retry")).toHaveLength(1)
    expect(retryText(registry.status("ses_root"), "ses_root", now)).toContain("next in 4m 10s")

    forward("session.retry.scheduled", { sessionID: "ses_root", assistantMessageID: "msg_a", attempt: 3, at: now + 5_000, error: quota })
    expect(alerts.filter((a) => a.kind === "providerError")).toHaveLength(1)

    forward("session.execution.failed", { sessionID: "ses_root", error: quota })
    const failed = root()
    expect(failed.state).toBe("error")
    expect(failed).toMatchObject({ errorType: "provider.quota", errorStatus: 429 })
    expect(failed.detail).toContain("exceeded your current quota")
    expect(alerts.filter((a) => a.kind === "providerError")).toEqual([
      expect.objectContaining({ sessionID: "ses_root", text: expect.stringContaining("Fix flaky CI: ") }),
    ])
    // Devices with providerError off still hear about it as "failed".
    expect(alerts.filter((a) => a.kind === "failed").every((a) => a.unlessPref === "providerError")).toBe(true)

    const banner = treeError(registry.status("ses_root"), "ses_root")
    expect(banner?.text).toMatch(/^Quota exceeded \(HTTP 429\): You exceeded/)

    for (const raw of wire) {
      expect(FORWARDED_EVENTS.has(JSON.parse(raw).event.type)).toBe(true)
      expect(raw).not.toContain("SECRET")
      expect(raw).not.toContain("session.retry.scheduled")
    }

    forward("session.execution.started", { sessionID: "ses_root" })
    expect(root().state).toBe("working")
    expect(treeError(registry.status("ses_root"), "ses_root")).toBeUndefined()
  })

  test("history: a failed assistant message with no content becomes an error block; a waiting one a retry block", () => {
    const messages = [
      { id: "msg_u", type: "user", text: "fix it", time: { created: now - 10_000 } },
      { id: "msg_a", type: "assistant", content: [], error: quota, time: { created: now - 9_000, completed: now - 1_000 } },
      { id: "msg_u2", type: "user", text: "again", time: { created: now - 500 } },
      { id: "msg_b", type: "assistant", content: [], retry: { attempt: 2, at: now + 30_000, error: rateLimit }, time: { created: now - 400 } },
    ]
    const blocks = transcriptBlocks(timelineItems("ses_root", messages) as any)
    expect(blocks.map((b) => b.type)).toEqual(["user", "error", "user", "retry"])
    expect(blocks[1]).toMatchObject({ type: "error", label: "Quota exceeded", status: "HTTP 429" })
    const retry = blocks[3] as Extract<(typeof blocks)[number], { type: "retry" }>
    expect(retryView(retry, now)).toMatchObject({ waiting: true, text: expect.stringContaining("next in 30s") })
    expect(JSON.stringify(blocks)).not.toContain("SECRET")
  })
})
