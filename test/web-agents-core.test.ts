// Settings → Agents in the web console (P3-T12): grants (list rows, the create/edit form and its errors), the acting
// switches, the agent audit (Activity), "Answered by" notes from live 'agent' events, escalation Decisions' details
// and an agent's recommendation on a permission blocker.
import { describe, expect, test } from "bun:test"
import {
  actingView,
  agentNotes,
  answeredNote,
  applyAgentEntry,
  auditLine,
  draftOf,
  escalationOf,
  grantBody,
  grantRow,
  hubErrorField,
  noteForBlocker,
  parseAuditEntry,
  parseAuditPage,
  parseGrant,
  parseGrants,
  recommendationText,
  type AuditEntryView,
  type GrantView,
} from "../web/src/core/agents-core"
import type { DecisionView } from "../web/src/core/decision-core"

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

const grant = (patch: Partial<GrantView> = {}): GrantView => ({
  id: "g_0123456789abcdef",
  holder: "@@orchestrator",
  scope: { projects: ["/home/u/api", "/home/u/web"] },
  allow: ["approve", "deny"],
  permissions: { allow: ["shell:bun test *"], never: ["shell:rm *"] },
  allowAlways: false,
  maxActionsPerHour: 60,
  created: T0,
  expiresAt: T0 + 8 * HOUR,
  state: "active",
  ...patch,
})

describe("grants list", () => {
  test("parseGrant keeps well-formed grants and drops anything else", () => {
    expect(parseGrant(grant())).toEqual(grant())
    expect(parseGrant({ id: "x" })).toBeUndefined()
    expect(parseGrant(null)).toBeUndefined()
    expect(parseGrant({ ...grant(), state: "weird" })).toBeUndefined()
    expect(parseGrants({ grants: [grant(), { nope: 1 }, grant({ id: "g_1111111111111111" })] }).map((g) => g.id)).toEqual(["g_0123456789abcdef", "g_1111111111111111"])
    expect(parseGrants({})).toEqual([])
  })

  test("a row shows holder, state, projects, verbs, never patterns and the expiry countdown", () => {
    const row = grantRow(grant(), T0 + 5 * MIN)
    expect(row).toMatchObject({
      holder: "@@orchestrator",
      state: "active",
      stateLabel: "Active",
      projects: "/home/u/api, /home/u/web",
      verbs: "approve, deny",
      permit: "shell:bun test *",
      never: "shell:rm *",
      expiry: "Expires in 7h 55m",
      editable: true,
    })
  })

  test("pinned holders say which session; always, the hourly cap and missing patterns are described", () => {
    const row = grantRow(grant({ holder: "@api", holderSessionID: "ses_abc", allowAlways: true, maxActionsPerHour: 5, permissions: { allow: [], never: [] } }), T0)
    expect(row.holder).toBe("@api (ses_abc)")
    expect(row.permit).toBe("")
    expect(row.never).toBe("")
    expect(row.limits).toBe("may allow always · 5 actions an hour")
    expect(grantRow(grant(), T0).limits).toBe("60 actions an hour")
  })

  test("ended grants: expired (or past their time) and revoked rows are not editable", () => {
    expect(grantRow(grant({ state: "expired" }), T0 + 9 * HOUR)).toMatchObject({ stateLabel: "Expired", expiry: "Expired", editable: false })
    // Active per the hub at load, but the countdown ran out since.
    expect(grantRow(grant(), T0 + 9 * HOUR)).toMatchObject({ state: "expired", stateLabel: "Expired", editable: false })
    expect(grantRow(grant({ state: "revoked", revokedAt: T0 + HOUR }), T0 + 2 * HOUR)).toMatchObject({ stateLabel: "Revoked", expiry: "Revoked", editable: false })
  })
})

