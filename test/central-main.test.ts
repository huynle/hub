// Hub command line: --version and --help answer without starting anything; unknown flags are refused.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import { centralConfig } from "../src/central/config"
import { authStartupLines, hubHelp, parseHubArgs, runImport, runMigrate, shutdownHub, shutdownOnSignals } from "../src/central/main"
import { HUB_ROWS } from "../src/central/store"
import { fixtureStateDir, TOKEN_KEYS } from "./import-fixture"

describe("parseHubArgs", () => {
  test("no arguments runs the hub", () => {
    expect(parseHubArgs([])).toEqual({ action: "run" })
  })

  test("--version / -v and --help / -h", () => {
    expect(parseHubArgs(["--version"])).toEqual({ action: "version" })
    expect(parseHubArgs(["-v"])).toEqual({ action: "version" })
    expect(parseHubArgs(["--help"])).toEqual({ action: "help" })
    expect(parseHubArgs(["-h"])).toEqual({ action: "help" })
  })

  test("migrate, and import --state <dir> [--dry-run] [--force] [--print-token-keys]", () => {
    expect(parseHubArgs(["migrate"])).toEqual({ action: "migrate" })
    expect(parseHubArgs(["import", "--state", "/srv/hub"])).toEqual({ action: "import", stateDir: "/srv/hub", dryRun: false, force: false, printTokenKeys: false })
    expect(parseHubArgs(["import", "--dry-run", "--state=/srv/hub", "--force", "--print-token-keys"])).toEqual({
      action: "import",
      stateDir: "/srv/hub",
      dryRun: true,
      force: true,
      printTokenKeys: true,
    })
  })

  test("import without --state, with an unknown flag, or migrate with arguments is an error", () => {
    for (const argv of [["import"], ["import", "--state"], ["import", "--state", "/a", "--wat"], ["migrate", "--force"], ["import", "--state", "/a", "--state", "/b"]]) {
      const result = parseHubArgs(argv)
      expect({ argv, action: result.action }).toEqual({ argv, action: "error" })
    }
    expect((parseHubArgs(["import"]) as { message: string }).message).toContain("--state")
  })

  test("anything else is an error that points at --help", () => {
    const result = parseHubArgs(["--port", "1"])
    expect(result.action).toBe("error")
    expect((result as { message: string }).message).toContain("--port")
    expect((result as { message: string }).message).toContain("--help")
  })
})

describe("hubHelp", () => {
  test("names the version, the config file and the main env vars", () => {
    const help = hubHelp("1.2.3")
    expect(help).toContain("hub-server 1.2.3")
    for (const word of ["HUB_PORT", "HUB_HOST", "HUB_PUBLIC_URL", "HUB_STATE_DIR", "OPENROUTER_API_KEY", "hub.json", "--version", "migrate", "import --state", "--dry-run", "--force", "--print-token-keys", "HUB_DATABASE_URL"]) {
      expect(help).toContain(word)
    }
  })
})

describe("multi-user (oidc) startup", () => {
  test("help lists the sign-in settings", () => {
    const help = hubHelp("1.2.3")
    for (const word of ["HUB_AUTH", "HUB_OIDC_CLIENT_ID", "HUB_OIDC_CLIENT_SECRET", "HUB_OIDC_ALLOWED", "HUB_ADMIN_EMAILS", "/auth/callback"]) {
      expect(help).toContain(word)
    }
  })

  test("authStartupLines: pairing says nothing; oidc names issuer, redirect URI and counts, never the secret", () => {
    const base = { HUB_PORT: "4097", HUB_PUBLIC_URL: "https://voice.example.com" }
    expect(authStartupLines(centralConfig(base, "/home/user"))).toEqual({ info: [], warnings: [] })
    const oidc = centralConfig(
      {
        ...base,
        HUB_AUTH: "oidc",
        HUB_OIDC_CLIENT_ID: "client-123",
        HUB_OIDC_CLIENT_SECRET: "s3cret-value",
        HUB_OIDC_ALLOWED: "alice@example.com,@example.org",
        HUB_ADMIN_EMAILS: "admin@example.com",
      },
      "/home/user",
    )
    const lines = authStartupLines(oidc)
    const text = [...lines.info, ...lines.warnings].join("\n")
    expect(text).toContain("https://accounts.google.com")
    expect(text).toContain("https://voice.example.com/auth/callback")
    expect(text).toMatch(/2 allow-list entries, 1 admin/)
    expect(text).not.toContain("s3cret-value")
    expect(lines.warnings).toEqual([])
  })

  test("authStartupLines warns about a plain-http public URL and the dev-only insecure issuer", () => {
    const config = centralConfig(
      {
        HUB_PUBLIC_URL: "http://voice.example.com",
        HUB_AUTH: "oidc",
        HUB_OIDC_ISSUER: "http://127.0.0.1:5555",
        HUB_OIDC_INSECURE_ISSUER: "1",
        HUB_OIDC_CLIENT_ID: "c",
        HUB_OIDC_CLIENT_SECRET: "s",
        HUB_OIDC_ALLOWED: "a@example.com",
        HUB_ADMIN_EMAILS: "a@example.com",
      },
      "/home/user",
    )
    const { warnings } = authStartupLines(config)
    expect(warnings.join("\n")).toMatch(/https/)
    expect(warnings.join("\n")).toMatch(/HUB_OIDC_INSECURE_ISSUER/)
  })
})

