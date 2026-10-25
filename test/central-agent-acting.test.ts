// The acting engine (design §5, §7, §11.4; decision wvqeuis0; exploration hcw63slg): approve, deny, answer,
// prompt and stop for users (always) and for sessions/apps under a grant, in the check order tenancy → kill switch
// → grant → self-tree → hub never → grant never → allow (else needs_user) → hourly cap → kill switch again →
// spoke. Every outcome is in the agent audit. Fakes record every call.
import { describe, expect, test } from "bun:test"
import { Acting, type ActingDeps, type Escalation } from "../src/central/agent/acting"
import type { AgentActor } from "../src/central/agent/actor"
import type { AuditInput } from "../src/central/agent/audit"
import { AgentError } from "../src/central/agent/errors"
import type { Grant } from "../src/central/agent/grants"
import { parsePattern, type Pattern } from "../src/central/agent/policy"
import type { PermissionRequest } from "../src/status"

const USER = "u1"
const PROJECT = "/work/hub"

interface FakeSession {
  tenant: string
  directory: string
  root: string
  parentID?: string
  name?: string
}

const user: AgentActor = { kind: "user", userID: USER, deviceID: "dev_1", via: "cookie" }
const orchestrator: AgentActor = { kind: "session", userID: USER, machineID: "m1", sessionID: "ses_orch", via: "act" }
const app: AgentActor = { kind: "app", userID: USER, tokenID: "0123456789abcdef", scopes: ["sessions:act"] }

function grant(extra: Partial<Grant> = {}): Grant {
  return {
    id: "g_0000000000000001",
    owner: USER,
    holder: "@@orchestrator",
    scope: { projects: [PROJECT] },
    allow: ["approve", "deny", "answer", "prompt", "stop"],
    permissions: { allow: ["read", "shell:bun test*"], never: ["shell:git push*"] },
    allowAlways: false,
    maxActionsPerHour: 60,
    created: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...extra,
  }
}