describe("grant form", () => {
  test("a new draft has the hub's defaults", () => {
    expect(draftOf()).toEqual({ holder: "", projects: "", allow: [], permit: "", never: "", expires: "8h", maxActionsPerHour: "60", allowAlways: false })
  })

  test("an existing grant fills the draft (one project and pattern per line)", () => {
    expect(draftOf(grant())).toEqual({
      holder: "@@orchestrator",
      projects: "/home/u/api\n/home/u/web",
      allow: ["approve", "deny"],
      permit: "shell:bun test *",
      never: "shell:rm *",
      expires: "8h",
      maxActionsPerHour: "60",
      allowAlways: false,
    })
  })

  test("a valid draft becomes the hub's grant body (lines trimmed, blanks dropped)", () => {
    const result = grantBody({ ...draftOf(), holder: " @@orchestrator ", projects: "/home/u/api\n\n  /home/u/web \n", allow: ["approve", "stop"], permit: "shell:bun test *\n", never: "", expires: "2d", maxActionsPerHour: "10", allowAlways: true })
    expect(result).toEqual({
      ok: true,
      body: {
        holder: "@@orchestrator",
        scope: { projects: ["/home/u/api", "/home/u/web"] },
        allow: ["approve", "stop"],
        permissions: { allow: ["shell:bun test *"], never: [] },
        expires: "2d",
        maxActionsPerHour: 10,
        allowAlways: true,
      },
    })
  })

  test("an invalid draft names each field's problem", () => {
    const result = grantBody({ ...draftOf(), holder: "", projects: "relative/path", allow: [], expires: "soon", maxActionsPerHour: "0" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(["allow", "expires", "holder", "maxActionsPerHour", "projects"])
    expect(result.errors.projects).toContain("relative/path")
    expect(grantBody({ ...draftOf(), holder: "@@orchestrator", projects: "", allow: ["approve"] })).toMatchObject({ ok: false, errors: { projects: expect.any(String) } })
    expect(grantBody({ ...draftOf(), holder: "@@orchestrator", projects: "/a", allow: ["approve"], maxActionsPerHour: "1.5" })).toMatchObject({ ok: false, errors: { maxActionsPerHour: expect.any(String) } })
  })

  test("the hub's validation messages map to the field they are about", () => {
    expect(hubErrorField("holder is @@role, @name, ses_… or app:<token id>")).toBe("holder")
    expect(hubErrorField("A role holder must be a reserved role (orchestrator…, concierge…)")).toBe("holder")
    expect(hubErrorField("A grant's holder cannot change: revoke it and create another")).toBe("holder")
    expect(hubErrorField("No app token 0123456789abcdef")).toBe("holder")
    expect(hubErrorField("scope.projects: x is not an absolute project directory")).toBe("projects")
    expect(hubErrorField("allow: unknown verb launch")).toBe("allow")
    expect(hubErrorField("permissions.allow: x is not an action[:glob] pattern")).toBe("permit")
    expect(hubErrorField("permissions.never lists at most 100 patterns")).toBe("never")
    expect(hubErrorField("expires is 1 minute to 30 days (seconds, or 30m, 8h, 2d)")).toBe("expires")
    expect(hubErrorField("maxActionsPerHour is a whole number 1–1000")).toBe("maxActionsPerHour")
    expect(hubErrorField("At most 50 active grants per user")).toBeUndefined()
  })
})

const entry = (patch: Partial<AuditEntryView> = {}): AuditEntryView => ({
  seq: 7,
  at: T0,
  actor: { kind: "session", sessionID: "ses_orch", name: "orchestrator" },
  verb: "approve",
  target: { sessionID: "ses_a", requestID: "per_1" },
  grant: "g_0123456789abcdef",
  decision: "allow",
  outcome: "ok",
  ...patch,
})

describe("agent audit", () => {
  test("entries and pages parse; malformed entries are dropped", () => {
    expect(parseAuditEntry(entry())).toEqual(entry())
    expect(parseAuditEntry({ seq: 1 })).toBeUndefined()
    expect(parseAuditEntry({ ...entry(), actor: "x" })).toBeUndefined()
    expect(parseAuditPage({ entries: [entry(), { bad: true }, entry({ seq: 6 })], next: 6 })).toEqual({ entries: [entry(), entry({ seq: 6 })], next: 6 })
    expect(parseAuditPage({ entries: [entry()] })).toEqual({ entries: [entry()] })
    expect(parseAuditPage(null)).toEqual({ entries: [] })
  })

  test("a line says who did what to which request, under which grant, and how it went", () => {
    expect(auditLine(entry())).toEqual({ seq: 7, at: T0, who: "@orchestrator", what: "approve per_1 in ses_a", result: "done", tone: "ok", grant: "grant g_0123456789abcdef", reason: "" })
    const refused = auditLine(entry({ decision: "needs_user", outcome: "escalated", grant: undefined, reason: "outside the grant: shell:rm -rf", actor: { kind: "app", tokenID: "0123", label: "ci" } }))
    expect(refused).toMatchObject({ who: "app ci", result: "needs you · sent to you", tone: "warn", grant: "", reason: "outside the grant: shell:rm -rf" })
    expect(auditLine(entry({ decision: "forbidden", outcome: "refused" })).tone).toBe("err")
    expect(auditLine(entry({ decision: "allow", outcome: "gone" }))).toMatchObject({ result: "allowed · already answered", tone: "warn" })
    expect(auditLine(entry({ verb: "answer", target: { sessionID: "ses_a", formID: "que_2" } })).what).toBe("answer que_2 in ses_a")
    expect(auditLine(entry({ verb: "stop", target: { sessionID: "ses_a" } })).what).toBe("stop ses_a")
  })

  test("the user's own switch changes read as such", () => {
    const user = { kind: "user" } as const
    expect(auditLine(entry({ verb: "acting.pause", actor: user, target: {}, grant: undefined }))).toMatchObject({ who: "you", what: "turned agent actions off" })
    expect(auditLine(entry({ verb: "acting.resume", actor: user, target: {}, grant: undefined })).what).toBe("turned agent actions on")
  })
})

describe("answered by", () => {
  test("an agent's successful answer names the agent and its grant; the user's own says you", () => {
    expect(answeredNote(entry())).toBe("Approved by @orchestrator · grant g_0123456789abcdef")
    expect(answeredNote(entry({ verb: "deny" }))).toBe("Denied by @orchestrator · grant g_0123456789abcdef")
    expect(answeredNote(entry({ verb: "answer", target: { sessionID: "ses_a", formID: "que_1" } }))).toBe("Answered by @orchestrator · grant g_0123456789abcdef")
    expect(answeredNote(entry({ actor: { kind: "user" }, grant: undefined, reason: "Decision dec_1" }))).toBe("Approved by you")
  })

  test("attempts that did not answer anything give no note", () => {
    expect(answeredNote(entry({ decision: "needs_user", outcome: "escalated" }))).toBeUndefined()
    expect(answeredNote(entry({ outcome: "gone" }))).toBeUndefined()
    expect(answeredNote(entry({ verb: "stop", target: { sessionID: "ses_a" } }))).toBeUndefined()
  })

  test("live entries are kept newest first, once each, at most 100", () => {
    let list: AuditEntryView[] = []
    list = applyAgentEntry(list, entry({ seq: 1 }))
    list = applyAgentEntry(list, entry({ seq: 2 }))
    list = applyAgentEntry(list, entry({ seq: 1 }))
    expect(list.map((e) => e.seq)).toEqual([2, 1])
    for (let i = 3; i < 200; i++) list = applyAgentEntry(list, entry({ seq: i }))
    expect(list.length).toBe(100)
    expect(list[0]!.seq).toBe(199)
  })

  test("a blocker's note comes from the entry that answered its request or form", () => {
    const list = [entry({ seq: 3, target: { sessionID: "ses_a", formID: "que_9" }, verb: "answer" }), entry({ seq: 2 }), entry({ seq: 1, decision: "needs_user", outcome: "escalated" })]
    expect(noteForBlocker(list, "per_1")).toBe("Approved by @orchestrator · grant g_0123456789abcdef")
    expect(noteForBlocker(list, "que_9")).toBe("Answered by @orchestrator · grant g_0123456789abcdef")
    expect(noteForBlocker(list, "per_x")).toBeUndefined()
  })

  test("a session shows the recent answers in its tree (10 minutes, newest first, at most 3)", () => {
    const list = [
      entry({ seq: 9, at: T0 + 9 * MIN, target: { sessionID: "ses_kid", requestID: "per_9" } }),
      entry({ seq: 8, at: T0 + 8 * MIN, target: { sessionID: "ses_other", requestID: "per_8" } }),
      entry({ seq: 7, at: T0 + 7 * MIN, target: { sessionID: "ses_a", requestID: "per_7" }, verb: "deny" }),
      entry({ seq: 6, at: T0 + 6 * MIN, target: { sessionID: "ses_a", requestID: "per_6" }, outcome: "gone" }),
      entry({ seq: 5, at: T0 + 5 * MIN, target: { sessionID: "ses_a", requestID: "per_5" } }),
      entry({ seq: 4, at: T0 + 4 * MIN, target: { sessionID: "ses_a", requestID: "per_4" } }),
      entry({ seq: 1, at: T0 - 20 * MIN, target: { sessionID: "ses_a", requestID: "per_1" } }),
    ]
    const notes = agentNotes(list, new Set(["ses_a", "ses_kid"]), T0 + 10 * MIN)
    expect(notes.map((n) => n.key)).toEqual(["per_9", "per_7", "per_5"])
    expect(notes[1]!.text).toBe("Denied by @orchestrator · grant g_0123456789abcdef")
  })
})

describe("acting switches", () => {
  test("both on: no note; the user's off or the hub's off say what it means", () => {
    expect(actingView({ enabled: true, hubEnabled: true })).toEqual({ on: true, hubOn: true, note: "" })
    expect(actingView({ enabled: false, hubEnabled: true })).toMatchObject({ on: false, note: expect.stringContaining("cannot act for you") })
    expect(actingView({ enabled: true, hubEnabled: false })).toMatchObject({ hubOn: false, note: expect.stringContaining("admin") })
    // An older hub without hubEnabled: assume on.
    expect(actingView({ enabled: true })).toMatchObject({ hubOn: true })
  })
})

describe("escalations and recommendations", () => {
  const escalation = (patch: Partial<DecisionView> = {}): DecisionView => ({
    id: "dec_esc",
    messageID: "msg_1",
    from: { kind: "session", sessionID: "ses_orch", name: "orchestrator" },
    about: ["ses_a"],
    question: "@orchestrator asks to approve shell: bun test, bun run lint. Outside its grant: shell:bun run lint is not in permissions.allow",
    options: [
      { id: "approve", label: "Approve once" },
      { id: "deny", label: "Deny", safe: true },
    ],
    recommendation: { option: "approve", why: "only tests" },
    urgency: "high",
    tier: "confirm",
    state: "open",
    at: T0,
    expiresAt: T0 + 86_400_000,
    action: { kind: "permission", requestID: "per_1", sessionID: "ses_a" },
    ...patch,
  })

  test("an escalation shows its requester, the requested action and resources, and why it is outside the grant", () => {
    expect(escalationOf(escalation())).toEqual({
      requester: "@orchestrator",
      action: "shell",
      resources: ["bun test", "bun run lint"],
      always: false,
      reason: "shell:bun run lint is not in permissions.allow",
      requestID: "per_1",
    })
  })

  test("always requests and unknown details are handled; plain Decisions are not escalations", () => {
    const always = escalationOf(escalation({ question: "@orchestrator asks to approve always (saves shell:bun *) shell: bun test. Outside its grant: allowAlways is off" }))
    expect(always).toMatchObject({ always: true, action: "shell", resources: ["bun test"], reason: "allowAlways is off" })
    const unknown = escalationOf(escalation({ question: "@orchestrator asks to approve a permission request (details unknown). Outside its grant: no grant" }))
    expect(unknown).toMatchObject({ action: undefined, resources: [], reason: "no grant" })
    expect(escalationOf(escalation({ question: "something else" }))).toMatchObject({ requester: "@orchestrator", action: undefined, resources: [], reason: undefined })
    expect(escalationOf(escalation({ action: undefined }))).toBeUndefined()
  })

  test("a blocker's recommendation reads '@x recommends Approve: why'", () => {
    expect(recommendationText({ by: "@orchestrator", recommends: "approve", why: "only runs tests" })).toBe("@orchestrator recommends Approve: only runs tests")
    expect(recommendationText({ by: "@orchestrator", recommends: "approve" })).toBe("@orchestrator recommends Approve")
    expect(recommendationText(undefined)).toBe("")
    expect(recommendationText({ nope: 1 })).toBe("")
  })
})
