// Phase 6 (a hub of several pods, design §9, §10; decision vkxkqiuf) end to end: two startCentral pods A and B on
// shared backends, a REAL Spoke (SpokeConnection, the plugin's client) and a REAL `hub node` daemon (NodeDaemon, host
// runtime, real git worktrees) of one machine, both behind a load-balancer stand-in that sends each new WebSocket to
// the first pod whose /readyz answers (as a k8s Service does) — so they land on A — and the `hub` CLI in-process as
// the user's device, pointed at B (and as a session's shell token, pointed at A).
//
// - Variants: shared memoryBackends() (default CI), and with HUB_IT_CLUSTER=1 real Postgres + Valkey (test/cluster-it.ts):
//   `hub-server migrate` and `hub-server import` of an older single-process state dir (test/import-fixture.ts) run
//   first, the pods build their own backends from HUB_DATABASE_URL / HUB_VALKEY_URL and sign with the imported
//   token keys, and the CLI uses the imported device token.
// - Through B: who/status/sessions see A's sessions; msg reaches the session on A once; an ask long-polls on B and
//   is answered by the session on A; the console stream on B gets A's turn deltas and resumes on A with
//   Last-Event-ID; a launch accepted on B runs on the node (on A) exactly once.
// - Tenancy: another user never sees or reaches the user's sessions, messages, launches or decisions on either pod.
// - Failover: draining A during a turn finishes the turn, the spoke and node move to B and B leads. Then a pod C
//   joins and B is stopped outright with a message pending and a launch waiting for placement: once the spoke and
//   node reach C, the message is delivered once, the launch placed and run once, and C leads.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../packages/cli/src/cli"
import { NodeConnection, NodeDaemon, normalizeNodeConfig } from "../packages/node/src/index.ts"
import { memoryBackends, type Backends } from "../src/central/backend"
import { leaderKey } from "../src/central/cluster/leader"
import { centralConfig } from "../src/central/config"
import { startCentral, type Central } from "../src/central/http"
import { runImport, runMigrate } from "../src/central/main"
import type { ServerRequest, SessionInfo } from "../src/protocol"
import { SpokeConnection, type SocketLike } from "../src/spoke/client"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"
import { webDir } from "./central-harness"
import { DEVICE_TOKEN, fixtureStateDir, TOKEN_KEYS } from "./import-fixture"

// End to end: real hubs, spokes, nodes and git; give each test room on a loaded machine.
setDefaultTimeout(30_000)

/** Short leases and loop ticks; drained spokes come back within 300 ms. */
const TIMING = { leaderTtlMs: 900, loopTickMs: 40, drainRetryAfterMs: 300, drainTimeoutMs: 8000 }
/** Pods, a node with real git and the CLI: well over bun's default 5 s on a loaded machine. */
const SLOW = 60_000

const BASE_ENV = {
  HUB_AUTH: "oidc",
  HUB_OIDC_CLIENT_ID: "cid",
  HUB_OIDC_CLIENT_SECRET: "csecret",
  HUB_OIDC_ALLOWED: "@example.com",
  HUB_ADMIN_EMAILS: "alice@example.com",
  HUB_TOKEN_KEYS: JSON.stringify(TOKEN_KEYS),
  HUB_PORT: "0",
  HUB_PUBLIC_URL: "https://hub.example.com",
}

interface Result {
  code: number
  stdout: string
  stderr: string
}
type Who = { env: Record<string, string>; home: string }

/** Where the pods' shared state lives, and who the user is there. */
interface Setup {
  readonly name: string
  /** Env for every pod (database and Valkey URLs). */
  readonly env: Record<string, string>
  /** Shared backends (memory); undefined: each pod builds its own from env (Postgres + Valkey). */
  readonly backends?: Backends
  /** The user (imported, or made on the first pod) and the device token the CLI logs in with. */
  user(first: Central): Promise<{ userID: string; deviceToken: string }>
  dispose(): Promise<void>
}

