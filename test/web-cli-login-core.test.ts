// The console's CLI login approval (/approve?code=…, web/src/app/Entry.tsx): the pending login from
// GET /api/cli-logins/:code, what each scope means, which are ticked first, and the approve body.
import { describe, expect, test } from "bun:test"
import { APP_TOKEN_SCOPES, cliLoginApproveBody, cliLoginChoices, parseCliLogin, SCOPE_LABELS } from "../web/src/core/agents-core"

const RAW = { login: { userCode: "BCDF-GHJK", clientName: "dev box", scopes: ["sessions:read", "messages:send", "sessions:launch"], created: 1, expiresAt: 2 } }

describe("CLI login approval", () => {
  test("parses the pending login; anything else is undefined", () => {
    expect(parseCliLogin(RAW)).toEqual(RAW.login)
    expect(parseCliLogin({})).toBeUndefined()
    expect(parseCliLogin({ login: { ...RAW.login, scopes: "sessions:read" } })).toBeUndefined()
    expect(parseCliLogin({ login: { ...RAW.login, clientName: 3 } })).toBeUndefined()
    // Unknown scopes are dropped, never shown as choices.
    expect(parseCliLogin({ login: { ...RAW.login, scopes: ["sessions:read", "root"] } })!.scopes).toEqual(["sessions:read"])
  })

  test("every scope has a plain label; launch says it also needs a grant", () => {
    for (const scope of APP_TOKEN_SCOPES) expect(SCOPE_LABELS[scope]).toBeTruthy()
    expect(SCOPE_LABELS["sessions:launch"]).toContain("grant")
  })

  test("the choices: every scope, the requested ones ticked, the requested launch flagged", () => {
    const choices = cliLoginChoices(parseCliLogin(RAW)!)
    expect(choices.map((c) => c.scope)).toEqual([...APP_TOKEN_SCOPES])
    expect(choices.filter((c) => c.checked).map((c) => c.scope)).toEqual(["sessions:read", "messages:send", "sessions:launch"])
    expect(choices.find((c) => c.scope === "sessions:launch")).toMatchObject({ requested: true, checked: true })
    expect(choices.find((c) => c.scope === "sessions:act")).toMatchObject({ requested: false, checked: false })
  })

  test("the approve body: the ticked scopes, at least one", () => {
    expect(cliLoginApproveBody(["sessions:read", "sessions:launch", "sessions:read"])).toEqual({ ok: true, body: { scopes: ["sessions:read", "sessions:launch"] } })
    expect(cliLoginApproveBody([])).toEqual({ ok: false, error: "Pick at least one scope" })
    expect(cliLoginApproveBody(["root"])).toEqual({ ok: false, error: "Unknown scope: root" })
  })
})
