// The launch spec (design §6.1, §6.4; decision znbg8xa5): POST /api/agent/launches bodies are validated into a
// LaunchSpec with defaults filled in; anything malformed is AgentError invalid. Git-facing fields (branch, base,
// remote, repo) are checked strictly because the node passes them to git (argv only, never a shell).
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import {
  LABELS_MAX,
  LABEL_KEY_MAX,
  LABEL_VALUE_MAX,
  PROMPT_MAX,
  launchBodyKey,
  validBranch,
  validRemote,
  validateLaunchSpec,
} from "../src/central/agent/launch-spec"

const MIN = { workspace: { repo: "/Users/huy/projects/hub", branch: "feat/x" } }

function invalid(input: unknown): AgentError {
  try {
    validateLaunchSpec(input)
  } catch (cause) {
    expect(cause).toBeInstanceOf(AgentError)
    expect((cause as AgentError).code).toBe("invalid")
    return cause as AgentError
  }
  throw new Error(`accepted: ${JSON.stringify(input)}`)
}

const withWorkspace = (workspace: Record<string, unknown>) => ({ workspace: { ...MIN.workspace, ...workspace } })

describe("validateLaunchSpec: defaults", () => {
  test("a minimal body gets the defaults", () => {
    expect(validateLaunchSpec(MIN)).toEqual({
      roles: [],
      harness: "opencode",
      workspace: { repo: "/Users/huy/projects/hub", mode: "worktree", branch: "feat/x" },
      runtime: { kind: "host" },
      placement: { labels: {}, mode: "require" },
      labels: {},
      end: { when: "idle", cleanup: "keep" },
    })
  })

  test("a full body is kept (repo canonicalised, timeout in ms, roles deduplicated)", () => {
    const spec = validateLaunchSpec({
      key: "brain:task:abc-1",
      name: "api-refactor",
      roles: ["reviewer.hub", "reviewer.hub", "tester"],
      harness: "opencode",
      agent: "build",
      model: "anthropic/claude-sonnet-4-5",
      workspace: { repo: "/Users/huy/projects/./hub/", mode: "clone", branch: "feat/x", base: "main", remote: "git@github.com:huynle/hub.git" },
      runtime: { kind: "openshell", profile: "untrusted-code" },
      placement: { labels: { os: "darwin" }, machine: "mbp", mode: "prefer" },
      prompt: "Refactor the API",
      labels: { app: "brain", "brain.task": "abc" },
      end: { when: "asked", timeout: "4h", cleanup: "remove" },
    })
    expect(spec).toEqual({
      key: "brain:task:abc-1",
      name: "api-refactor",
      roles: ["reviewer.hub", "tester"],
      harness: "opencode",
      agent: "build",
      model: "anthropic/claude-sonnet-4-5",
      workspace: { repo: "/Users/huy/projects/hub", mode: "clone", branch: "feat/x", base: "main", remote: "git@github.com:huynle/hub.git" },
      runtime: { kind: "openshell", profile: "untrusted-code" },
      placement: { labels: { os: "darwin" }, machine: "mbp", mode: "prefer" },
      prompt: "Refactor the API",
      labels: { app: "brain", "brain.task": "abc" },
      end: { when: "asked", timeoutMs: 4 * 3_600_000, cleanup: "remove" },
    })
  })

  test("the result is a copy (the input is never shared)", () => {
    const input = { ...MIN, labels: { a: "1" } }
    const spec = validateLaunchSpec(input)
    input.labels.a = "2"
    expect(spec.labels.a).toBe("1")
  })
})