const setups: Array<{ name: string; make: () => Promise<Setup> }> = [
  {
    name: "memory",
    make: async () => ({
      name: "memory",
      env: { HUB_DATABASE_URL: "postgres://hub:s3cretDB@db.internal/hub", HUB_VALKEY_URL: "redis://:s3cretVK@valkey.internal:6379" },
      backends: memoryBackends(),
      async user(first) {
        const alice = await first.store.upsertUser({ email: "alice@example.com", role: "admin" })
        return { userID: alice.id, deviceToken: (await first.store.addDevice("cli", alice.id)).token }
      },
      dispose: async () => {},
    }),
  },
]

let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await Promise.all([it.postgres(), it.valkey()])
  setups.push({
    name: "postgres+valkey",
    make: async () => {
      const db = await it.freshDatabase()
      const valkey = await it.freshValkey()
      // An older single-process hub's state, migrated and imported as an operator would before the first pod starts.
      const stateDir = await fixtureStateDir()
      const quiet = { out: () => {}, err: (line: string) => console.error(line) }
      expect(await runMigrate({ env: { HUB_DATABASE_URL: db }, home: "/nonexistent", ...quiet })).toBe(0)
      expect(
        await runImport({ stateDir, dryRun: false, force: false, printTokenKeys: false }, { env: { HUB_DATABASE_URL: db }, home: "/nonexistent", ...quiet }),
      ).toBe(0)
      return {
        name: "postgres+valkey",
        env: { HUB_DATABASE_URL: db, HUB_VALKEY_URL: valkey },
        // The imported admin and her imported device: nothing re-enrols.
        user: async () => ({ userID: "u_alice", deviceToken: DEVICE_TOKEN }),
        dispose: async () => rmSync(stateDir, { recursive: true, force: true }),
      }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

// ---------- helpers ----------

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

const GIT_ENV = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" }
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function makeRepo(at: string): void {
  mkdirSync(at, { recursive: true })
  git(at, "init", "-q", "-b", "main")
  writeFileSync(path.join(at, "README.md"), "# e2e\n")
  git(at, "add", "README.md")
  git(at, "commit", "-q", "-m", "init")
}

/**
 * A load-balancer stand-in: each new WebSocket goes to the first pod whose /readyz answers 200 (polled every 20 ms,
 * as k8s takes a pod out of a Service when its readiness fails). Closed (hold): new sockets are refused.
 */
function loadBalancer() {
  const targets: Central[] = []
  const connections = new Map<string, number>()
  let ready: Central[] = []
  let polling = true
  let held = false
  void (async () => {
    while (polling) {
      const states = await Promise.all(
        targets.map((t) =>
          fetch(`${t.url}/readyz`).then(
            (r) => r.ok,
            () => false,
          ),
        ),
      )
      ready = targets.filter((_, i) => states[i])
      await Bun.sleep(20)
    }
  })()
  const socket = (_url: string, headers: Record<string, string>): SocketLike => {
    const target = held ? undefined : ready[0]
    // Nothing to send it to: a port nobody listens on (the client sees the connection fail and retries).
    const url = target ? `${target.url.replace(/^http/, "ws")}/spoke/ws` : "ws://127.0.0.1:9/spoke/ws"
    if (target) connections.set(target.url, (connections.get(target.url) ?? 0) + 1)
    return new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike)(url, { headers })
  }
  return {
    socket,
    connections,
    add: (pod: Central) => void targets.push(pod),
    hold: (on: boolean) => void (held = on),
    isReady: (pod: Central) => ready.includes(pod),
    stop: () => void (polling = false),
  }
}

type Frame = { id?: string; event?: string; data?: any }
/** Reads SSE frames with their ids (named events such as pings are skipped). */
function frames(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const all: Frame[] = []
  return {
    all,
    async next(predicate: (f: Frame) => boolean = () => true, timeoutMs = 5000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let index: number
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const frame: Frame = {}
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4)
            else if (line.startsWith("event: ")) frame.event = line.slice(7)
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6))
          }
          if (frame.data === undefined || frame.event) continue
          all.push(frame)
          if (predicate(frame)) return frame
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for SSE frame")
        const result = await Promise.race([reader.read(), Bun.sleep(left).then(() => ({ timeout: true }) as const)])
        if ("timeout" in result) continue
        if (result.done) throw new Error("SSE stream ended")
        buffer += decoder.decode(result.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}
const isType = (type: string) => (f: Frame) => f.data?.type === type

for (const { name: variant, make } of setups) {
  // Everything below runs in order on one cluster per variant (like the other phases' e2e files).
  let setup: Setup
  let tmp: string
  let root: string
  let repo: string
  let stateDir: string
  let userID: string
  let deviceToken: string
  let machineID: string
  let lb: ReturnType<typeof loadBalancer>
  let spoke: SpokeConnection
  let daemon: NodeDaemon
  let user: Who
  const pods: Central[] = []
  let a: Central
  let b: Central

  /** What the spoke was asked, and what it reports. */
  const ops: ServerRequest[] = []
  const reported: SessionInfo[] = []
  const shellTokens = new Map<string, string>()
  /** While set, the spoke holds requests carrying this text until `until` resolves (a turn it is working on). */
  let hold: { text: string; until: Promise<void> } | undefined

  const cookie = () => `voice_device=${deviceToken}`
  const dir = (name: string) => mkdtempSync(path.join(tmp, `${name}-`))
  const json = (r: Result) => JSON.parse(r.stdout)
  const opsOf = (op: string, match: (req: any) => boolean = () => true): any[] => ops.filter((r) => r.op === op && match(r))

  async function cli(argv: string[], who: Who): Promise<Result> {
    let stdout = ""
    let stderr = ""
    const code = await run(argv, { env: who.env, home: who.home, cwd: repo, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
    return { code, stdout, stderr }
  }

  async function login(url: string, token: string, name: string): Promise<Who> {
    const home = dir(name)
    const who = { env: { XDG_CONFIG_HOME: path.join(home, "xdg") }, home }
    const r = await cli(["login", "--url", url, "--token", token], who)
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
    return who
  }

  /** The CLI as a session (its shell token, as the spoke sets it), at `pod`. */
  const asSession = (sessionID: string, pod: Central): Who => ({
    env: { HUB_URL: pod.url, HUB_SESSION_TOKEN: shellTokens.get(sessionID)! },
    home: dir("shell"),
  })

  function startPod(podID: string): Central {
    const config = centralConfig({ ...BASE_ENV, ...setup.env, HUB_POD_ID: podID, HUB_STATE_DIR: stateDir }, "/home/me")
    const central = startCentral({ config, webDir: webDir(), timing: TIMING, ...(setup.backends ? { backends: setup.backends } : {}) })
    let stopped: Promise<void> | undefined
    const stop = central.stop.bind(central)
    central.stop = () => (stopped ??= stop())
    pods.push(central)
    lb.add(central)
    return central
  }

  const api = (pod: Central, pathname: string, init: { method?: string; json?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${pod.url}${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        cookie: init.cookie ?? cookie(),
        origin: pod.publicURL,
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      redirect: "manual",
    })

  /** Which pod holds a job's leader lease (read through the newest pod: a stopped pod's own backends are closed). */
  const leader = async (job: string) => (await pods.at(-1)!.backends.locks.holder(leaderKey(job)))?.owner.split(":")[0]

  /** The spoke reports its sessions (again). */
  const report = () => spoke.send({ t: "sessions", sessions: reported })
  const event = (type: string, data: Record<string, unknown>) => spoke.send({ t: "event", event: { type, data } } as any)

  async function handle(req: ServerRequest): Promise<unknown> {
    ops.push(req)
    const r = req as any
    if (hold && String(r.text ?? "").includes(hold.text)) await hold.until
    switch (req.op) {
      case "deliver":
        return { delivered: "steer" }
      case "create": {
        const id = `ses_l${reported.length + 1}`
        reported.push({ id, title: r.title ?? "launched", directory: r.directory, updated: Date.now(), owned: true })
        report()
        return { sessionID: id }
      }
      case "turn":
        event("session.status", { sessionID: r.sessionID, status: { type: "busy" } })
        await Bun.sleep(30)
        event("session.status", { sessionID: r.sessionID, status: { type: "idle" } })
        return { outcome: "succeeded", reply: "done" }
      case "stop":
        return { stopped: [r.sessionID] }
      case "sessionTokens":
        for (const t of r.tokens) shellTokens.set(t.sessionID, t.token)
        return { applied: r.tokens.map((t: any) => t.sessionID), skipped: [] }
      default:
        return {}
    }
  }

  describe(`phase 6 e2e (${variant})`, () => {
    beforeAll(async () => {
      setup = await make()
      tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-e2e-p6-")))
      stateDir = dir("state")
      root = path.join(tmp, "work")
      repo = path.join(root, "app")
      makeRepo(repo)
      lb = loadBalancer()

      a = startPod("pod-a")
      // A starts first and leads every timed job.
      await until(async () => (await leader("launches")) === "pod-a", 5000, "pod-a to lead")
      b = startPod("pod-b")
      await Promise.all([a.store.ready(), b.store.ready(), a.spokes.ready(), b.spokes.ready()])
      ;({ userID, deviceToken } = await setup.user(a))
      const machine = await a.store.addMachine("mbp", userID)
      machineID = machine.machine.id
      await until(() => lb.isReady(a) && lb.isReady(b), 5000, "both pods ready")

      // The machine's spoke (a service spoke: it also creates launched sessions) and its node, through the LB: on A.
      reported.push(
        { id: "ses_api", title: "API work", directory: root, updated: 1, owned: true },
        { id: "ses_web", title: "Web work", directory: root, updated: 1, owned: true },
      )
      spoke = new SpokeConnection({
        server: "http://lb.invalid",
        token: machine.token,
        hello: () => ({
          processID: "proc_e2e",
          kind: "service",
          directory: root,
          pid: 1,
          mode: "always",
          opencodeVersion: "2.0.0",
          pluginVersion: "0.0.1",
          features: ["launch", "deliver", "hubPrompt", "sessionTokens"],
        }),
        handle,
        backoff: { minMs: 50, maxMs: 200 },
        socket: lb.socket,
        onWelcome: () => void report(),
      })
      spoke.start()
      const { config, problems } = normalizeNodeConfig({ workspaceRoots: [root], labels: { pool: "e2e" }, slots: 2 })
      expect(problems).toEqual([])
      daemon = new NodeDaemon({
        config,
        credentials: { server: "http://lb.invalid", token: machine.token },
        // The real connection, through the LB, with a test-sized backoff.
        connect: (options) => new NodeConnection({ ...options, backoff: { minMs: 50, maxMs: 200 }, socket: lb.socket }),
      })
      daemon.start()
      await until(
        () => a.registry.hasSession("ses_api") && b.registry.hasSession("ses_web") && a.nodes.forMachine(machineID) !== undefined,
        8000,
        "spoke and node on A",
      )
      await until(() => shellTokens.has("ses_api") && shellTokens.has("ses_web"), 5000, "shell tokens")
      expect(lb.connections.get(a.url)).toBe(2)
      expect(lb.connections.get(b.url)).toBeUndefined()

      user = await login(b.url, deviceToken, "user")
    }, SLOW)

    afterAll(async () => {
      daemon?.stop()
      spoke?.stop()
      lb?.stop()
      for (const pod of pods) await pod.stop().catch(() => {})
      await setup?.dispose()
      if (tmp) rmSync(tmp, { recursive: true, force: true })
    })

    describe("one machine on A, the user on B", () => {
      test(
        "who, status and sessions on B list the sessions on A",
        async () => {
          const sessions = await cli(["sessions", "--json"], user)
          expect(sessions.code).toBe(0)
          expect(
            json(sessions)
              .sessions.map((s: any) => s.id)
              .sort(),
          ).toEqual(["ses_api", "ses_web"])
          const status = await cli(["status", "--json"], user)
          expect(status.code).toBe(0)
          expect(status.stdout).toContain("ses_api")
          expect(status.stdout).toContain("ses_web")
          const name = await cli(["name", "@backend", "--session", "ses_api"], user)
          expect({ code: name.code, stderr: name.stderr }).toEqual({ code: 0, stderr: "" })
          const who = await cli(["who", "--json"], user)
          expect(who.code).toBe(0)
          expect(json(who).sessions).toContainEqual(expect.objectContaining({ sessionID: "ses_api", name: "backend", online: true }))
        },
        SLOW,
      )

      test(
        "`hub msg` on B reaches the session on A once",
        async () => {
          const r = await cli(["msg", "@backend", "hello from B", "--json"], user)
          expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
          const id = json(r).message.id
          await until(() => opsOf("deliver", (q) => q.messageID === id).length === 1, 5000, "delivery")
          await Bun.sleep(200)
          expect(opsOf("deliver", (q) => q.messageID === id)).toHaveLength(1)
          expect(opsOf("deliver", (q) => q.messageID === id)[0]).toMatchObject({ sessionID: "ses_api" })
        },
        SLOW,
      )

      test(
        "`hub ask --wait` long-polls on B and wakes on the session's reply made on A",
        async () => {
          const asking = cli(["ask", "ses_web", "ready?", "--wait", "20", "--json"], user)
          await until(() => opsOf("deliver", (q) => q.sessionID === "ses_web" && String(q.text).includes("ready?")).length === 1, 5000, "the ask's delivery")
          const askID = opsOf("deliver", (q) => q.sessionID === "ses_web" && String(q.text).includes("ready?"))[0]!.messageID
          // The session answers with its own shell token, at A.
          await Bun.sleep(200)
          const replied = await cli(["reply", askID, "yes, ready"], asSession("ses_web", a))
          expect({ code: replied.code, stderr: replied.stderr }).toEqual({ code: 0, stderr: "" })
          const answeredAt = Date.now()
          const asked = await asking
          expect(Date.now() - answeredAt).toBeLessThan(2000)
          expect(asked.code).toBe(0)
          expect(json(asked)).toMatchObject({ message: { id: askID, state: "answered" }, answer: { text: "yes, ready" } })
        },
        SLOW,
      )

      test(
        "the console stream on B gets A's turn (status and deltas); Last-Event-ID resumes it on A",
        async () => {
          const onB = frames(await api(b, "/api/events"))
          await onB.next(isType("catalog"))
          event("session.execution.started", { sessionID: "ses_api" })
          event("session.text.delta", { sessionID: "ses_api", assistantMessageID: "m1", delta: "Working on it" })
          const working = await onB.next((f) => f.data?.type === "status" && JSON.stringify(f.data).includes("working"))
          expect(working.id).toBeDefined()
          expect((await onB.next(isType("delta"))).data).toMatchObject({ sessionID: "ses_api", text: "Working on it" })
          await onB.cancel()

          // Disconnected (say, B's stream broke); the turn finishes meanwhile; the console reconnects to A.
          event("session.execution.succeeded", { sessionID: "ses_api" })
          event("session.status", { sessionID: "ses_api", status: { type: "idle" } })
          await until(() => a.registry.idle("ses_api") && b.registry.idle("ses_api"), 5000, "idle on both pods")
          await Bun.sleep(100)
          const onA = frames(await api(a, "/api/events", { headers: { "last-event-id": working.id! } }))
          const resumed = await onA.next(isType("status"))
          expect(resumed.id).toBeDefined()
          expect(JSON.stringify(resumed.data)).not.toContain("working")
          await onA.next(isType("catalog"))
          expect(onA.all.some((f) => f.data?.type === "resync")).toBe(false)
          await onA.cancel()
        },
        SLOW,
      )

      test(
        "a launch accepted on B runs once on the node on A, in a real worktree",
        async () => {
          const r = await cli(["launch", "--repo", repo, "--branch", "feat/p6", "--prompt", "Build it", "--end", "never", "--json"], user)
          expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
          const id = json(r).launch.id
          await until(async () => (await b.launches.view(userID, id))?.state === "running", 15_000, "the launch running")
          const launch = (await b.launches.view(userID, id))!
          expect(launch.history.map((s) => s.state)).toEqual(["queued", "placing", "provisioning", "running"])
          expect(launch.machineID).toBe(machineID)
          const worktree = path.join(repo, ".worktrees", "feat", "p6")
          expect(launch.directory).toBe(worktree)
          expect(existsSync(path.join(worktree, "README.md"))).toBe(true)
          await until(() => opsOf("turn", (q) => q.sessionID === launch.sessionID).length === 1, 5000, "the prompt's turn")
          await Bun.sleep(300)
          expect(opsOf("create", (q) => q.launchID === id)).toHaveLength(1)
          expect(opsOf("turn", (q) => q.sessionID === launch.sessionID)).toHaveLength(1)
          expect(
            git(repo, "worktree", "list")
              .split("\n")
              .filter((line) => line.startsWith(worktree)),
          ).toHaveLength(1)
          // Stopped from B as well.
          const stopped = await cli(["launches", "stop", id, "--json"], user)
          expect(stopped.code).toBe(0)
          expect(json(stopped).launch).toMatchObject({ state: "ended", outcome: "stopped" })
          expect(opsOf("stop", (q) => q.sessionID === launch.sessionID)).toHaveLength(1)
        },
        SLOW,
      )
    })

    describe("tenancy across pods", () => {
      test(
        "another user never sees or reaches the user's sessions, messages, launches or decisions, on either pod",
        async () => {
          // Something of each kind: a message (above), a launch (above), and a Decision the session opens.
          const decided = await cli(["ask", "@me", "Ship it?", "--option", "yes=Yes", "--option", "no=No", "--json"], asSession("ses_api", a))
          expect({ code: decided.code, stderr: decided.stderr }).toEqual({ code: 0, stderr: "" })
          const decisionID = json(decided).decision.id
          const messageID = opsOf("deliver", (q) => q.sessionID === "ses_api" && q.text?.includes("hello from B"))[0]!.messageID
          const launchID = (await a.launches.list(userID))[0]!.id
          expect(decisionID && messageID && launchID).toBeTruthy()

          const eve = await a.store.upsertUser({ email: "eve@example.com", role: "user" })
          const eveCookie = `voice_device=${(await a.store.addDevice("eve phone", eve.id)).token}`
          await until(async () => (await b.store.recheck({ users: [eve.id] }), b.store.user(eve.id) !== undefined), 5000, "eve on B")
          const secrets = ["ses_api", "ses_web", decisionID, messageID, launchID]

          const table: Array<{ what: string; method?: string; path: string; json?: unknown; status?: number }> = [
            { what: "sessions", path: "/api/agent/sessions" },
            { what: "status", path: "/api/agent/status" },
            { what: "who", path: "/api/agent/who" },
            { what: "inbox", path: "/api/agent/inbox" },
            { what: "launches", path: "/api/agent/launches" },
            { what: "decisions", path: "/api/decisions" },
            { what: "agent decisions", path: "/api/agent/decisions" },
            { what: "session", path: "/api/agent/sessions/ses_api", status: 404 },
            { what: "console session", path: "/api/sessions/ses_api", status: 404 },
            { what: "message", path: `/api/agent/messages/${messageID}`, status: 404 },
            { what: "launch", path: `/api/agent/launches/${launchID}`, status: 404 },
            { what: "launch stop", method: "DELETE", path: `/api/agent/launches/${launchID}`, status: 404 },
            { what: "decision", path: `/api/decisions/${decisionID}`, status: 404 },
            { what: "decision answer", method: "POST", path: `/api/decisions/${decisionID}/answer`, json: { option: "yes" }, status: 404 },
            { what: "msg", method: "POST", path: "/api/agent/msg", json: { to: "ses_api", text: "hi" }, status: 404 },
            { what: "prompt", method: "POST", path: "/api/agent/sessions/ses_api/prompt", json: { text: "do it" }, status: 404 },
            { what: "console turn", method: "POST", path: "/api/sessions/ses_api/turn", json: { text: "do it" }, status: 404 },
          ]
          const rows: unknown[] = []
          for (const pod of [a, b]) {
            for (const row of table) {
              const response = await api(pod, row.path, {
                method: row.method ?? "GET",
                cookie: eveCookie,
                ...(row.json !== undefined ? { json: row.json } : {}),
              })
              const text = await response.text()
              rows.push({
                pod: pod === a ? "A" : "B",
                what: row.what,
                status: row.status ?? 200,
                got: response.status,
                // (A 404 may name what was asked for; anything else of the user's is a leak.)
                leaks: secrets.filter((s) => text.includes(s) && !`${row.path} ${JSON.stringify(row.json ?? "")}`.includes(s)),
              })
            }
          }
          const got = rows.map((r: any) => ({ pod: r.pod, what: r.what, status: r.got, leaks: r.leaks }))
          const want = rows.map((r: any) => ({ pod: r.pod, what: r.what, status: r.status, leaks: [] }))
          expect(got).toEqual(want)
          // Eve's stream on either pod gets nothing of the user's.
          const stream = frames(await api(b, "/api/events", { cookie: eveCookie }))
          await stream.next(isType("catalog"))
          event("session.execution.started", { sessionID: "ses_api" })
          event("session.text.delta", { sessionID: "ses_api", assistantMessageID: "m2", delta: "secret" })
          event("session.execution.succeeded", { sessionID: "ses_api" })
          event("session.status", { sessionID: "ses_api", status: { type: "idle" } })
          await until(() => b.registry.status("ses_api")?.[0]?.state === "idle", 5000, "the turn over")
          await Bun.sleep(300)
          expect(JSON.stringify(stream.all)).not.toContain("ses_api")
          expect(JSON.stringify(stream.all)).not.toContain("secret")
          await stream.cancel()
          // The decision and the message are untouched.
          expect((await a.decisions.get(userID, decisionID))?.state).toBe("open")
          expect(opsOf("deliver", (q) => q.text === "hi")).toHaveLength(0)
        },
        SLOW,
      )
    })

    describe("failover", () => {
      test(
        "draining A during a turn: the turn finishes, the spoke and the node move to B, B leads",
        async () => {
          let finish!: () => void
          await until(() => a.registry.status("ses_api")?.[0]?.state === "idle" && b.registry.status("ses_api")?.[0]?.state === "idle", 5000, "ses_api idle")
          hold = { text: "a long task", until: new Promise<void>((resolve) => (finish = resolve)) }
          const prompting = cli(["prompt", "@backend", "a long task", "--json"], user)
          // In flight on A (a turn, or a steer when the session is still working) while the session works on it.
          const longTask = () => ops.filter((q: any) => q.sessionID === "ses_api" && String(q.text ?? "").includes("a long task"))
          await until(() => longTask().length === 1, 5000, "the prompt on A")
          event("session.execution.started", { sessionID: "ses_api" })

          const draining = a.drain()
          await until(() => !lb.isReady(a), 3000, "A out of the LB")
          expect(lb.isReady(b)).toBe(true)
          // The node has nothing in flight: it moves at once, and A gives its leases up.
          await until(() => b.nodes.forMachine(machineID) !== undefined && lb.connections.get(b.url) === 1, 5000, "the node on B")
          await until(async () => (await leader("launches")) === "pod-b", 3000, "B leading")
          // The spoke stays on A until its turn is answered.
          await Bun.sleep(200)
          expect(spoke.state).toBe("connected")
          expect(lb.connections.get(b.url)).toBe(1)

          finish()
          hold = undefined
          const prompted = await prompting
          expect({ code: prompted.code, stderr: prompted.stderr }).toEqual({ code: 0, stderr: "" })
          await draining
          await until(() => lb.connections.get(b.url) === 2 && b.registry.hasSession("ses_api"), 5000, "the spoke on B")
          await a.stop()
          event("session.status", { sessionID: "ses_api", status: { type: "idle" } })
          expect(longTask().map((q: any) => q.op)).toEqual(["turn"])
          for (const job of ["launches", "decisions"]) expect(await leader(job)).toBe("pod-b")
          // Still reachable through B.
          const msg = await cli(["msg", "@backend", "after the drain", "--json"], user)
          expect(msg.code).toBe(0)
          await until(() => opsOf("deliver", (q) => q.messageID === json(msg).message.id).length === 1, 5000, "delivery via B")
        },
        SLOW,
      )

      test(
        "B stopped outright with a message pending and a launch to place: on C, delivered once, placed once, C leads",
        async () => {
          const c = startPod("pod-c")
          await Promise.all([c.store.ready(), c.spokes.ready()])
          await until(() => lb.isReady(c), 5000, "C ready")
          const onC = await login(c.url, deviceToken, "user-c")

          // B goes away without a drain; the LB holds new connections until the test lets them through.
          lb.hold(true)
          await b.stop()
          await until(() => !c.registry.hasSession("ses_api") && c.nodes.forMachine(machineID) === undefined, 5000, "B's spoke and node gone from C")

          const sent = await cli(["msg", "@backend", "while you were away", "--json"], onC)
          expect({ code: sent.code, stderr: sent.stderr }).toEqual({ code: 0, stderr: "" })
          expect(json(sent).delivery).toBe("pending")
          const messageID = json(sent).message.id
          const launched = await cli(["launch", "--repo", repo, "--branch", "feat/after", "--prompt", "After the move", "--end", "never", "--json"], onC)
          expect({ code: launched.code, stderr: launched.stderr }).toEqual({ code: 0, stderr: "" })
          const id = json(launched).launch.id
          await until(async () => (await leader("launches")) === "pod-c", TIMING.leaderTtlMs * 3, "C leading")
          await Bun.sleep(200)
          expect((await c.launches.view(userID, id))?.state).toBe("queued")
          expect(opsOf("deliver", (q) => q.messageID === messageID)).toHaveLength(0)

          lb.hold(false)
          await until(() => c.registry.hasSession("ses_api") && c.nodes.forMachine(machineID) !== undefined, 8000, "spoke and node on C")
          await until(() => opsOf("deliver", (q) => q.messageID === messageID).length === 1, 5000, "the pending message")
          await until(async () => (await c.launches.view(userID, id))?.state === "running", 15_000, "the launch running")
          const launch = (await c.launches.view(userID, id))!
          await until(() => opsOf("turn", (q) => q.sessionID === launch.sessionID).length === 1, 5000, "the prompt's turn")
          // A sessions frame more on C changes nothing.
          report()
          await Bun.sleep(500)
          expect(opsOf("deliver", (q) => q.messageID === messageID)).toHaveLength(1)
          expect(opsOf("create", (q) => q.launchID === id)).toHaveLength(1)
          expect(opsOf("turn", (q) => q.sessionID === launch.sessionID)).toHaveLength(1)
          expect(launch.history.map((s) => s.state).filter((s) => s === "provisioning")).toHaveLength(1)
          expect((await c.delivery.messages.get(userID, messageID))?.delivery).not.toBe("pending")
          for (const job of ["launches", "decisions"]) expect(await leader(job)).toBe("pod-c")
          expect((await cli(["launches", "stop", id], onC)).code).toBe(0)
        },
        SLOW,
      )
    })
  })
}
