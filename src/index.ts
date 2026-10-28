// Hub server plugin: a thin "spoke" that connects this OpenCode process to the hub. The web
// console, phones and (optional) Voice speech live on the hub; this side only exposes sessions, forwards
// their events, and runs remote / voice turns and permission replies on request.
import { mkdirSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_SUBAGENT, prepareConfigPath } from "./config"
import { HubRpc, VoiceRpc } from "./rpc"
import { jobFromInfo, type JobInfo } from "./protocol"
import { checkServer, parseServerInput } from "./setup"
import { defineVoiceAgent, orchestratorParts, STOP_TOOL, STOP_TOOL_DESCRIPTION } from "./spoke/conversation"
import { envInjector, hubBinDir, ShellCorrelator, stripInheritedHubEnv } from "./spoke/env-inject"
import { herdrRunner } from "./spoke/herdr"
import { launchSource } from "./spoke/launch-source"
import { HubRpcError, hubMsg, hubWho } from "./spoke/hub-rpc"
import { HUB_TOOL, HUB_TOOL_DESCRIPTION, HUB_TOOL_INPUT, runHubTool } from "./spoke/hub-tool"
import { cliEntry, installLaunchers, standaloneHubctl } from "./spoke/launchers"
import { listServiceSessions } from "./spoke/listing"
import { ensureLocalHub } from "./spoke/localhub"
import { nodeConfigPath, readWorkspaceRoots } from "./spoke/node-roots"
import { PromptReferences } from "./spoke/prompt-refs"
import { replyPermission, type PermissionLocation } from "./spoke/locations"
import { foregroundEndpoint, formOutcome } from "./spoke/own-server"
import { joinProcess, type Membership } from "./spoke/singleton"
import { detectKind, Spoke, SpokeError, type FormAction, type SpokeHost } from "./spoke/spoke"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

const VOICE_STYLE =
  "This message came from a voice conversation and your reply will be read aloud. " +
  "Answer in at most three short sentences of plain speech: no markdown, code blocks, tables, or lists. " +
  "Keep using tools as needed; only the final reply must be short."

function pluginVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0")
  } catch {
    return "0.0.0"
  }
}

/**
 * The most recent root sessions of the local OpenCode service with their workspace (used by the
 * service's own spoke for the phone's session browser): the history window plus `include`.
 */
async function listRecent(options?: { days: number; max: number; include: readonly string[] }) {
  const { Service } = await import("@opencode/client/service")
  const { OpenCode } = await import("@opencode/client")
  const endpoint = await Service.discover()
  if (!endpoint) return []
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) ?? {} })
  return listServiceSessions(client, options ?? {})
}

/** A client for this process's own OpenCode server, when it can be reached (see src/spoke/own-server.ts). */
async function ownClient(kind: "service" | "standalone") {
  const { OpenCode } = await import("@opencode/client")
  if (kind === "service") {
    const { Service } = await import("@opencode/client/service")
    const endpoint = await Service.discover()
    return endpoint ? OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) ?? {} }) : undefined
  }
  const endpoint = foregroundEndpoint(process.argv, process.env)
  return endpoint ? OpenCode.make({ baseUrl: endpoint.url, headers: { authorization: endpoint.authorization } }) : undefined
}

/** Answers or cancels a form through the own server's API (the plugin API has no forms). */
async function replyForm(kind: "service" | "standalone", action: FormAction): Promise<"replied" | "gone" | "unavailable"> {
  const client = await ownClient(kind).catch(() => undefined)
  if (!client) return "unavailable"
  try {
    if ("cancel" in action) await client.session.form.cancel({ sessionID: action.sessionID, formID: action.formID })
    else await client.session.form.reply({ sessionID: action.sessionID, formID: action.formID, answer: action.answer as Record<string, string | number | boolean | string[]> })
    return "replied"
  } catch (cause) {
    if (formOutcome(cause) === "gone") return "gone"
    throw cause
  }
}