function setup(options: {
  grants?: Grant[]
  hubNever?: string[]
  request?: PermissionRequest | null
  paused?: (call: number) => boolean
  cap?: number
  answered?: "done" | "gone"
  features?: string[]
  escalate?: ActingDeps["escalate"]
} = {}) {
  const sessions = new Map<string, FakeSession>([
    ["ses_target", { tenant: USER, directory: `${PROJECT}/sub`, root: "ses_target", name: "worker" }],
    ["ses_child", { tenant: USER, directory: `${PROJECT}/sub`, root: "ses_target", parentID: "ses_target" }],
    ["ses_orch", { tenant: USER, directory: PROJECT, root: "ses_orch", name: "orch" }],
    ["ses_orch_child", { tenant: USER, directory: PROJECT, root: "ses_orch", parentID: "ses_orch" }],
    ["ses_other", { tenant: "u2", directory: PROJECT, root: "ses_other" }],
    ["ses_outside", { tenant: USER, directory: "/elsewhere", root: "ses_outside" }],
  ])
  const request: PermissionRequest | undefined =
    options.request === null ? undefined : (options.request ?? { action: "shell", resources: ["bun test"], save: ["bun test *"] })
  /** requestID → the session that asked. */
  const permissions = new Map<string, string>([
    ["per_1", "ses_child"],
    ["per_own", "ses_orch_child"],
    ["per_alien", "ses_other"],
    ["per_out", "ses_outside"],
  ])
  const forms = new Map<string, string>([
    ["form_1", "ses_child"],
    ["form_own", "ses_orch_child"],
  ])
  const calls: any[] = []
  const audits: AuditInput[] = []
  const consumed: string[] = []
  const escalations: Escalation[] = []
  let ensures = 0
  const features = new Set(options.features ?? ["deliver", "hubPrompt", "permissionMessage"])
  const deps: ActingDeps = {
    registry: {
      sessionTenant: (id) => sessions.get(id)?.tenant,
      session: (id) => {
        const s = sessions.get(id)
        return s ? ({ id, directory: s.directory, ...(s.parentID ? { parentID: s.parentID } : {}) } as any) : undefined
      },
      rootOf: (id) => sessions.get(id)?.root,
      permissionRequest: (id) => {
        const sessionID = permissions.get(id)
        return sessionID ? { sessionID, ...(request ? { request } : {}) } : undefined
      },
      permissionTargets: (rootID, id) => (permissions.has(id) && sessions.get(permissions.get(id)!)!.root === rootID ? [{ connID: "c1", sessionID: permissions.get(id)! }] : []),
      formTargets: (rootID, id) => (forms.has(id) && sessions.get(forms.get(id)!)!.root === rootID ? [{ connID: "c1", sessionID: forms.get(id)! }] : []),
      owner: (id) => (sessions.has(id) ? "c1" : undefined),
      supports: (_connID, feature) => features.has(feature),
    },
    directory: {
      resolveOne: (userID, addr) => {
        const id = addr.startsWith("@") ? [...sessions].find(([, s]) => `@${s.name}` === addr)?.[0] : addr
        const s = id ? sessions.get(id) : undefined
        if (!id || !s || s.tenant !== userID) throw new AgentError("not_found", `No session ${addr}`)
        return { sessionID: id, ...(s.name ? { name: s.name } : {}), ...(s.parentID ? { parentID: s.parentID } : {}), online: true, roles: [] } as any
      },
    },
    actions: {
      answerPermission: async (input) => (calls.push({ op: "permission", ...input }), { outcome: options.answered ?? "done" }),
      answerForm: async (input) => (calls.push({ op: "form", ...input }), { outcome: options.answered ?? "done" }),
      prompt: async (input) => (calls.push({ op: "prompt", ...input }), { outcome: "done", mode: "steer", inboxID: "inb_1" }),
      stop: async (sessionID) => (calls.push({ op: "stop", sessionID }), { outcome: "done", result: {} as any }),
    },
    spokes: {
      request: async (connID, req) => (calls.push({ connID, ...req }), { delivered: "turn", inboxID: "inb_2" }),
    },
    grants: {
      usable: async (actor, verb, target) =>
        actor.kind === "user" ? [] : (options.grants ?? [grant()]).filter((g) => g.allow.includes(verb) && target.directory.startsWith(g.scope.projects[0]!)),
      consume: async (g) => {
        consumed.push(g.id)
        if (consumed.length > (options.cap ?? 100)) throw new AgentError("rate_limited", "cap", { extra: { retryAfter: 60 } })
      },
    },
    acting: {
      ensureActing: () => {
        ensures++
        if (options.paused?.(ensures)) throw new AgentError("paused", "Agent actions are off for this user")
      },
      hubNever: () => (options.hubNever ?? []).map((t) => parsePattern(t)!) as Pattern[],
    },
    audit: { record: async (_userID, input) => (audits.push(input), { ...input, seq: audits.length, at: 0 }) },
    ...("escalate" in options
      ? options.escalate
        ? { escalate: options.escalate }
        : {}
      : { escalate: async (e: Escalation) => (escalations.push(e), { decisionID: "dec_1" }) }),
    newMessageID: () => "msg_test",
  }
  return { acting: new Acting(deps), calls, audits, consumed, escalations, ensures: () => ensures, deps }
}

const caller = (actor: AgentActor) => ({ actor, userID: actor.userID })

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof AgentError) return cause
    throw cause
  }
  throw new Error("expected an AgentError")
}