describe("validateLaunchSpec: the body", () => {
  test("not an object", () => {
    for (const input of [null, undefined, "x", 1, []]) invalid(input)
  })

  test("unknown fields are rejected, at every level", () => {
    expect(invalid({ ...MIN, color: "red" }).message).toContain("color")
    invalid(withWorkspace({ path: "/x" }))
    invalid({ ...MIN, runtime: { kind: "host", cpu: 2 } })
    invalid({ ...MIN, placement: { zone: "a" } })
    invalid({ ...MIN, end: { when: "idle", after: 1 } })
  })

  test("grant is not supported in phase 4", () => {
    expect(invalid({ ...MIN, grant: "g_0123456789abcdef" }).message).toMatch(/grant/)
  })

  test("key: 1–200 visible characters", () => {
    expect(validateLaunchSpec({ ...MIN, key: "k" }).key).toBe("k")
    for (const key of ["", " ", "a b", "x".repeat(201), "tab\tkey", 7]) invalid({ ...MIN, key })
  })

  test("name: a valid, unreserved @name without the @", () => {
    expect(validateLaunchSpec({ ...MIN, name: "worker-1" }).name).toBe("worker-1")
    for (const name of ["me", "@worker", "Worker", "x", "a".repeat(41), ""]) invalid({ ...MIN, name })
  })

  test("roles: up to 10 role names, optionally project-scoped", () => {
    invalid({ ...MIN, roles: "reviewer" })
    invalid({ ...MIN, roles: ["@@reviewer"] })
    invalid({ ...MIN, roles: ["Bad Role"] })
    invalid({ ...MIN, roles: Array.from({ length: 11 }, (_, i) => `role-${i}`) })
  })

  test("harness, agent and model syntax", () => {
    invalid({ ...MIN, harness: "Open Code" })
    invalid({ ...MIN, agent: "" })
    invalid({ ...MIN, agent: "build agent" })
    invalid({ ...MIN, model: "no-provider" })
    invalid({ ...MIN, model: "anthropic/has space" })
    invalid({ ...MIN, model: `a/${"m".repeat(200)}` })
    expect(validateLaunchSpec({ ...MIN, model: "openrouter/google/gemini-2.5-pro" }).model).toBe("openrouter/google/gemini-2.5-pro")
  })

  test("prompt: a string of at most PROMPT_MAX characters", () => {
    expect(validateLaunchSpec({ ...MIN, prompt: "x".repeat(PROMPT_MAX) }).prompt).toHaveLength(PROMPT_MAX)
    invalid({ ...MIN, prompt: "x".repeat(PROMPT_MAX + 1) })
    invalid({ ...MIN, prompt: 3 })
    invalid({ ...MIN, prompt: "a\u0000b" })
  })

  test("labels: at most LABELS_MAX, bounded keys and string values", () => {
    const many = Object.fromEntries(Array.from({ length: LABELS_MAX }, (_, i) => [`k${i}`, "v"]))
    expect(Object.keys(validateLaunchSpec({ ...MIN, labels: many }).labels)).toHaveLength(LABELS_MAX)
    invalid({ ...MIN, labels: { ...many, extra: "v" } })
    invalid({ ...MIN, labels: { ["k".repeat(LABEL_KEY_MAX + 1)]: "v" } })
    invalid({ ...MIN, labels: { k: "v".repeat(LABEL_VALUE_MAX + 1) } })
    invalid({ ...MIN, labels: { "bad key": "v" } })
    invalid({ ...MIN, labels: { "": "v" } })
    invalid({ ...MIN, labels: { k: 1 } })
    invalid({ ...MIN, labels: { k: "line\nbreak" } })
    invalid({ ...MIN, labels: ["a=b"] })
    expect(validateLaunchSpec({ ...MIN, labels: { "brain.task": "" } }).labels).toEqual({ "brain.task": "" })
  })
})

describe("validateLaunchSpec: workspace", () => {
  test("workspace is required, with an absolute repo path", () => {
    invalid({})
    invalid({ workspace: "/x" })
    for (const repo of ["relative/path", "~/projects/hub", "/", "", "/a/../..", 5]) invalid(withWorkspace({ repo }))
  })

  test("mode: worktree (default), checkout or clone", () => {
    expect(validateLaunchSpec(withWorkspace({ mode: "checkout" })).workspace.mode).toBe("checkout")
    invalid(withWorkspace({ mode: "copy" }))
  })

  test("worktree needs a branch; checkout does not", () => {
    invalid({ workspace: { repo: "/p/hub" } })
    expect(validateLaunchSpec({ workspace: { repo: "/p/hub", mode: "checkout" } }).workspace).toEqual({ repo: "/p/hub", mode: "checkout" })
  })

  test("clone needs a remote", () => {
    invalid(withWorkspace({ mode: "clone" }))
    expect(validateLaunchSpec(withWorkspace({ mode: "clone", remote: "https://github.com/huynle/hub.git" })).workspace.remote).toBe("https://github.com/huynle/hub.git")
  })

  test("branch and base must be safe git branch names", () => {
    invalid(withWorkspace({ branch: "-x" }))
    invalid(withWorkspace({ base: "--upload-pack=evil" }))
    invalid(withWorkspace({ branch: 3 }))
  })

  test("openshell runs clone workspaces only; profiles are openshell's", () => {
    invalid({ ...withWorkspace({ mode: "worktree" }), runtime: { kind: "openshell" } })
    invalid({ ...MIN, runtime: { kind: "host", profile: "untrusted-code" } })
    invalid({ ...MIN, runtime: { kind: "k8s" } })
    invalid({ ...withWorkspace({ mode: "clone", remote: "https://h/r.git" }), runtime: { kind: "openshell", profile: "Bad Profile" } })
    expect(validateLaunchSpec({ ...withWorkspace({ mode: "clone", remote: "https://h/r.git" }), runtime: { kind: "openshell" } }).runtime).toEqual({ kind: "openshell" })
  })
})

