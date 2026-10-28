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
  /**
   * "follow" (default) follows HTTP redirects. "error" refuses them: a redirect could send the device code to
   * another origin or downgrade to plain http. A refused redirect throws EnrollmentRefused, which polling does not
   * retry.
   */
  readonly redirect?: "follow" | "error"
  /**
   * The hub hands out an approved credential exactly once. With keepRedeemed, `signal` never aborts a poll request
   * in flight (its reply may carry that credential); it still stops polling before the next request.
   */
  readonly keepRedeemed?: boolean
}

/** The hub answered in a way the caller's policy refuses (a redirect under redirect: "error"); not retried. */
export class EnrollmentRefused extends Error {
  override readonly name = "EnrollmentRefused"
}

const REQUEST_TIMEOUT_MS = 15_000

async function post(server: string, path: string, body: unknown, options: EnrollOptions, abortable = true): Promise<unknown> {
  const doFetch = options.fetch ?? fetch
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal && abortable ? [options.signal] : [])]
  const strict = options.redirect === "error"
  const response = await doFetch(`${server.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
    ...(strict ? { redirect: "manual" as const } : {}),
  })
  if (strict && (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))) {
    throw new EnrollmentRefused(`${path} was redirected; enrollment does not follow redirects`)
  }
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
      reply = (await post(server, "/spoke/enroll/poll", { deviceCode: start.deviceCode }, options, !options.keepRedeemed)) as typeof reply
    } catch (cause) {
      if (cause instanceof EnrollmentRefused) throw cause
      continue
    }
    if (reply?.status === "approved" && typeof reply.machineID === "string" && typeof reply.machineToken === "string") {
      return { status: "approved", machineID: reply.machineID, machineToken: reply.machineToken }
    }
    if (reply?.status === "denied" || reply?.status === "expired") return { status: reply.status }
  }
}
