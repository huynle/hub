// Device-code enrollment of this machine with the central server (before it has a token).
// POST /spoke/enroll → EnrollStart; then POST /spoke/enroll/poll until the user approves it.
import type { EnrollPoll, EnrollStart } from "../../protocol/src/index.ts"

export type EnrollOutcome =
  | { readonly status: "approved"; readonly machineID: string; readonly machineToken: string }
  | { readonly status: "denied" | "expired" | "cancelled" }

export interface EnrollOptions {
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

const REQUEST_TIMEOUT_MS = 15_000

async function post(server: string, path: string, body: unknown, options: EnrollOptions): Promise<unknown> {
  const doFetch = options.fetch ?? fetch
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]
  const response = await doFetch(`${server.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`)
  return response.json()
}

function isStart(v: any): v is EnrollStart {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.userCode === "string" &&
    typeof v.deviceCode === "string" &&
    typeof v.approveURL === "string" &&
    typeof v.intervalMs === "number" &&
    typeof v.expiresAt === "number"
  )
}

export async function startEnrollment(server: string, machineName: string, options: EnrollOptions = {}): Promise<EnrollStart> {
  const body = await post(server, "/spoke/enroll", { machineName }, options)
  if (!isStart(body)) throw new Error("Invalid enrollment reply from the hub")
  return body
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })

/** Polls until approved, denied, expired, or aborted. Transient errors are retried until expiry. */
export async function pollEnrollment(server: string, start: EnrollStart, options: EnrollOptions = {}): Promise<EnrollOutcome> {
  const now = options.now ?? Date.now
  const interval = Math.max(1, start.intervalMs)
  for (;;) {
    if (options.signal?.aborted) return { status: "cancelled" }
    if (now() > start.expiresAt) return { status: "expired" }
    await sleep(interval, options.signal)
    if (options.signal?.aborted) return { status: "cancelled" }
    let reply: Partial<EnrollPoll> & Record<string, unknown>
    try {
      reply = (await post(server, "/spoke/enroll/poll", { deviceCode: start.deviceCode }, options)) as typeof reply
    } catch {
      continue
    }
    if (reply?.status === "approved" && typeof reply.machineID === "string" && typeof reply.machineToken === "string") {
      return { status: "approved", machineID: reply.machineID, machineToken: reply.machineToken }
    }
    if (reply?.status === "denied" || reply?.status === "expired") return { status: reply.status }
  }
}
