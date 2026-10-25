// node.json `openshell.profiles` (decision lk6gn3u7 §2, §9): hub profiles for OpenShell sandboxes, normalized field
// by field like the rest of node.json. A bad field drops the field (with a problem line); a profile that asks for
// something the vm backend cannot honour (mounts, cpu, memory) is never used: launches naming it fail `unsupported`.
import { describe, expect, test } from "bun:test"
import { DEFAULT_PROFILE, normalizeOpenShellProfiles, ProfileError, profileNames, selectProfile } from "../src/profiles.ts"

describe("normalizeOpenShellProfiles", () => {
  test("keeps a full valid profile", () => {
    const { profiles, unsupported, problems } = normalizeOpenShellProfiles({
      "untrusted-code": {
        image: "ghcr.io/huynle/hub-sandbox:0.1.0",
        providers: ["anthropic", "openai-work"],
        endpoints: ["registry.npmjs.org:443", { host: "pypi.org", port: 443 }],
        allowGitRemote: true,
      },
    })
    expect(problems).toEqual([])
    expect(unsupported).toEqual({})
    expect(profiles).toEqual({
      [DEFAULT_PROFILE]: { name: DEFAULT_PROFILE, providers: [], endpoints: [], allowGitRemote: false },
      "untrusted-code": {
        name: "untrusted-code",
        image: "ghcr.io/huynle/hub-sandbox:0.1.0",
        providers: ["anthropic", "openai-work"],
        endpoints: [
          { host: "registry.npmjs.org", port: 443 },
          { host: "pypi.org", port: 443 },
        ],
        allowGitRemote: true,
      },
    })
  })

  test("an empty profile: no image, no providers, no extra endpoints, no git remote", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({ "net-off": {} })
    expect(problems).toEqual([])
    expect(profiles["net-off"]).toEqual({ name: "net-off", providers: [], endpoints: [], allowGitRemote: false })
  })

  test("missing section: only the built-in default profile", () => {
    const { profiles, unsupported, problems } = normalizeOpenShellProfiles(undefined)
    expect(problems).toEqual([])
    expect(unsupported).toEqual({})
    expect(profiles).toEqual({ [DEFAULT_PROFILE]: { name: DEFAULT_PROFILE, providers: [], endpoints: [], allowGitRemote: false } })
  })

  test("a configured default replaces the built-in one", () => {
    const { profiles } = normalizeOpenShellProfiles({ default: { providers: ["anthropic"] } })
    expect(profiles.default).toEqual({ name: "default", providers: ["anthropic"], endpoints: [], allowGitRemote: false })
  })

  test("not an object: a problem and only the default", () => {
    const { profiles, problems } = normalizeOpenShellProfiles(["x"])
    expect(problems).toEqual(["openshell.profiles must be an object of profile name to profile"])
    expect(Object.keys(profiles)).toEqual([DEFAULT_PROFILE])
  })

  test("bad profile names and non-object profiles are dropped with a problem", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({ "Bad Name": {}, "-x": {}, ok: 3 })
    expect(Object.keys(profiles)).toEqual([DEFAULT_PROFILE])
    expect(problems).toEqual([
      'openshell.profiles: "Bad Name" is not a profile name (lowercase letters, digits, . _ -; at most 64)',
      'openshell.profiles: "-x" is not a profile name (lowercase letters, digits, . _ -; at most 64)',
      "openshell.profiles.ok must be an object",
    ])
  })

  test("bad fields are dropped field by field", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({
      p: {
        image: "--privileged",
        providers: ["good", "Bad!", 7],
        endpoints: ["no-port.example.com", "ok.example.com:443", "x.example.com:0", "x.example.com:70000", { host: "-bad", port: 443 }, "a b:1"],
        allowGitRemote: "yes",
      },
    })
    expect(profiles.p).toEqual({ name: "p", providers: ["good"], endpoints: [{ host: "ok.example.com", port: 443 }], allowGitRemote: false })
    expect(problems).toEqual([
      'openshell.profiles.p.image: "--privileged" is not an image reference',
      'openshell.profiles.p.providers: "Bad!" is not a provider name',
      "openshell.profiles.p.providers: 7 is not a provider name",
      'openshell.profiles.p.endpoints: "no-port.example.com" is not host:port',
      'openshell.profiles.p.endpoints: "x.example.com:0" is not host:port',
      'openshell.profiles.p.endpoints: "x.example.com:70000" is not host:port',
      'openshell.profiles.p.endpoints: {"host":"-bad","port":443} is not host:port',
      'openshell.profiles.p.endpoints: "a b:1" is not host:port',
      "openshell.profiles.p.allowGitRemote must be true or false",
    ])
  })

  test("providers and endpoints must be lists", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({ p: { providers: "anthropic", endpoints: "x.example.com:443" } })
    expect(profiles.p).toEqual({ name: "p", providers: [], endpoints: [], allowGitRemote: false })
    expect(problems).toEqual(["openshell.profiles.p.providers must be a list of provider names", "openshell.profiles.p.endpoints must be a list of host:port"])
  })

  test("hosts are lowercased; duplicates are dropped", () => {
    const { profiles } = normalizeOpenShellProfiles({
      p: { providers: ["a", "a"], endpoints: ["API.Example.com:443", "api.example.com:443", "api.example.com:8443"] },
    })
    expect(profiles.p?.providers).toEqual(["a"])
    expect(profiles.p?.endpoints).toEqual([
      { host: "api.example.com", port: 443 },
      { host: "api.example.com", port: 8443 },
    ])
  })

  test("wildcard hosts follow OpenShell's rules (at least three labels, * or ** first)", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({ p: { endpoints: ["*.example.com:443", "**.example.com:443", "*.com:443", "a.*.com:443"] } })
    expect(profiles.p?.endpoints).toEqual([
      { host: "*.example.com", port: 443 },
      { host: "**.example.com", port: 443 },
    ])
    expect(problems).toEqual(['openshell.profiles.p.endpoints: "*.com:443" is not host:port', 'openshell.profiles.p.endpoints: "a.*.com:443" is not host:port'])
  })

  test("unknown fields are a problem but keep the profile", () => {
    const { profiles, problems } = normalizeOpenShellProfiles({ p: { colour: "red" } })
    expect(profiles.p).toBeDefined()
    expect(problems).toEqual(['openshell.profiles.p: unknown field "colour" ignored'])
  })

  test("mounts, cpu and memory make the profile unsupported (vm backend), never silently weaker", () => {
    const { profiles, unsupported, problems } = normalizeOpenShellProfiles({
      a: { mounts: [{ host: "/x", sandbox: "/y" }] },
      b: { cpu: 2 },
      c: { memoryMB: 4096, cpu: 1 },
      d: { providers: ["x"] },
    })
    expect(Object.keys(profiles).sort()).toEqual(["d", DEFAULT_PROFILE])
    expect(unsupported).toEqual({
      a: "profile a sets mounts, which the OpenShell vm backend does not support",
      b: "profile b sets cpu, which the OpenShell vm backend does not support",
      c: "profile c sets cpu, memoryMB, which the OpenShell vm backend does not support",
    })
    expect(problems).toEqual([
      "openshell.profiles.a: unsupported (profile a sets mounts, which the OpenShell vm backend does not support)",
      "openshell.profiles.b: unsupported (profile b sets cpu, which the OpenShell vm backend does not support)",
      "openshell.profiles.c: unsupported (profile c sets cpu, memoryMB, which the OpenShell vm backend does not support)",
    ])
  })

  test("at most 32 profiles; the rest are ignored", () => {
    const raw = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, {}]))
    const { profiles, problems } = normalizeOpenShellProfiles(raw)
    expect(Object.keys(profiles).length).toBe(32 + 1)
    expect(problems).toEqual(["openshell.profiles: at most 32 profiles; the rest are ignored"])
  })

  test("at most 64 extra endpoints per profile", () => {
    const endpoints = Array.from({ length: 70 }, (_, i) => `h${i}.example.com:443`)
    const { profiles, problems } = normalizeOpenShellProfiles({ p: { endpoints } })
    expect(profiles.p?.endpoints.length).toBe(64)
    expect(problems).toEqual(["openshell.profiles.p.endpoints: at most 64 endpoints; the rest are ignored"])
  })
})