/**
 * Has OpenCode regenerate a session's title with its title agent: session.update with an empty title over
 * the own server's HTTP API (the handler runs SessionTitle.generate and returns when it is done). The plugin
 * API's session.update would rename the session to "" instead. "unavailable" when the server cannot be reached.
 */
async function generateTitle(kind: "service" | "standalone", sessionID: string): Promise<"done" | "unavailable"> {
  const client = await ownClient(kind).catch(() => undefined)
  if (!client) return "unavailable"
  await client.session.update({ sessionID, title: "" })
  return "done"
}

/**
 * What runs now on this process's own server: session.active (sessions with a run in progress) and the running
 * shells of the given directories (shell.list, per location) that belong to a session. Empty when the server
 * cannot be reached.
 */
async function activity(kind: "service" | "standalone", directories: readonly string[]) {
  const client = await ownClient(kind).catch(() => undefined)
  if (!client) return { active: [], jobs: [] }
  const active = unwrap<Record<string, unknown>>(await client.session.active(), (v) => v && typeof v === "object" && !("data" in v))
  const jobs: Array<JobInfo & { sessionID: string }> = []
  const seen = new Set<string>()
  for (const directory of directories) {
    try {
      const list = unwrap<unknown[]>(await client.shell.list({ location: { directory } }), Array.isArray)
      for (const raw of Array.isArray(list) ? list : []) {
        const job = jobFromInfo(raw, "shell")
        if (!job?.sessionID || job.status !== "running" || seen.has(job.id)) continue
        seen.add(job.id)
        jobs.push(job as JobInfo & { sessionID: string })
      }
    } catch {
      // a location this server does not serve
    }
  }
  return { active: Object.keys(active ?? {}), jobs }
}

/** Plugin API results may arrive bare or wrapped as { location, data }. */
function unwrap<T>(value: unknown, isBare: (v: any) => boolean): T {
  const v = value as any
  return (v && !isBare(v) && v.data !== undefined ? v.data : v) as T
}

/** This instance's location-scoped permission API (OpenCode keeps pending permissions per location). */
function permissionLocation(ctx: Context): PermissionLocation {
  const permission = ctx.permission as any
  return {
    directory: ctx.location.directory,
    get: (input) => permission.get(input),
    reply: (input) => permission.reply(input),
  }
}

/** `locations`: the permission APIs of every plugin instance in this process (one per location). */
function hostFrom(ctx: Context, locations: () => PermissionLocation[], kind: "service" | "standalone"): SpokeHost {
  const session = ctx.session as any
  const agent = ctx.agent as any
  const mcp = (ctx as any).mcp
  const vcs = (ctx as any).vcs
  return {
    directory: ctx.location.directory,
    opencodeVersion: ctx.app?.version ?? "unknown",
    events: (signal) => ctx.event.subscribe({ signal }) as AsyncIterable<any>,
    prompt: (input) => session.prompt(input),
    // OpenCode's native synthetic messages (hub deliveries); without them the spoke does not announce "deliver".
    ...(typeof session.synthetic === "function"
      ? { synthetic: async (input: Parameters<NonNullable<SpokeHost["synthetic"]>>[0]) => unwrap<{ id?: string }>(await session.synthetic(input), (v) => typeof v.id === "string") }
      : {}),
    context: (sessionID) => session.context({ sessionID }),
    listModels: async () => unwrap<ReadonlyArray<unknown>>(await (ctx.model as any).list({}), Array.isArray),
    getSession: async (sessionID) => unwrap(await session.get({ sessionID }), (v) => typeof v.id === "string"),
    replyPermission: ({ directory, ...input }) => replyPermission(locations(), input, directory),
    replyForm: (action) => replyForm(kind, action),
    interrupt: (sessionID) => session.interrupt({ sessionID }),
    updateSession: (sessionID, input) => session.update({ sessionID, ...input }),
    generateTitle: (sessionID) => generateTitle(kind, sessionID),
    switchAgent: (sessionID, id) => session.switchAgent({ sessionID, agent: id }),
    switchModel: (sessionID, model) => session.switchModel({ sessionID, model }),
    hasAgent: async (id) => {
      try {
        const info = unwrap<{ id?: string } | undefined>(await agent.get({ agentID: id }), (v) => typeof v.id === "string")
        return info?.id === id
      } catch {
        return false
      }
    },
    defaultAgent: async () => {
      const list = unwrap<Array<{ id: string; mode?: string; hidden?: boolean }>>(await agent.list({}), Array.isArray)
      return list?.find((a) => a.mode !== "subagent" && !a.hidden)?.id
    },
    listRecent,
    activity: (directories) => activity(kind, directories),
    createSession: async ({ directory, title }) =>
      unwrap<{ id: string }>(await session.create({ location: { directory }, ...(title ? { title } : {}) }), (v) => typeof v.id === "string"),
    ...(mcp?.list ? { mcpList: async (directory: string) => unwrap<ReadonlyArray<unknown>>(await mcp.list({ location: { directory } }), Array.isArray) } : {}),
    ...(vcs?.diff ? { vcsDiff: async (directory: string) => unwrap<ReadonlyArray<unknown>>(await vcs.diff({ mode: "working", location: { directory } }), Array.isArray) } : {}),
    ...(vcs?.get
      ? {
          vcsBranch: async (directory: string) => {
            const info = unwrap<{ branch?: { current?: string } }>(await vcs.get({ location: { directory } }), (v) => "branch" in v)
            return typeof info?.branch?.current === "string" ? info.branch.current : undefined
          },
        }
      : {}),
  }
}

