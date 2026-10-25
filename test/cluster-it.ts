// The opt-in docker harness for cluster integration tests (HUB_IT_CLUSTER=1; decision vkxkqiuf §10).
//
// Starts throwaway postgres:16 and valkey/valkey:8 containers on random 127.0.0.1 ports, waits until they serve,
// hands each suite a fresh database (CREATE DATABASE it_<random>) or a flushed Valkey (FLUSHDB), and removes the
// containers when the suite ends, also when it fails (HUB_IT_KEEP=1 leaves them running to look at). It only
// ever creates or removes containers named hub-it-*, and pulls no image but those two. Each service starts
// lazily, on first use, at most once per ItCluster. Without docker, callers skip (dockerAvailable()).
import { randomUUID } from "node:crypto"

/** Runs the docker CLI with these arguments. Throws when the CLI cannot be started at all. */
export type DockerExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

/** What the harness asks of the services themselves (injectable for tests). */
export interface ItClients {
  /** True once the server accepts a query at this url. */
  postgresReady(url: string): Promise<boolean>
  /** True once the server answers PING. */
  valkeyReady(url: string): Promise<boolean>
  createDatabase(adminURL: string, name: string): Promise<void>
  flushValkey(url: string): Promise<void>
}

/** A started container: its name, host port and the url to reach it (postgres: the admin database). */
export interface ItService {
  readonly name: string
  readonly port: number
  readonly url: string
}

export interface ItClusterOptions {
  /** The docker CLI (default: `docker` via Bun.spawn). */
  readonly exec?: DockerExec
  readonly clients?: ItClients
  readonly sleep?: (ms: number) => Promise<void>
  /** Suffix for container and database names (default: 8 random hex characters). */
  readonly random?: () => string
  /** Leave the containers running on stop (default: HUB_IT_KEEP=1). */
  readonly keep?: boolean
  readonly log?: (line: string) => void
  /** Readiness polls, 250 ms apart (default 240: one minute). */
  readonly readyAttempts?: number
  /** Remove the containers when the process exits or is interrupted (default: when using the real docker CLI). */
  readonly exitCleanup?: boolean
}

export const NAME_PREFIX = "hub-it-"
export const POSTGRES_IMAGE = "postgres:16"
export const VALKEY_IMAGE = "valkey/valkey:8"
const READY_INTERVAL_MS = 250

/** Cluster integration tests run only with HUB_IT_CLUSTER=1. */
export const itClusterEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.HUB_IT_CLUSTER === "1"

/** The host port of a `-p 127.0.0.1::<port>` mapping, from `docker port <name> <port>/tcp` output. */
export function parsePort(output: string): number {
  for (const line of output.split("\n")) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(line.trim())
    if (match) return Number(match[1])
  }
  throw new Error(`no 127.0.0.1 port mapping in docker port output: ${JSON.stringify(output)}`)
}

/** The docker CLI through Bun.spawn. */
export const dockerExec: DockerExec = async (args) => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

/** True when the docker CLI is installed and its daemon answers. */
export async function dockerAvailable(exec: DockerExec = dockerExec): Promise<boolean> {
  try {
    return (await exec(["version", "--format", "{{.Server.Version}}"])).code === 0
  } catch {
    return false
  }
}

function assertOwnNames(names: string[]): void {
  const foreign = names.filter((name) => !name.startsWith(NAME_PREFIX))
  if (foreign.length) throw new Error(`refusing to remove containers not named ${NAME_PREFIX}*: ${foreign.join(", ")}`)
}

/** `docker rm -f -v` for harness containers; refuses (removing nothing) when any name is not hub-it-*. */
export async function removeContainers(exec: DockerExec, names: string[]): Promise<void> {
  assertOwnNames(names)
  if (!names.length) return
  await exec(["rm", "-f", "-v", ...names])
}

