// The LaunchDriver of `hubctl setup`'s optional verification launch (launch-session; node-services/launch.ts),
// over the existing hub launch API (the SDK's hub.launches, as `hub launch` uses it; no new central capability):
//
//   start         one launch of the harness in the workspace (checkout mode: the repository as it is), pinned to
//                 this machine (placement require), ending when idle, cut off at the bound, cleaned up by the hub
//   awaitResponse until the launch runs a session (or ended without one: failed)
//   awaitIdle     until it ended idle (any other outcome fails)
//   inspect       what the node reported it left in the workspace (uncommitted changes, commits)
//   cleanup       nothing more: cleanup "remove" makes the hub's node remove the launch's own workspace changes
//   cancel        stops the launch (an ended one is already gone)
//   slotFree      whether the launch still counts against the node (any state but ended)
//
// The launch carries no credential; the caller's own hub login (`hub login`, an app token allowed to launch) is
// what the SDK client authenticates with. Every wait polls with the verification's abort signal.
import { randomBytes } from "node:crypto"
import type { LaunchSpec, LaunchView, Launches } from "../../../sdk/src/index.ts"
import type { LaunchDriver } from "../bootstrap/adapters/node-services/launch.ts"
import { txFail, txOk } from "../bootstrap/transaction/result.ts"

export const VERIFY_PROMPT = "This is a hubctl setup check: reply with the single word OK and change nothing."

export interface HubLaunchDriverOptions {
  readonly launches: Pick<Launches, "create" | "get" | "stop" | "list">
  /** This machine's ID (the stored machine credential's); undefined: not enrolled. */
  readonly machineID: () => Promise<string | undefined>
  readonly pollMs?: number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const ACTIVE = ["queued", "placing", "provisioning", "running"] as const

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"))
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true })
  })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function hubLaunchDriver(options: HubLaunchDriverOptions): LaunchDriver {
  const pollMs = options.pollMs ?? 1000
  const sleep = options.sleep ?? abortableSleep
  const get = async (id: string): Promise<LaunchView> => (await options.launches.get(id)).launch

  /** Polls until `done` says so (true: ok; a string: failed with it). */
  async function until(id: string, signal: AbortSignal, done: (l: LaunchView) => true | string | undefined) {
    try {
      for (;;) {
        const r = done(await get(id))
        if (r === true) return txOk(undefined)
        if (typeof r === "string") return txFail("harness_not_ready", r)
        await sleep(pollMs, signal)
      }
    } catch (error) {
      return txFail(signal.aborted ? "cancelled" : "offline", signal.aborted ? "cancelled" : `the hub could not be asked about launch ${id} (${message(error)})`)
    }
  }

  return {
    async start(request, signal) {
      const machine = await options.machineID().catch(() => undefined)
      if (!machine) return txFail("unauthorized", "this machine is not enrolled (run `hubctl machine enroll`)")
      const spec: LaunchSpec = {
        key: `hubctl-verify-${randomBytes(8).toString("hex")}`,
        harness: request.harness,
        workspace: { repo: request.workspace, mode: "checkout" },
        placement: { machine, mode: "require" },
        prompt: VERIFY_PROMPT,
        labels: { "hub.setup": "verify" },
        end: { when: "idle", timeout: `${Math.max(1, Math.ceil(request.maxDurationS / 60))}m`, cleanup: "remove" },
      }
      try {
        const created = await options.launches.create(spec, { signal })
        return txOk({ launchID: created.launch.id })
      } catch (error) {
        return txFail("harness_not_ready", `the hub refused the verification launch (${message(error)}); it needs \`hub login --scope sessions:launch\` and a grant with verb launch`)
      }
    },
    awaitResponse: (id, signal) => until(id, signal, (l) => (l.state === "running" && l.sessionID ? true : l.state === "ended" ? `the launch ended ${l.outcome ?? ""} before its session answered`.trim() : undefined)),
    awaitIdle: (id, signal) => until(id, signal, (l) => (l.state !== "ended" ? undefined : l.outcome === "idle" ? true : `the launch ended ${l.outcome ?? "without an outcome"}, not idle`)),
    async inspect(id) {
      try {
        const a = (await get(id)).artifacts
        const leftovers = [...(a?.dirty ? ["uncommitted changes"] : []), ...(a?.commits ? [`${a.commits} commit(s) on the launch branch`] : [])]
        return txOk({ leftovers })
      } catch (error) {
        return txFail("offline", `the hub could not be asked about launch ${id} (${message(error)})`)
      }
    },
    cleanup: async () => txOk(undefined),
    async cancel(id) {
      try {
        if ((await get(id)).state !== "ended") await options.launches.stop(id)
        return txOk(undefined)
      } catch (error) {
        return txFail("offline", `launch ${id} could not be stopped (${message(error)})`)
      }
    },
    async slotFree(id) {
      try {
        const { launches } = await options.launches.list({ state: [...ACTIVE] })
        return txOk(!launches.some((l) => l.id === id))
      } catch (error) {
        return txFail("offline", `the hub could not list launches (${message(error)})`)
      }
    },
  }
}
