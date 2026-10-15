// OpenCode Hub server plugin: a thin "spoke" that connects this OpenCode process to the hub. The web
// console, phones and (optional) Voice speech live on the hub; this side only exposes sessions, forwards
// their events, and runs remote / voice turns and permission replies on request.
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_SUBAGENT, prepareConfigPath } from "./config"
import { HubRpc, VoiceRpc } from "./rpc"
import { checkServer, parseServerInput } from "./setup"
import { defineVoiceAgent, orchestratorParts } from "./spoke/conversation"
import { herdrRunner } from "./spoke/herdr"
import { listServiceSessions } from "./spoke/listing"
import { ensureLocalHub } from "./spoke/localhub"
import { joinProcess, type Membership } from "./spoke/singleton"
import { detectKind, Spoke, SpokeError, type SpokeHost } from "./spoke/spoke"

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

/** Plugin API results may arrive bare or wrapped as { location, data }. */
function unwrap<T>(value: unknown, isBare: (v: any) => boolean): T {
  const v = value as any
  return (v && !isBare(v) && v.data !== undefined ? v.data : v) as T
}

function hostFrom(ctx: Context): SpokeHost {
  const session = ctx.session as any
  const agent = ctx.agent as any
  const mcp = (ctx as any).mcp
  const vcs = (ctx as any).vcs
  return {
    directory: ctx.location.directory,
    opencodeVersion: ctx.app?.version ?? "unknown",
    events: (signal) => ctx.event.subscribe({ signal }) as AsyncIterable<any>,
    prompt: (input) => session.prompt(input),
    context: (sessionID) => session.context({ sessionID }),
    listModels: async () => unwrap<ReadonlyArray<unknown>>(await (ctx.model as any).list({}), Array.isArray),
    getSession: async (sessionID) => unwrap(await session.get({ sessionID }), (v) => typeof v.id === "string"),
    replyPermission: (input) => (ctx.permission as any).reply(input),
    interrupt: (sessionID) => session.interrupt({ sessionID }),
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

export default Plugin.define({
  id: "opencode-hub",
  async setup(ctx) {
    const kind = detectKind(process.argv)
    const membership: Membership<Spoke> = joinProcess(
      (processID) =>
        new Spoke(hostFrom(ctx), {
          configFile: prepareConfigPath(),
          machineName: hostname(),
          kind,
          processID,
          pid: process.pid,
          pluginVersion: pluginVersion(),
          // Loopback servers only, and only when autoStartLocalHub is on (see src/spoke/localhub.ts).
          localHub: (server) => ensureLocalHub(server),
          // One Herdr reader per machine: the background service's spoke (see src/spoke/herdr.ts).
          ...(kind === "service" ? { herdr: herdrRunner() } : {}),
        }),
    )

    try {
      await ctx.agent.transform((editor) => defineVoiceAgent(editor as any))
    } catch (cause) {
      console.error("[opencode-hub] could not register the voice agent", cause)
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
        })
        for (const text of parts) event.system.push({ type: "text", text })
      })
    } catch (cause) {
      console.error("[opencode-hub] could not register the context hook", cause)
    }

    const run = async <T>(rpc: { error: (...args: any[]) => any }, action: (spoke: Spoke) => T | Promise<T>) => {
      const spoke = membership.active()
      if (!spoke) return rpc.error("unavailable", "The hub spoke is not running in this OpenCode process", {})
      try {
        return await action(spoke)
      } catch (cause) {
        if (cause instanceof SpokeError) return rpc.error(cause.name, cause.message, {})
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
      openLink: (value, rpc) => run(rpc, (s) => s.openLink(input(value).sessionID ? String(input(value).sessionID) : undefined)),
      conversation: (value, rpc) =>
        run(rpc, (s) => s.setConversation(String(input(value).sessionID ?? ""), Boolean(input(value).on))),
      presence: (value, rpc) =>
        run(rpc, (s) => {
          const { sessionIDs, reporter } = input(value)
          if (!Array.isArray(sessionIDs)) throw new SpokeError("invalid", "Expected {sessionIDs: string[]}")
          s.presence(sessionIDs.filter((id): id is string => typeof id === "string").slice(0, 200), typeof reporter === "string" ? reporter.slice(0, 100) : undefined)
          return {}
        }),
    } satisfies Parameters<typeof ctx.rpc.register<typeof HubRpc>>[1]
    // "hub", plus the opencode-voice id "voice" for clients built against the old name (see src/rpc.ts).
    for (const definition of [HubRpc, VoiceRpc]) {
      try {
        await ctx.rpc.register(definition, handlers)
      } catch (cause) {
        console.error(`[opencode-hub] could not register RPC methods (${definition.id})`, cause)
      }
    }

    return () => membership.leave()
  },
})