/**
 * Gives every shell the agent runs through the shell tool its session's HUB_URL/HUB_SESSION_TOKEN and puts the hub
 * bin dir first on PATH (src/spoke/env-inject.ts). Known gap: user `!` commands have no tool call, so get no token.
 */
async function registerShellEnv(ctx: Context, identity: (sessionID: string) => { token: string; url?: string } | undefined) {
  const binDir = hubBinDir()
  try {
    mkdirSync(binDir, { recursive: true, mode: 0o700 })
    // The `hub`/`hubctl` launchers run the CLI with this runtime (OpenCode's binary as bun; src/spoke/launchers.ts).
    const bun = typeof process.versions.bun === "string"
    const entry = cliEntry(fileURLToPath(new URL("..", import.meta.url)), bun)
    if (entry) installLaunchers({ binDir, execPath: process.execPath, bun, entry, standalone: standaloneHubctl(homedir()) })
    else console.error("[hub] no built hub CLI (packages/cli/dist/hub-cli.js): `hub` is not installed")
  } catch (cause) {
    console.error("[hub] could not install the hub CLI launchers", cause)
  }
  const injector = envInjector({ correlator: new ShellCorrelator(), binDir, identity })
  const tool = (ctx as any).tool
  const shell = (ctx as any).shell
  try {
    if (!tool?.hook || !shell?.hook) throw new Error("this OpenCode has no tool/shell hooks")
    await tool.hook("execute.before", (event: any) => injector.toolBefore(event))
    await tool.hook("execute.after", (event: any) => injector.toolAfter(event))
    await shell.hook("create.before", (invocation: any) => injector.shellBefore(invocation))
  } catch (cause) {
    console.error("[hub] could not register the shell environment hooks", cause)
  }
}