describe("approve", () => {
  test("the user approves anything pending in their tree, without a grant or kill switch check", async () => {
    const { acting, calls, audits, ensures } = setup({ paused: () => true, request: { action: "shell", resources: ["git push"] } })
    expect(await acting.approve(caller(user), "ses_target", { requestID: "per_1", always: true })).toMatchObject({ sessionID: "ses_target", requestID: "per_1", decision: "always" })
    expect(calls).toEqual([{ op: "permission", rootID: "ses_target", requestID: "per_1", decision: "always" }])
    expect(ensures()).toBe(0)
    expect(audits).toEqual([{ actor: { kind: "user" }, verb: "approve", target: { sessionID: "ses_target", requestID: "per_1" }, decision: "allow", outcome: "ok" }])
  })

  test("an agent inside its grant approves once: kill switch twice, cap consumed, audited with the grant", async () => {
    const { acting, calls, audits, consumed, ensures } = setup()
    const done = await acting.approve(caller(orchestrator), "@worker", { requestID: "per_1", why: "only tests" })
    expect(done).toMatchObject({ decision: "once", grant: "g_0000000000000001" })
    expect(calls).toEqual([{ op: "permission", rootID: "ses_target", requestID: "per_1", decision: "once" }])
    expect(consumed).toEqual(["g_0000000000000001"])
    expect(ensures()).toBe(2)
    expect(audits).toEqual([
      { actor: { kind: "session", sessionID: "ses_orch", name: "orch" }, verb: "approve", target: { sessionID: "ses_target", requestID: "per_1" }, grant: "g_0000000000000001", decision: "allow", reason: "only tests", outcome: "ok" },
    ])
  })

  test("another tenant's session or a request outside the tree is not_found; nothing runs", async () => {
    const { acting, calls } = setup()
    expect((await failure(acting.approve(caller(orchestrator), "ses_other", { requestID: "per_alien" }))).code).toBe("not_found")
    expect((await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_alien" }))).code).toBe("not_found")
    expect((await failure(acting.approve(caller(user), "ses_target", { requestID: "per_nope" }))).code).toBe("not_found")
    expect(calls).toEqual([])
  })

  test("a kill switch answers paused before any grant is looked at", async () => {
    const { acting, calls, audits, consumed } = setup({ paused: () => true })
    expect((await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("paused")
    expect(calls).toEqual([])
    expect(consumed).toEqual([])
    expect(audits[0]).toMatchObject({ verb: "approve", decision: "paused", outcome: "refused" })
  })

  test("the kill switch is checked again right before the spoke request", async () => {
    const { acting, calls, audits } = setup({ paused: (n) => n === 2 })
    expect((await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("paused")
    expect(calls).toEqual([])
    expect(audits[0]).toMatchObject({ decision: "paused", outcome: "refused" })
  })

  test("no usable grant (none, wrong verb, outside the scope) is forbidden", async () => {
    for (const [grants, addr, requestID] of [[[], "ses_target", "per_1"], [[grant({ allow: ["stop"] })], "ses_target", "per_1"], [[grant()], "ses_outside", "per_out"]] as const) {
      const { acting, audits, calls } = setup({ grants: [...grants], request: { action: "read", resources: ["/x"] } })
      expect((await failure(acting.approve(caller(orchestrator), addr, { requestID }))).code).toBe("forbidden")
      expect(audits[0]).toMatchObject({ decision: "forbidden", outcome: "refused" })
      expect(calls).toEqual([])
    }
  })

  test("a holder never answers permission requests in its own session tree", async () => {
    const { acting, calls, audits } = setup({ grants: [grant({ scope: { projects: ["/work"] } })], request: { action: "read", resources: ["/x"] } })
    const error = await failure(acting.approve(caller(orchestrator), "ses_orch", { requestID: "per_own" }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toMatch(/own session tree/)
    expect(calls).toEqual([])
    expect(audits[0]).toMatchObject({ decision: "forbidden", outcome: "refused" })
  })

  test("hub never and grant never beat allow: forbidden, nothing consumed", async () => {
    const hub = setup({ hubNever: ["shell:bun test*"] })
    expect((await failure(hub.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("forbidden")
    expect(hub.consumed).toEqual([])
    expect(hub.audits[0]!.reason).toMatch(/never/)
    const own = setup({ request: { action: "shell", resources: ["git push origin main"] }, grants: [grant({ permissions: { allow: ["shell"], never: ["shell:git push*"] } })] })
    expect((await failure(own.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("forbidden")
    expect(own.calls).toEqual([])
  })

  test("a never rule also hits the normalised shell form (whitespace, env, sudo, command, exec, nohup, time, builtin)", async () => {
    const forms = ["git  push origin", "env A=1 B=2 git push", "sudo git push", "command git push", "exec git push", "nohup git push", "time git push", "builtin git push", "FOO=1 git push", "sudo -E env X=1 nohup  git push"]
    for (const resource of forms) {
      const { acting, calls } = setup({ request: { action: "shell", resources: [resource] }, grants: [grant({ permissions: { allow: ["shell"], never: ["shell:git push*"] } })] })
      const error = await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))
      expect([resource, error.code]).toEqual([resource, "forbidden"])
      expect(calls).toEqual([])
    }
  })

  test("outside the grant: needs_user with the evaluation, escalated through the hook (T8)", async () => {
    const { acting, calls, audits, escalations, consumed } = setup({ request: { action: "shell", resources: ["rm -rf build"] } })
    const error = await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1", why: "cleanup" }))
    expect(error.code).toBe("needs_user")
    expect(error.options.extra).toMatchObject({ evaluation: { verdict: "outside", tier: "tap", grants: ["g_0000000000000001"] }, decisionID: "dec_1" })
    expect(calls).toEqual([])
    expect(consumed).toEqual([])
    expect(escalations).toHaveLength(1)
    expect(escalations[0]).toMatchObject({ userID: USER, verb: "approve", sessionID: "ses_child", rootID: "ses_target", requestID: "per_1", why: "cleanup", always: false })
    expect(audits[0]).toMatchObject({ decision: "needs_user", outcome: "escalated" })
  })

  test("without an escalate hook needs_user is refused (no Decision yet)", async () => {
    const { acting, audits } = setup({ request: { action: "edit", resources: ["src/x.ts"] }, escalate: undefined as any })
    const error = await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))
    expect(error.code).toBe("needs_user")
    expect(error.options.extra).toMatchObject({ evaluation: { tier: "confirm" } })
    expect(audits[0]).toMatchObject({ decision: "needs_user" })
  })

  test("a request without parsed details or truncated is needs_user (tap), never auto-allowed", async () => {
    const missing = setup({ request: null })
    expect((await failure(missing.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).options.extra).toMatchObject({ evaluation: { tier: "tap" } })
    const cut = setup({ request: { action: "read", resources: ["/x"], truncated: true } })
    expect((await failure(cut.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("needs_user")
    expect(cut.calls).toEqual([])
  })

  test("always needs allowAlways and save patterns inside the grant", async () => {
    const no = setup()
    expect((await failure(no.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1", always: true }))).code).toBe("needs_user")
    const yes = setup({ grants: [grant({ allowAlways: true })] })
    expect(await yes.acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1", always: true })).toMatchObject({ decision: "always" })
    expect(yes.calls[0]).toMatchObject({ decision: "always" })
  })

  test("the first grant whose policy allows is used", async () => {
    const narrow = grant({ id: "g_0000000000000002", created: 5, permissions: { allow: ["read"], never: [] } })
    const wide = grant({ id: "g_0000000000000003", created: 2 })
    const { acting, consumed } = setup({ grants: [narrow, wide] })
    expect(await acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" })).toMatchObject({ grant: "g_0000000000000003" })
    expect(consumed).toEqual(["g_0000000000000003"])
  })

  test("past the hourly cap: rate_limited, nothing runs", async () => {
    const { acting, calls, audits } = setup({ cap: 0 })
    const error = await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))
    expect(error.code).toBe("rate_limited")
    expect(calls).toEqual([])
    expect(audits[0]).toMatchObject({ decision: "rate_limited", outcome: "refused" })
  })

  test("a race (answered elsewhere first) is gone, audited as gone", async () => {
    const { acting, audits } = setup({ answered: "gone" })
    expect((await failure(acting.approve(caller(orchestrator), "ses_target", { requestID: "per_1" }))).code).toBe("gone")
    expect(audits[0]).toMatchObject({ decision: "allow", outcome: "gone" })
  })

  test("an app token acts under its own grant like a session (no session tree)", async () => {
    const { acting, calls, audits } = setup({ grants: [grant({ holder: "app:0123456789abcdef" })] })
    expect(await acting.approve(caller(app), "ses_target", { requestID: "per_1" })).toMatchObject({ decision: "once" })
    expect(calls).toHaveLength(1)
    expect(audits[0]!.actor).toEqual({ kind: "app", tokenID: "0123456789abcdef" })
  })
})
