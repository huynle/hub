import { describe, expect, test } from "bun:test"
import { listServiceSessions, workspaceOf, type ListingClient } from "../src/spoke/listing"

type Raw = {
  id: string
  title?: string
  parentID?: string
  projectID: string
  subpath?: string
  location: { directory: string }
  time: { updated: number; archived?: number }
}

const raw = (id: string, extra: Partial<Raw> = {}): Raw => ({
  id,
  title: `T ${id}`,
  projectID: "p_voice",
  location: { directory: "/u/voice" },
  time: { updated: 100 },
  ...extra,
})

const PROJECTS = [
  { id: "p_voice", canonical: "/u/voice" },
  { id: "p_webshop", canonical: "/u/webshop", name: "Web Shop" },
  { id: "global", canonical: "/" },
]

/** A fake client paging `sessions` (already newest first) `pageSize` at a time. */
function fakeClient(sessions: Raw[], options: { pageSize?: number; projects?: unknown[]; projectsFail?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const client: ListingClient = {
    session: {
      list: async (input) => {
        calls.push({ ...input })
        const size = Math.min(input.limit ?? 50, options.pageSize ?? 1000)
        const start = input.cursor ? Number(input.cursor) : 0
        const roots = input.parentID === null ? sessions.filter((s) => !s.parentID) : sessions
        const data = roots.slice(start, start + size)
        const next = start + size < roots.length ? String(start + size) : null
        return { data, cursor: { next } }
      },
    },
    project: {
      list: async () => {
        if (options.projectsFail) throw new Error("no projects")
        return (options.projects ?? PROJECTS) as any
      },
    },
  }
  return { client, calls }
}

describe("workspaceOf", () => {
  const byID = new Map(PROJECTS.map((p) => [p.id, p]))

  test("uses the project's canonical directory and name, else the directory's basename", () => {
    expect(workspaceOf(raw("a", { projectID: "p_webshop", location: { directory: "/u/webshop/.worktrees/x" } }), byID)).toEqual({
      project: "/u/webshop",
      projectName: "Web Shop",
    })
    expect(workspaceOf(raw("a"), byID)).toEqual({ project: "/u/voice", projectName: "voice" })
  })

  test("falls back to the directory minus its subpath for unknown projects and the global project", () => {
    expect(workspaceOf(raw("a", { projectID: "global", location: { directory: "/tmp/scratch" } }), byID)).toEqual({
      project: "/tmp/scratch",
      projectName: "scratch",
    })
    expect(
      workspaceOf(raw("a", { projectID: "nope", subpath: "packages/app", location: { directory: "/u/mono/packages/app" } }), byID),
    ).toEqual({ project: "/u/mono", projectName: "mono" })
    // A subpath that does not match the directory's tail is ignored.
    expect(workspaceOf(raw("a", { projectID: "nope", subpath: "other", location: { directory: "/u/mono/app" } }), byID)).toEqual({
      project: "/u/mono/app",
      projectName: "app",
    })
  })
})

describe("listServiceSessions", () => {
  test("returns root, non-archived sessions with their workspace", async () => {
    const { client, calls } = fakeClient([
      raw("ses_a", { time: { updated: 300 } }),
      raw("ses_kid", { parentID: "ses_a" }),
      raw("ses_old", { time: { updated: 200, archived: 250 } }),
      raw("ses_b", { title: undefined, projectID: "p_webshop", location: { directory: "/u/webshop/.worktrees/w" }, time: { updated: 100 } }),
    ])
    const sessions = await listServiceSessions(client)
    expect(sessions).toEqual([
      { id: "ses_a", title: "T ses_a", directory: "/u/voice", updated: 300, project: "/u/voice", projectName: "voice" },
      { id: "ses_b", title: "", directory: "/u/webshop/.worktrees/w", updated: 100, project: "/u/webshop", projectName: "Web Shop" },
    ])
    expect(calls[0]).toMatchObject({ parentID: null })
  })

  test("pages through the cursor up to the maximum", async () => {
    const many = Array.from({ length: 30 }, (_, i) => raw(`ses_${String(i).padStart(2, "0")}`, { time: { updated: 1000 - i } }))
    const { client, calls } = fakeClient(many, { pageSize: 7 })
    const sessions = await listServiceSessions(client, { max: 20, pageSize: 7 })
    expect(sessions.map((s) => s.id)).toEqual(many.slice(0, 20).map((s) => s.id))
    expect(calls.length).toBe(3)
    expect(calls[1]!.cursor).toBe("7")
  })

  test("stops after the page limit even when every session is filtered out", async () => {
    const archived = Array.from({ length: 50 }, (_, i) => raw(`ses_${i}`, { time: { updated: 1, archived: 2 } }))
    const { client, calls } = fakeClient(archived, { pageSize: 5 })
    expect(await listServiceSessions(client, { max: 10, pageSize: 5, maxPages: 4 })).toEqual([])
    expect(calls.length).toBe(4)
  })

  test("without a project list, workspaces come from the directories", async () => {
    const { client } = fakeClient([raw("ses_a", { subpath: "web", location: { directory: "/u/voice/web" } })], { projectsFail: true })
    expect(await listServiceSessions(client)).toEqual([
      { id: "ses_a", title: "T ses_a", directory: "/u/voice/web", updated: 100, project: "/u/voice", projectName: "voice" },
    ])
  })
})
