// Background jobs (shells and terminals) and retries of a session tree, as the console shows them.
import { describe, expect, test } from "bun:test"
import { ENDED_SHOWN_MS, jobLabel, jobsBadge, retryText, runningJobs, treeJobs } from "../web/src/core/jobs-core"

const status = [
  { id: "ses_root", title: "Main", state: "working", jobs: [{ id: "sh_1", kind: "shell", command: "sleep 60", status: "running", started: 1000 }] },
  {
    id: "ses_kid",
    parentID: "ses_root",
    title: "build",
    state: "idle",
    jobs: [
      { id: "sh_2", kind: "shell", command: "make", status: "exited", exit: 0, started: 1000, ended: 5000 },
      { id: "sh_3", kind: "shell", command: "old", status: "exited", exit: 1, started: -200000, ended: -100000 },
      { id: "pty_1", kind: "pty", command: "htop", status: "running", started: 3000 },
    ],
  },
]

describe("jobs", () => {
  test("runningJobs counts running jobs over the whole tree", () => {
    expect(runningJobs(status)).toBe(2)
    expect(runningJobs(undefined)).toBe(0)
    expect(runningJobs([{ id: "x", state: "idle" }])).toBe(0)
  })

  test("treeJobs lists running jobs (oldest first), then recently ended ones (newest first), with their session", () => {
    const jobs = treeJobs(status, 6000)
    expect(jobs.map((j) => `${j.id}:${j.sessionTitle}`)).toEqual(["sh_1:Main", "pty_1:build", "sh_2:build"])
    // sh_2 ended at 5000: gone after ENDED_SHOWN_MS.
    expect(treeJobs(status, 5000 + ENDED_SHOWN_MS + 1).map((j) => j.id)).toEqual(["sh_1", "pty_1"])
  })

  test("jobLabel: duration while running; exit code or how it ended after", () => {
    const [running, , ended] = treeJobs(status, 6000)
    expect(jobLabel(running!, 1000 + 125_000)).toBe("running · 2m 5s")
    expect(jobLabel(ended!, 6000)).toBe("exit 0 · 4s")
    expect(jobLabel({ id: "k", sessionID: "s", sessionTitle: "", kind: "shell", status: "killed" }, 0)).toBe("killed")
    expect(jobLabel({ id: "t", sessionID: "s", sessionTitle: "", kind: "shell", status: "timeout", exit: 124 }, 0)).toBe("timed out · exit 124")
  })

  test("jobsBadge", () => {
    expect(jobsBadge(0)).toBe("")
    expect(jobsBadge(1)).toBe("1 job")
    expect(jobsBadge(3)).toBe("3 jobs")
  })

  test("retryText: the session's own retry reason, else the first retrying session in the tree", () => {
    const retrying = [
      { id: "ses_root", state: "working" },
      { id: "ses_kid", state: "working", retry: { attempt: 2, message: "Rate limited" } },
    ]
    expect(retryText(retrying)).toBe("Retrying (attempt 2): Rate limited")
    expect(retryText([{ id: "a", state: "working", retry: {} }], "a")).toBe("Retrying")
    expect(retryText(status)).toBeUndefined()
  })

  test("retryText: the error type's label and a countdown to the next attempt (none once it is past)", () => {
    const now = 1_000_000
    const retrying = [{ id: "a", state: "working", retry: { attempt: 3, message: "You exceeded your quota", errorType: "provider.quota", errorStatus: 429, next: now + 250_000 } }]
    expect(retryText(retrying, "a", now)).toBe("Retrying (attempt 3) · next in 4m 10s: Quota exceeded — You exceeded your quota")
    expect(retryText(retrying, "a", now + 300_000)).toBe("Retrying (attempt 3): Quota exceeded — You exceeded your quota")
    expect(retryText([{ id: "a", state: "working", retry: { attempt: 1, errorType: "provider.rate-limit" } }], "a", now)).toBe("Retrying (attempt 1): Rate limited")
  })
})