describe("shutdownHub", () => {
  const fake = () => {
    const calls: string[] = []
    return {
      calls,
      central: {
        drain: async () => void calls.push("drain"),
        stop: async () => void calls.push("stop"),
      },
    }
  }

  test("SIGTERM (a pod being replaced) drains, then stops", async () => {
    const { calls, central } = fake()
    const lines: string[] = []
    await shutdownHub(central, "SIGTERM", (line) => lines.push(line))
    expect(calls).toEqual(["drain", "stop"])
    expect(lines.join("\n")).toContain("draining")
  })

  test("SIGINT (Ctrl-C) stops at once", async () => {
    const { calls, central } = fake()
    await shutdownHub(central, "SIGINT", () => {})
    expect(calls).toEqual(["stop"])
  })

  test("a failed drain still stops", async () => {
    const calls: string[] = []
    const central = { drain: async () => Promise.reject(new Error("bus down")), stop: async () => void calls.push("stop") }
    const lines: string[] = []
    await shutdownHub(central, "SIGTERM", (line) => lines.push(line))
    expect(calls).toEqual(["stop"])
    expect(lines.join("\n")).toContain("bus down")
  })
})

describe("shutdownOnSignals", () => {
  test("a second signal during a drain stops at once instead of waiting for it", async () => {
    const calls: string[] = []
    let finishDrain!: () => void
    const central = {
      drain: () => new Promise<void>((resolve) => (finishDrain = () => (calls.push("drained"), resolve()))),
      stop: async () => void calls.push("stop"),
    }
    const exits: number[] = []
    const lines: string[] = []
    const onSignal = shutdownOnSignals(central, { log: (line) => lines.push(line), exit: (code) => void exits.push(code) })
    const first = onSignal("SIGTERM")
    await Bun.sleep(1)
    expect(calls).toEqual([])
    await onSignal("SIGINT")
    expect(calls).toEqual(["stop"])
    expect(exits).toEqual([1])
    expect(lines.join("\n")).toMatch(/SIGINT again: stopping now/)
    // A third signal does nothing more; the drain ending later does not stop or exit again.
    await onSignal("SIGTERM")
    finishDrain()
    await first
    expect(calls).toEqual(["stop", "drained"])
    expect(exits).toEqual([1])
  })

  test("one signal shuts down normally and exits 0", async () => {
    const calls: string[] = []
    const exits: number[] = []
    const onSignal = shutdownOnSignals({ drain: async () => void calls.push("drain"), stop: async () => void calls.push("stop") }, { log: () => {}, exit: (code) => void exits.push(code) })
    await onSignal("SIGTERM")
    expect(calls).toEqual(["drain", "stop"])
    expect(exits).toEqual([0])
  })
})

const DB_URL = "postgres://hub:s3cretPW@db.internal:5432/hub"

function io(env: Record<string, string | undefined> = { HUB_DATABASE_URL: DB_URL }) {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { env, home: "/nonexistent-home", out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }
}

const noSecrets = (text: string) => {
  for (const secret of ["s3cretPW", "db.internal", DB_URL]) expect(text).not.toContain(secret)
}

describe("runMigrate", () => {
  test("applies the schema with HUB_DATABASE_URL and prints the versions, never the URL", async () => {
    const { out, err, io: base } = io()
    const urls: string[] = []
    const code = await runMigrate({ ...base, migrate: async (url) => (urls.push(url), { applied: [1], version: 1 }) })
    expect(code).toBe(0)
    expect(urls).toEqual([DB_URL])
    expect(out.join("\n")).toMatch(/applied 1.*version 1/)
    noSecrets([...out, ...err].join("\n"))
    const again = io()
    expect(await runMigrate({ ...again.io, migrate: async () => ({ applied: [], version: 1 }) })).toBe(0)
    expect(again.out.join("\n")).toMatch(/up to date.*version 1/)
  })

  test("without a database URL, with a non-postgres one, or when it fails: exit 1 and a message without the URL", async () => {
    const missing = io({})
    expect(await runMigrate({ ...missing.io, migrate: async () => ({ applied: [], version: 1 }) })).toBe(1)
    expect(missing.err.join("\n")).toContain("HUB_DATABASE_URL")
    const wrong = io({ HUB_DATABASE_URL: "redis://:s3cretPW@db.internal" })
    expect(await runMigrate({ ...wrong.io, migrate: async () => ({ applied: [], version: 1 }) })).toBe(1)
    noSecrets(wrong.err.join("\n"))
    const failing = io()
    expect(await runMigrate({ ...failing.io, migrate: async () => Promise.reject(new Error(`connect failed to ${DB_URL} (db.internal)`)) })).toBe(1)
    expect(failing.err.join("\n")).toContain("connect failed")
    noSecrets(failing.err.join("\n"))
  })
})

