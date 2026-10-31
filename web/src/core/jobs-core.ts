// Background jobs (shells and terminals sessions started, e.g. a `sleep 60 &` or a build script) and model
// retries of a session tree, from the status tree the hub sends (StatusBoard `jobs` / `retry`). Pure.
import { retryLine, type RetryInfo } from "./error-core"

export interface JobView {
  readonly id: string
  readonly sessionID: string
  readonly sessionTitle: string
  readonly kind: string
  readonly command?: string
  readonly status: string
  readonly exit?: number
  readonly started?: number
  readonly ended?: number
}

/** Ended jobs stay listed this long (with their exit code). */
export const ENDED_SHOWN_MS = 60_000

interface StatusLike {
  readonly id: string
  readonly title?: string
  readonly state?: string
  readonly retry?: RetryInfo
  readonly jobs?: ReadonlyArray<Omit<JobView, "sessionID" | "sessionTitle">>
}

const entries = (status: unknown): StatusLike[] => (Array.isArray(status) ? (status as StatusLike[]) : [])

function all(status: unknown): JobView[] {
  return entries(status).flatMap((s) =>
    (Array.isArray(s.jobs) ? s.jobs : []).map((job) => ({ ...job, sessionID: s.id, sessionTitle: s.title ?? "" })),
  )
}

/** Running jobs over the whole tree. */
export function runningJobs(status: unknown): number {
  return all(status).filter((job) => job.status === "running").length
}

/** Running jobs (oldest first), then jobs that ended within ENDED_SHOWN_MS (newest first). */
export function treeJobs(status: unknown, now: number): JobView[] {
  const jobs = all(status)
  const running = jobs.filter((j) => j.status === "running").sort((a, b) => (a.started ?? 0) - (b.started ?? 0))
  const ended = jobs
    .filter((j) => j.status !== "running" && j.ended !== undefined && now - j.ended <= ENDED_SHOWN_MS)
    .sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0))
  return [...running, ...ended]
}

/** "2m 5s", "4s", "1h 3m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "running · 2m 5s", "exit 0 · 4s", "killed", "timed out · exit 124". */
export function jobLabel(job: JobView, now: number): string {
  if (job.status === "running") return job.started !== undefined ? `running · ${duration(now - job.started)}` : "running"
  const how = job.status === "killed" ? "killed" : job.status === "timeout" ? "timed out" : undefined
  const exit = job.exit !== undefined ? `exit ${job.exit}` : undefined
  const took = job.started !== undefined && job.ended !== undefined ? duration(job.ended - job.started) : undefined
  if (how) return [how, exit].filter(Boolean).join(" · ")
  return [exit ?? "ended", took].filter(Boolean).join(" · ")
}

export function jobsBadge(n: number): string {
  return n <= 0 ? "" : `${n} job${n === 1 ? "" : "s"}`
}

/**
 * The session's retry ("Retrying (attempt 2) · next in 4m 10s: Rate limited"), else the first retrying session's
 * in the tree. The countdown to the next attempt shows while it is ahead of `now`.
 */
export function retryText(status: unknown, sessionID?: string, now = Date.now()): string | undefined {
  const list = entries(status)
  const entry = (sessionID ? list.find((s) => s.id === sessionID && s.retry) : undefined) ?? list.find((s) => s.retry)
  return entry?.retry ? retryLine(entry.retry, now) : undefined
}