describe("validBranch (git check-ref-format --branch)", () => {
  test("accepts ordinary branch names", () => {
    for (const name of ["main", "feat/x", "p4/t2-launch-store", "release-1.2", "user/huy/fix_1", "a"]) expect(validBranch(name)).toBe(true)
  })

  test("rejects what git rejects, and option-like names", () => {
    const bad = [
      "",
      "-x",
      "--force",
      "feat/-x",
      ".hidden",
      "feat/.x",
      "a..b",
      "a.lock",
      "feat/a.lock",
      "a/",
      "/a",
      "a//b",
      "a.",
      "@",
      "a@{1}",
      "HEAD",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "a\u0001b",
      "a\u007fb",
      "x".repeat(201),
    ]
    for (const name of bad) expect({ name, ok: validBranch(name) }).toEqual({ name, ok: false })
  })
})

describe("validRemote (https or ssh only)", () => {
  test("accepts https, ssh:// and scp-like ssh remotes", () => {
    for (const remote of [
      "https://github.com/huynle/hub.git",
      "https://gitlab.example.com:8443/group/sub/project",
      "ssh://git@github.com/huynle/hub.git",
      "ssh://git@host:2222/repo.git",
      "git@github.com:huynle/hub.git",
      "deploy@gitlab.example.com:group/project.git",
    ]) expect({ remote, ok: validRemote(remote) }).toEqual({ remote, ok: true })
  })

  test("rejects other protocols, credentials, options and odd characters", () => {
    for (const remote of [
      "",
      "http://github.com/huynle/hub.git",
      "file:///etc/passwd",
      "/local/repo",
      "../repo",
      "git://github.com/huynle/hub.git",
      "ext::sh -c touch% /tmp/pwned",
      "fd::17",
      "-oProxyCommand=evil",
      "ssh://-oProxyCommand=evil/x",
      "ssh://git@-evil/x",
      "git@-evil:x",
      "git@host:-x",
      "https://user:secret@github.com/huynle/hub.git",
      "https://token@github.com/huynle/hub.git",
      "https://github.com/a b",
      "https://github.com/a\nb",
      "https:///nohost",
      "github.com:huynle/hub.git",
      `https://github.com/${"x".repeat(500)}`,
    ]) expect({ remote, ok: validRemote(remote) }).toEqual({ remote, ok: false })
  })

  test("a bad remote is an invalid spec", () => {
    invalid(withWorkspace({ remote: "file:///etc" }))
  })
})

describe("validateLaunchSpec: runtime, placement and end", () => {
  test("placement: labels, machine and mode", () => {
    expect(validateLaunchSpec({ ...MIN, placement: { machine: "m_123" } }).placement).toEqual({ labels: {}, machine: "m_123", mode: "require" })
    invalid({ ...MIN, placement: { mode: "maybe" } })
    invalid({ ...MIN, placement: { machine: "has space" } })
    invalid({ ...MIN, placement: { labels: { "bad key": "x" } } })
    invalid({ ...MIN, placement: "mbp" })
  })

  test("end: when, timeout (1 minute–30 days) and cleanup", () => {
    expect(validateLaunchSpec({ ...MIN, end: { timeout: 600 } }).end).toEqual({ when: "idle", timeoutMs: 600_000, cleanup: "keep" })
    expect(validateLaunchSpec({ ...MIN, end: { when: "never" } }).end).toEqual({ when: "never", cleanup: "keep" })
    invalid({ ...MIN, end: { when: "done" } })
    invalid({ ...MIN, end: { timeout: "30s" } })
    invalid({ ...MIN, end: { timeout: "31d" } })
    invalid({ ...MIN, end: { timeout: "soon" } })
    invalid({ ...MIN, end: { cleanup: "force" } })
    invalid({ ...MIN, end: "idle" })
  })
})

describe("launchBodyKey: what idempotency compares", () => {
  test("equal for equivalent bodies (defaults, key order, repo spelling)", () => {
    const a = validateLaunchSpec({ key: "k", workspace: { repo: "/p/hub/", branch: "x" }, labels: { b: "2", a: "1" } })
    const b = validateLaunchSpec({ labels: { a: "1", b: "2" }, workspace: { branch: "x", repo: "/p/hub", mode: "worktree" }, harness: "opencode", key: "k" })
    expect(launchBodyKey(a)).toBe(launchBodyKey(b))
  })

  test("different for different bodies", () => {
    const a = validateLaunchSpec({ key: "k", ...MIN, prompt: "one" })
    const b = validateLaunchSpec({ key: "k", ...MIN, prompt: "two" })
    expect(launchBodyKey(a)).not.toBe(launchBodyKey(b))
  })
})
