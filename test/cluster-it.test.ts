// The opt-in docker harness for cluster integration tests (test/cluster-it.ts): unit tests against a fake
// docker CLI (default CI), plus one real run (start, ready, fresh database / FLUSHDB, stop) with HUB_IT_CLUSTER=1.
import { describe, expect, test } from "bun:test"
import { dockerAvailable, ItCluster, itClusterEnabled, parsePort, reapOrphans, removeContainers, type DockerExec, type ItClients } from "./cluster-it"

interface FakeDocker {
  exec: DockerExec
  calls: string[][]
  /** pg_isready exit codes, consumed in order (then 0). */
  pgReady: number[]
  imagesPresent: Set<string>
  ports: Record<string, string>
  failRun?: string
  /** `docker ps` output: name, pid label, keep label (tab separated). */
  ps?: string
}

function fakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    calls: [],
    pgReady: [],
    imagesPresent: new Set(["postgres:16", "valkey/valkey:8"]),
    ports: { "5432/tcp": "127.0.0.1:55432\n", "6379/tcp": "127.0.0.1:56379\n" },
    exec: async (args) => {
      fake.calls.push(args)
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
      switch (args[0]) {
        case "version":
          return ok("28.4.0\n")
        case "image":
          return fake.imagesPresent.has(args[2]!) ? ok("[]") : { code: 1, stdout: "", stderr: "No such image" }
        case "pull":
          fake.imagesPresent.add(args[1]!)
          return ok()
        case "run":
          if (fake.failRun && args.includes(fake.failRun)) return { code: 125, stdout: "", stderr: "boom" }
          return ok("c0ffee\n")
        case "port":
          return ok(fake.ports[args[2]!] ?? "")
        case "exec":
          return { code: fake.pgReady.shift() ?? 0, stdout: "", stderr: "" }
        case "rm":
          return ok()
        case "ps":
          return ok(fake.ps ?? "")
        default:
          return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` }
      }
    },
  }
  return fake
}

function fakeClients(overrides: Partial<ItClients> = {}) {
  const log: string[] = []
  const clients: ItClients = {
    postgresReady: async (url) => (log.push(`pg-ready ${url}`), true),
    valkeyReady: async (url) => (log.push(`valkey-ready ${url}`), true),
    createDatabase: async (url, name) => void log.push(`create ${name} via ${url}`),
    flushValkey: async (url) => void log.push(`flush ${url}`),
    ...overrides,
  }
  return { clients, log }
}

const noSleep = async () => {}
let seq = 0
const random = () => `r${++seq}`

describe("cluster-it helpers", () => {
  test("itClusterEnabled only for HUB_IT_CLUSTER=1", () => {
    expect(itClusterEnabled({ HUB_IT_CLUSTER: "1" })).toBe(true)
    expect(itClusterEnabled({})).toBe(false)
    expect(itClusterEnabled({ HUB_IT_CLUSTER: "0" })).toBe(false)
    expect(itClusterEnabled({ HUB_IT_CLUSTER: "yes" })).toBe(false)
  })

  test("parsePort reads the IPv4 loopback mapping from `docker port` output", () => {
    expect(parsePort("127.0.0.1:55001\n")).toBe(55001)
    expect(parsePort("[::1]:1234\n127.0.0.1:55002\n")).toBe(55002)
    expect(() => parsePort("")).toThrow(/port/)
    expect(() => parsePort("0.0.0.0:80\n")).toThrow(/port/)
  })

  test("dockerAvailable: true when the daemon answers, false when the CLI fails or is missing", async () => {
    expect(await dockerAvailable(fakeDocker().exec)).toBe(true)
    expect(await dockerAvailable(async () => ({ code: 1, stdout: "", stderr: "Cannot connect" }))).toBe(false)
    expect(
      await dockerAvailable(async () => {
        throw new Error("ENOENT docker")
      }),
    ).toBe(false)
  })

  test("removeContainers removes only hub-it-* names and refuses anything else", async () => {
    const fake = fakeDocker()
    await removeContainers(fake.exec, ["hub-it-postgres-a", "hub-it-valkey-b"])
    expect(fake.calls).toEqual([["rm", "-f", "-v", "hub-it-postgres-a", "hub-it-valkey-b"]])
    await expect(removeContainers(fake.exec, ["hub-it-x", "prod-db"])).rejects.toThrow(/hub-it-/)
    expect(fake.calls.length).toBe(1)
    await removeContainers(fake.exec, [])
    expect(fake.calls.length).toBe(1)
  })
})

describe("orphaned containers", () => {
  test("reapOrphans removes hub-it-* containers whose process is gone, unless kept", async () => {
    const fake = fakeDocker()
    fake.ps = ["hub-it-postgres-a\t111\t", "hub-it-valkey-b\t222\t", "hub-it-valkey-c\t333\t1", "hub-it-old-d\t\t", "prod-db\t111\t", ""].join("\n")
    const removed = await reapOrphans(fake.exec, (pid) => pid === 222)
    expect(removed).toEqual(["hub-it-postgres-a", "hub-it-old-d"])
    expect(fake.calls[0]).toEqual(["ps", "-a", "--filter", "name=hub-it-", "--format", '{{.Names}}\t{{.Label "hub-it.pid"}}\t{{.Label "hub-it.keep"}}'])
    expect(fake.calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", "-v", "hub-it-postgres-a", "hub-it-old-d"]])
  })

  test("nothing orphaned: no rm", async () => {
    const fake = fakeDocker()
    fake.ps = "hub-it-valkey-b\t222\t\n"
    expect(await reapOrphans(fake.exec, () => true)).toEqual([])
    expect(fake.calls.filter((c) => c[0] === "rm")).toEqual([])
  })

  test("containers carry the owning pid (and the keep mark with keep); the first start reaps orphans once", async () => {
    const fake = fakeDocker()
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, reap: true, keep: true })
    await cluster.postgres()
    await cluster.valkey()
    const runs = fake.calls.filter((c) => c[0] === "run")
    for (const run of runs) {
      expect(run).toContain(`hub-it.pid=${process.pid}`)
      expect(run).toContain("hub-it.keep=1")
    }
    expect(fake.calls.filter((c) => c[0] === "ps").length).toBe(1)
    expect(fake.calls.findIndex((c) => c[0] === "ps")).toBeLessThan(fake.calls.findIndex((c) => c[0] === "run"))
    const plain = fakeDocker()
    await new ItCluster({ exec: plain.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: false }).valkey()
    const run = plain.calls.find((c) => c[0] === "run")!
    expect(run).not.toContain("hub-it.keep=1")
    expect(plain.calls.filter((c) => c[0] === "ps")).toEqual([])
  })
})

describe("ItCluster with a fake docker", () => {
  test("postgres(): runs postgres:16 named hub-it-postgres-* on a random 127.0.0.1 port and waits for pg_isready", async () => {
    const fake = fakeDocker()
    fake.pgReady = [2, 1]
    const { clients, log } = fakeClients()
    const cluster = new ItCluster({ exec: fake.exec, clients, sleep: noSleep, random, keep: false })
    const pg = await cluster.postgres()
    const run = fake.calls.find((c) => c[0] === "run")!
    const name = run[run.indexOf("--name") + 1]!
    expect(name).toMatch(/^hub-it-postgres-/)
    expect(run.slice(0, 2)).toEqual(["run", "-d"])
    expect(run).toContain("--rm")
    expect(run[run.indexOf("-p") + 1]).toBe("127.0.0.1::5432")
    expect(run.at(-1)).toBe("postgres:16")
    expect(fake.calls).toContainEqual(["port", name, "5432/tcp"])
    expect(fake.calls.filter((c) => c[0] === "exec")).toEqual(Array(3).fill(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]))
    expect(pg.port).toBe(55432)
    expect(pg.url).toMatch(/^postgres:\/\/postgres:[^@]+@127\.0\.0\.1:55432\/postgres$/)
    expect(log).toEqual([`pg-ready ${pg.url}`])
    expect(cluster.containers()).toEqual([name])
  })

  test("valkey(): runs valkey/valkey:8 named hub-it-valkey-* and waits for PING", async () => {
    const fake = fakeDocker()
    let pings = 0
    const { clients } = fakeClients({ valkeyReady: async () => ++pings >= 3 })
    const cluster = new ItCluster({ exec: fake.exec, clients, sleep: noSleep, random, keep: false })
    const valkey = await cluster.valkey()
    const run = fake.calls.find((c) => c[0] === "run")!
    expect(run[run.indexOf("--name") + 1]).toMatch(/^hub-it-valkey-/)
    expect(run[run.indexOf("-p") + 1]).toBe("127.0.0.1::6379")
    expect(run.at(-1)).toBe("valkey/valkey:8")
    expect(valkey).toEqual({ name: run[run.indexOf("--name") + 1]!, port: 56379, url: "redis://127.0.0.1:56379" })
    expect(pings).toBe(3)
  })

  test("a missing image is pulled first (only the two known images)", async () => {
    const fake = fakeDocker()
    fake.imagesPresent.clear()
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: false })
    await cluster.postgres()
    await cluster.valkey()
    expect(fake.calls.filter((c) => c[0] === "pull")).toEqual([
      ["pull", "postgres:16"],
      ["pull", "valkey/valkey:8"],
    ])
  })

  test("each service starts once, also when asked concurrently", async () => {
    const fake = fakeDocker()
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: false })
    const [a, b] = await Promise.all([cluster.postgres(), cluster.postgres()])
    expect(a).toBe(b)
    expect(fake.calls.filter((c) => c[0] === "run").length).toBe(1)
  })

  test("freshDatabase creates a new database per call and returns its url; freshValkey flushes and returns the url", async () => {
    const fake = fakeDocker()
    const { clients, log } = fakeClients()
    const cluster = new ItCluster({ exec: fake.exec, clients, sleep: noSleep, random, keep: false })
    const one = await cluster.freshDatabase()
    const two = await cluster.freshDatabase()
    expect(one).not.toBe(two)
    const db = (url: string) => new URL(url).pathname.slice(1)
    expect(db(one)).toMatch(/^it_[a-z0-9_]+$/)
    expect(new URL(one).port).toBe("55432")
    const pg = await cluster.postgres()
    expect(log.filter((l) => l.startsWith("create"))).toEqual([`create ${db(one)} via ${pg.url}`, `create ${db(two)} via ${pg.url}`])
    expect(await cluster.freshValkey()).toBe("redis://127.0.0.1:56379")
    expect(log).toContain("flush redis://127.0.0.1:56379")
  })

  test("stop removes the containers it started (hub-it-* only), once", async () => {
    const fake = fakeDocker()
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: false })
    await cluster.postgres()
    await cluster.valkey()
    const names = cluster.containers()
    await cluster.stop()
    expect(fake.calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", "-v", ...names]])
    expect(cluster.containers()).toEqual([])
    await cluster.stop()
    expect(fake.calls.filter((c) => c[0] === "rm").length).toBe(1)
  })

  test("keep (HUB_IT_KEEP=1) leaves the containers running and says which", async () => {
    const fake = fakeDocker()
    const lines: string[] = []
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: true, log: (l) => void lines.push(l) })
    await cluster.valkey()
    const [name] = cluster.containers()
    await cluster.stop()
    expect(fake.calls.filter((c) => c[0] === "rm")).toEqual([])
    expect(lines.join("\n")).toContain(name!)
  })

  test("a container that never gets ready is removed and the start fails", async () => {
    const fake = fakeDocker()
    const { clients } = fakeClients({ valkeyReady: async () => false })
    const cluster = new ItCluster({ exec: fake.exec, clients, sleep: noSleep, random, keep: false, readyAttempts: 5 })
    await expect(cluster.valkey()).rejects.toThrow(/not ready/)
    const run = fake.calls.find((c) => c[0] === "run")!
    expect(fake.calls.at(-1)).toEqual(["rm", "-f", "-v", run[run.indexOf("--name") + 1]!])
    expect(cluster.containers()).toEqual([])
  })

  test("a failing docker run rejects with docker's message and leaves nothing behind", async () => {
    const fake = fakeDocker()
    fake.failRun = "postgres:16"
    const cluster = new ItCluster({ exec: fake.exec, clients: fakeClients().clients, sleep: noSleep, random, keep: false })
    await expect(cluster.postgres()).rejects.toThrow(/boom/)
    expect(cluster.containers()).toEqual([])
  })
})

// The real thing: opt-in, needs docker. Starts both containers, checks they serve, and removes them.
const real = itClusterEnabled() && (await dockerAvailable())
describe.skipIf(!real)("ItCluster with docker (HUB_IT_CLUSTER=1)", () => {
  test(
    "start, ready, fresh database and FLUSHDB, stop",
    async () => {
      const cluster = new ItCluster({ log: (line) => console.log(line) })
      try {
        const url = await cluster.freshDatabase()
        const sql = new Bun.SQL(url)
        try {
          await sql`CREATE TABLE t (n int)`
          await sql`INSERT INTO t VALUES (42)`
          expect((await sql`SELECT n FROM t`)[0].n).toBe(42)
        } finally {
          await sql.close()
        }
        const other = new Bun.SQL(await cluster.freshDatabase())
        try {
          expect((await other`SELECT to_regclass('t') AS t`)[0].t).toBeNull()
        } finally {
          await other.close()
        }
        const valkeyURL = await cluster.freshValkey()
        const redis = new Bun.RedisClient(valkeyURL)
        try {
          await redis.set("k", "v")
          expect(await redis.get("k")).toBe("v")
          await cluster.freshValkey()
          expect(await redis.get("k")).toBeNull()
        } finally {
          redis.close()
        }
      } finally {
        const names = cluster.containers()
        await cluster.stop()
        if (!process.env.HUB_IT_KEEP) {
          const left = Bun.spawnSync(["docker", "ps", "-a", "--format", "{{.Names}}"]).stdout.toString().split("\n")
          for (const name of names) expect(left).not.toContain(name)
        }
      }
    },
    180_000,
  )
})