/** The real services, through Bun.SQL and Bun.RedisClient. */
export const bunClients: ItClients = {
  async postgresReady(url) {
    const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 2 })
    try {
      await sql`SELECT 1`
      return true
    } catch {
      return false
    } finally {
      await sql.close().catch(() => {})
    }
  },
  async valkeyReady(url) {
    const client = new Bun.RedisClient(url, { autoReconnect: false, connectionTimeout: 2000 })
    try {
      return (await client.send("PING", [])) === "PONG"
    } catch {
      return false
    } finally {
      client.close()
    }
  },
  async createDatabase(adminURL, name) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name ${name}`)
    const sql = new Bun.SQL(adminURL, { max: 1 })
    try {
      await sql.unsafe(`CREATE DATABASE "${name}"`)
    } finally {
      await sql.close()
    }
  },
  async flushValkey(url) {
    const client = new Bun.RedisClient(url, { autoReconnect: false })
    try {
      await client.send("FLUSHDB", [])
    } finally {
      client.close()
    }
  },
}

/** Throwaway Postgres and Valkey containers for one test process. */
export class ItCluster {
  private readonly exec: DockerExec
  private readonly clients: ItClients
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => string
  private readonly keep: boolean
  private readonly log: (line: string) => void
  private readonly readyAttempts: number
  private readonly exitCleanup: boolean
  private readonly password: string
  private readonly live = new Set<string>()
  private pg?: Promise<ItService>
  private vk?: Promise<ItService>
  private exitHooked = false

  constructor(options: ItClusterOptions = {}) {
    this.exec = options.exec ?? dockerExec
    this.clients = options.clients ?? bunClients
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
    this.random = options.random ?? (() => randomUUID().replaceAll("-", "").slice(0, 8))
    this.keep = options.keep ?? process.env.HUB_IT_KEEP === "1"
    this.log = options.log ?? (() => {})
    this.readyAttempts = options.readyAttempts ?? 240
    this.exitCleanup = options.exitCleanup ?? !options.exec
    this.password = `hubit${this.random()}`
  }

  /** The Postgres container (started on first use); its url is the admin database `postgres`. */
  postgres(): Promise<ItService> {
    this.pg ??= this.start({
      kind: "postgres",
      image: POSTGRES_IMAGE,
      port: 5432,
      env: [`POSTGRES_PASSWORD=${this.password}`],
      url: (port) => `postgres://postgres:${this.password}@127.0.0.1:${port}/postgres`,
      ready: async (name, url) =>
        (await this.exec(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).code === 0 && (await this.clients.postgresReady(url)),
    }).catch((error) => {
      this.pg = undefined
      throw error
    })
    return this.pg
  }

  /** The Valkey container (started on first use). */
  valkey(): Promise<ItService> {
    this.vk ??= this.start({
      kind: "valkey",
      image: VALKEY_IMAGE,
      port: 6379,
      env: [],
      url: (port) => `redis://127.0.0.1:${port}`,
      ready: (_name, url) => this.clients.valkeyReady(url),
    }).catch((error) => {
      this.vk = undefined
      throw error
    })
    return this.vk
  }

  /** A new, empty database on the Postgres container; returns its url. */
  async freshDatabase(): Promise<string> {
    const pg = await this.postgres()
    const name = `it_${this.random().toLowerCase().replace(/[^a-z0-9_]/g, "_")}`
    await this.clients.createDatabase(pg.url, name)
    const url = new URL(pg.url)
    url.pathname = `/${name}`
    return url.toString()
  }

  /** The Valkey url after FLUSHDB. */
  async freshValkey(): Promise<string> {
    const valkey = await this.valkey()
    await this.clients.flushValkey(valkey.url)
    return valkey.url
  }

  /** The names of the containers this cluster runs. */
  containers(): string[] {
    return [...this.live]
  }

  /** Removes the containers (or, with keep, leaves them and says which). Safe to call more than once. */
  async stop(): Promise<void> {
    const names = this.containers()
    this.live.clear()
    this.pg = undefined
    this.vk = undefined
    if (!names.length) return
    if (this.keep) {
      this.log(`HUB_IT_KEEP=1: leaving ${names.join(", ")} running (remove with: docker rm -f -v ${names.join(" ")})`)
      return
    }
    await removeContainers(this.exec, names)
  }

  private async start(spec: {
    kind: string
    image: string
    port: number
    env: string[]
    url: (port: number) => string
    ready: (name: string, url: string) => Promise<boolean>
  }): Promise<ItService> {
    if ((await this.exec(["image", "inspect", spec.image])).code !== 0) {
      this.log(`pulling ${spec.image}`)
      const pull = await this.exec(["pull", spec.image])
      if (pull.code !== 0) throw new Error(`docker pull ${spec.image} failed: ${pull.stderr.trim()}`)
    }
    const name = `${NAME_PREFIX}${spec.kind}-${this.random()}`
    const env = spec.env.flatMap((e) => ["-e", e])
    const run = await this.exec(["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1::${spec.port}`, ...env, spec.image])
    if (run.code !== 0) throw new Error(`docker run ${spec.image} failed: ${run.stderr.trim()}`)
    this.live.add(name)
    this.hookExit()
    try {
      const port = parsePort((await this.exec(["port", name, `${spec.port}/tcp`])).stdout)
      const url = spec.url(port)
      for (let attempt = 0; attempt < this.readyAttempts; attempt++) {
        if (await spec.ready(name, url)) {
          this.log(`${name} ready on 127.0.0.1:${port}`)
          return { name, port, url }
        }
        await this.sleep(READY_INTERVAL_MS)
      }
      throw new Error(`${name} not ready after ${this.readyAttempts} attempts`)
    } catch (error) {
      this.live.delete(name)
      await removeContainers(this.exec, [name]).catch(() => {})
      throw error
    }
  }

  /** Last-resort removal when the process exits or is interrupted before stop() ran. */
  private hookExit(): void {
    if (!this.exitCleanup || this.keep || this.exitHooked) return
    this.exitHooked = true
    const cleanup = () => {
      const names = this.containers()
      if (!names.length) return
      assertOwnNames(names)
      this.live.clear()
      Bun.spawnSync(["docker", "rm", "-f", "-v", ...names], { stdout: "ignore", stderr: "ignore" })
    }
    process.once("exit", cleanup)
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        cleanup()
        process.exit(signal === "SIGINT" ? 130 : 143)
      })
    }
  }
}
