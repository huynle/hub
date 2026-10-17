import { describe, expect, test } from "bun:test"
import { FormRelay } from "../src/tui-forms"

describe("FormRelay (TUI side of form replies its server cannot make)", () => {
  test("long-polls the server and applies every action with the TUI's client, until stopped", async () => {
    const batches = [[{ sessionID: "ses_1", formID: "frm_1", answer: { q0: "x" } }], [{ sessionID: "ses_1", formID: "frm_2", cancel: true }]]
    const applied: unknown[] = []
    const waits: number[] = []
    let relay!: FormRelay
    relay = new FormRelay({
      poll: async (waitMs) => {
        waits.push(waitMs)
        const actions = batches.shift()
        if (!actions) {
          relay.stop()
          return { actions: [] }
        }
        return { actions }
      },
      apply: async (action) => {
        applied.push(action)
        if (action.formID === "frm_1") throw new Error("already settled") // one failure does not stop the loop
      },
      waitMs: 20_000,
      retryMs: 1,
    })
    await relay.start()
    expect(applied).toEqual([
      { sessionID: "ses_1", formID: "frm_1", answer: { q0: "x" } },
      { sessionID: "ses_1", formID: "frm_2", cancel: true },
    ])
    expect(waits).toEqual([20_000, 20_000, 20_000])
  })

  test("backs off after a failed poll (old server, no spoke) and keeps going", async () => {
    let polls = 0
    const relay: FormRelay = new FormRelay({
      poll: async () => {
        if (++polls >= 3) relay.stop()
        throw new Error("unknown method")
      },
      apply: async () => {},
      retryMs: 5,
    })
    const started = Date.now()
    await relay.start()
    expect(polls).toBe(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(8)
  })

  test("ignores malformed actions", async () => {
    const applied: unknown[] = []
    const relay: FormRelay = new FormRelay({
      poll: async () => {
        relay.stop()
        return { actions: [{ formID: "frm_1" }, null, { sessionID: "ses_1", formID: "frm_2", answer: { a: "b" } }] as any }
      },
      apply: async (a) => void applied.push(a),
    })
    await relay.start()
    expect(applied).toEqual([{ sessionID: "ses_1", formID: "frm_2", answer: { a: "b" } }])
  })
})