describe("selectProfile", () => {
  const set = normalizeOpenShellProfiles({ "untrusted-code": { providers: ["anthropic"] }, big: { cpu: 4 } })

  test("returns the named profile", () => {
    expect(selectProfile(set, "untrusted-code").providers).toEqual(["anthropic"])
  })

  test("no name: the default profile", () => {
    expect(selectProfile(set, undefined).name).toBe(DEFAULT_PROFILE)
  })

  test("an unsupported profile throws unsupported with the reason", () => {
    let error: unknown
    try {
      selectProfile(set, "big")
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ProfileError)
    expect((error as ProfileError).code).toBe("unsupported")
    expect((error as ProfileError).message).toBe("profile big sets cpu, which the OpenShell vm backend does not support")
  })

  test("an unknown profile throws not_found", () => {
    let error: unknown
    try {
      selectProfile(set, "nope")
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ProfileError)
    expect((error as ProfileError).code).toBe("not_found")
    expect((error as ProfileError).message).toBe("this node has no OpenShell profile nope")
  })
})

describe("profileNames", () => {
  test("usable profiles, sorted (what the node's hello reports)", () => {
    expect(profileNames(normalizeOpenShellProfiles({ "net-off": {}, "untrusted-code": {}, big: { cpu: 1 } }))).toEqual(["default", "net-off", "untrusted-code"])
  })
})