export default Plugin.define({
  id: "hub",
  async setup(ctx) {
    // An OpenCode started from a session's shell must not act as that session (nor hand its token to its shells).
    stripInheritedHubEnv(process.env)
    const kind = detectKind(process.argv)
    // Inside a launch's sandbox the spoke is launch-bound: the node's read-only launch config and node.json, no
    // machine config, enrolment, local hub or Herdr (src/spoke/launch-source.ts). A broken one leaves no spoke.
    const source = launchSource()
    const membership: Membership<Spoke> = joinProcess(
      (processID) => {
        if (source.kind === "invalid") throw new Error(`${source.error}; the hub spoke is off in this process`)
        const host = hostFrom(ctx, () => membership.locals<PermissionLocation>(), kind)
        const common = { machineName: hostname(), kind, processID, pid: process.pid, pluginVersion: pluginVersion() }
        if (source.kind === "launch") {
          const nodeConfig = source.nodeConfig
          return new Spoke(host, { ...common, configFile: source.file, launch: source.launch, workspaceRoots: () => readWorkspaceRoots(nodeConfig) })
        }
        return new Spoke(host, {
          ...common,
          configFile: prepareConfigPath(),
          // Loopback servers only, and only when autoStartLocalHub is on (see src/spoke/localhub.ts).
          localHub: (server) => ensureLocalHub(server),
          // One Herdr reader per machine: the background service's spoke (see src/spoke/herdr.ts). Launch creates
          // (service only) need the node workspace roots, read from node.json each time (src/spoke/node-roots.ts).
          ...(kind === "service" ? { herdr: herdrRunner(), workspaceRoots: () => readWorkspaceRoots(nodeConfigPath()) } : {}),
        })
      },
      undefined,
      permissionLocation(ctx),
    )

    try {
      await ctx.agent.transform((editor) => defineVoiceAgent(editor as any))
    } catch (cause) {
      console.error("[hub] could not register the voice agent", cause)
    }

    try {
      await ctx.session.hook("context", (event) => {
        const spoke = membership.active()
        if (spoke?.isVoiceTurn(event.sessionID)) event.system.push({ type: "text", text: VOICE_STYLE })
        const parts = orchestratorParts({
          agent: event.agent,
          conversation: spoke?.inConversation(event.sessionID) ?? false,
          subagent: spoke?.subagent() ?? DEFAULT_SUBAGENT,
          workModel: spoke?.workModelFor(event.sessionID),
          taskBoard: spoke?.taskBoard(event.sessionID),
        })
        for (const text of parts) event.system.push({ type: "text", text })
      })
    } catch (cause) {
      console.error("[hub] could not register the context hook", cause)
    }

    try {
      // The voice agent stops one worker ("cancel the deploy one") without stopping itself or the others.
      await (ctx as any).tool?.transform?.((editor: any) =>
        editor.add({
          name: STOP_TOOL,
          description: STOP_TOOL_DESCRIPTION,
          input: {
            type: "object",
            properties: {
              sessionID: { type: "string", description: "The worker's sessionID, from your task board or the subagent tool's result." },
              all: { type: "boolean", description: "true: stop every worker of yours that is still running." },
            },
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (value: unknown, context: { sessionID: string }) => {
            const spoke = membership.active()
            if (!spoke) return { content: "The hub is not running in this OpenCode process; nothing was stopped." }
            const { stopped, text } = await spoke.stopWorkers(context.sessionID, (value ?? {}) as Record<string, unknown>)
            return { content: text, metadata: { stopped } }
          },
        }),
      )
    } catch (cause) {
      console.error("[hub] could not register the task stop tool", cause)
    }

    try {
      // Agents message and ask other sessions as themselves (the session's own hub token; src/spoke/hub-tool.ts).
      await (ctx as any).tool?.transform?.((editor: any) =>
        editor.add({
          name: HUB_TOOL,
          description: HUB_TOOL_DESCRIPTION,
          input: HUB_TOOL_INPUT,
          options: { codemode: false },
          execute: (value: unknown, context: { sessionID: string; signal?: AbortSignal }) =>
            runHubTool(() => membership.active(), value, { sessionID: context.sessionID, ...(context.signal ? { signal: context.signal } : {}) }),
        }),
      )
    } catch (cause) {
      console.error("[hub] could not register the hub tool", cause)
    }

    try {
      // @name / @@role in a prompt get context from the hub as an attached text file; the text is never changed
      // and the harness's own @ meanings win (src/spoke/prompt-refs.ts, design §2.4).
      const references = new PromptReferences(() => membership.active())
      await ctx.session.hook("prompt", (event) => references.onPrompt(event))
    } catch (cause) {
      console.error("[hub] could not register the prompt hook", cause)
    }

    await registerShellEnv(ctx, (sessionID) => membership.active()?.shellIdentity(sessionID))

    const run = async <T>(rpc: { error: (...args: any[]) => any }, action: (spoke: Spoke) => T | Promise<T>) => {
      const spoke = membership.active()
      if (!spoke) return rpc.error("unavailable", "The hub spoke is not running in this OpenCode process", {})
      try {
        return await action(spoke)
      } catch (cause) {
        if (cause instanceof SpokeError) return rpc.error(cause.name, cause.message, {})
        if (cause instanceof HubRpcError) return rpc.error(cause.code, cause.message, {})
        return rpc.error("server_error", cause instanceof Error ? cause.message : String(cause), {})
      }
    }
    const input = (value: unknown) => (value ?? {}) as Record<string, any>

    const handlers = {
      status: (value, rpc) => run(rpc, (s) => s.status(input(value).sessionID)),
      setServer: (value, rpc) => run(rpc, (s) => (s.setServer(String(input(value).server ?? "")), {})),
      checkServer: async (value, rpc) => {
        const parsed = parseServerInput(String(input(value).server ?? ""))
        if (!parsed.ok) return rpc.error("invalid", parsed.error, {})
        return checkServer(parsed.url)
      },
      startLocalHub: (_value, rpc) => run(rpc, (s) => s.startLocalHub()),
      enroll: (_value, rpc) => run(rpc, (s) => s.enroll()),
      setMode: (value, rpc) => run(rpc, (s) => (s.setMode(input(value).mode), {})),
      setSession: (value, rpc) =>
        run(rpc, (s) => (s.setSession(String(input(value).sessionID ?? ""), Boolean(input(value).on)), {})),
      pairCode: (_value, rpc) => run(rpc, (s) => s.pairCode()),
      handoff: (value, rpc) => run(rpc, (s) => s.handoff(String(input(value).sessionID ?? ""))),
      openLink: (value, rpc) =>
        run(rpc, (s) => s.openLink(input(value).sessionID ? String(input(value).sessionID) : undefined, input(value).voice === true)),
      conversation: (value, rpc) =>
        run(rpc, (s) => s.setConversation(String(input(value).sessionID ?? ""), Boolean(input(value).on))),
      formActions: (value, rpc) =>
        run(rpc, (s) => {
          const { waitMs = 0 } = input(value)
          if (typeof waitMs !== "number" || !Number.isFinite(waitMs)) throw new SpokeError("invalid", "Expected {waitMs: number}")
          return s.formActions(Math.max(0, Math.min(waitMs, 25_000))) as Promise<{ actions: Array<Record<string, unknown>> }>
        }),
      presence: (value, rpc) =>
        run(rpc, (s) => {
          const { sessionIDs, reporter } = input(value)
          if (!Array.isArray(sessionIDs)) throw new SpokeError("invalid", "Expected {sessionIDs: string[]}")
          s.presence(sessionIDs.filter((id): id is string => typeof id === "string").slice(0, 200), typeof reporter === "string" ? reporter.slice(0, 100) : undefined)
          return {}
        }),
      // The TUI's /who and /msg, as its current session (src/spoke/hub-rpc.ts).
      hubWho: (value, rpc) => run(rpc, (s) => hubWho(s, value)),
      hubMsg: (value, rpc) => run(rpc, (s) => hubMsg(s, value)),
    } satisfies Parameters<typeof ctx.rpc.register<typeof HubRpc>>[1]
    // "hub", plus the opencode-voice id "voice" for clients built against the old name (see src/rpc.ts).
    for (const definition of [HubRpc, VoiceRpc]) {
      try {
        await ctx.rpc.register(definition, handlers)
      } catch (cause) {
        console.error(`[hub] could not register RPC methods (${definition.id})`, cause)
      }
    }

    return () => membership.leave()
  },
})