describe("runImport", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const fixture = async () => {
    const dir = await fixtureStateDir()
    dirs.push(dir)
    return dir
  }

  test("imports into the database and prints the report; the token keys only with --print-token-keys, alone on stdout", async () => {
    const dir = await fixture()
    const state = new MemoryStateStore()
    let closed = 0
    const openState = (url: string) => {
      expect(url).toBe(DB_URL)
      return Object.assign(state, { close: async () => void closed++ })
    }
    const plain = io()
    expect(await runImport({ stateDir: dir, dryRun: false, force: false, printTokenKeys: false }, { ...plain.io, openState })).toBe(0)
    expect(plain.out.join("\n")).toMatch(/users\s+3\s+3/)
    expect(plain.out.join("\n")).not.toContain(TOKEN_KEYS.keys[0]!.secret)
    noSecrets([...plain.out, ...plain.err].join("\n"))
    expect((await state.list(HUB_ROWS, "users")).length).toBe(3)
    expect(closed).toBe(1)

    const keys = io()
    expect(await runImport({ stateDir: dir, dryRun: true, force: false, printTokenKeys: true }, { ...keys.io, openState })).toBe(0)
    expect(keys.out).toHaveLength(1)
    expect(JSON.parse(keys.out[0]!)).toEqual(TOKEN_KEYS)
    expect(keys.err.join("\n")).toMatch(/users\s+3\s+0\s+3/)
  })

  test("failed rows, a missing directory or a database error exit 1 (never naming the URL)", async () => {
    const dir = await fixture()
    const failing = Object.assign(new MemoryStateStore(), { close: async () => {} })
    const put = failing.put.bind(failing)
    failing.put = (async (user: string, collection: string, key: string, value: unknown, options?: object) => (key === "m_1" ? Promise.reject(new Error("bad row")) : put(user, collection, key, value, options))) as never
    const partial = io()
    expect(await runImport({ stateDir: dir, dryRun: false, force: false, printTokenKeys: false }, { ...partial.io, openState: () => failing })).toBe(1)
    expect(partial.out.join("\n")).toContain("bad row")

    const missing = io()
    expect(await runImport({ stateDir: path.join(dir, "nope"), dryRun: false, force: false, printTokenKeys: false }, { ...missing.io, openState: () => failing })).toBe(1)
    expect(missing.err.join("\n")).toContain("No hub state")

    const down = io()
    const broken = Object.assign(new MemoryStateStore(), { close: async () => {}, get: async () => Promise.reject(new Error(`cannot reach ${DB_URL}`)) })
    expect(await runImport({ stateDir: dir, dryRun: false, force: false, printTokenKeys: false }, { ...down.io, openState: () => broken })).toBe(1)
    noSecrets([...down.out, ...down.err].join("\n"))
  })

  test("an unreachable or outdated database fails once, before any row (one line, no report)", async () => {
    const dir = await fixture()
    const unreachable = Object.assign(new MemoryStateStore(), { close: async () => {}, ping: async () => Promise.reject(new Error("Connection closed")) })
    const run = io()
    expect(await runImport({ stateDir: dir, dryRun: true, force: false, printTokenKeys: false }, { ...run.io, openState: () => unreachable })).toBe(1)
    expect(run.out).toEqual([])
    expect(run.err).toEqual(["[hub] import failed: Connection closed"])
  })

  test("HUB_DATABASE_URL falls back to hub.json cluster.database", async () => {
    const dir = await fixture()
    const home = mkdtempSync(path.join(tmpdir(), "hub-home-"))
    dirs.push(home)
    const config = path.join(home, "hub.json")
    writeFileSync(config, JSON.stringify({ cluster: { database: DB_URL, valkey: "redis://v" } }))
    chmodSync(config, 0o600)
    mkdirSync(path.join(home, "unused"), { recursive: true })
    const urls: string[] = []
    const run = io({ HUB_CONFIG: config })
    const state = Object.assign(new MemoryStateStore(), { close: async () => {} })
    expect(await runImport({ stateDir: dir, dryRun: true, force: false, printTokenKeys: false }, { ...run.io, home, openState: (url) => (urls.push(url), state) })).toBe(0)
    expect(urls).toEqual([DB_URL])
  })
})
