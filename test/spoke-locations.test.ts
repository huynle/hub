import { describe, expect, test } from "bun:test"
import { replyPermission, type PermissionLocation } from "../src/spoke/locations"

/** A fake OpenCode location: permission requests pending there, like ctx.permission of the plugin instance. */
function location(directory: string, pending: Record<string, string>, replies: string[]): PermissionLocation {
  const find = (input: { sessionID: string; requestID: string }) => {
    if (pending[input.requestID] !== input.sessionID) throw new Error(`Permission request not found: ${input.requestID}`)
    return { id: input.requestID }
  }
  return {
    directory,
    get: async (input) => find(input),
    reply: async (input) => {
      find(input)
      replies.push(`${directory} ${input.requestID} ${input.decision}`)
      delete pending[input.requestID]
    },
  }
}

describe("replyPermission (permissions are pending in the location that runs the session)", () => {
  test("replies through the plugin instance whose location holds the request, not the first one", async () => {
    const replies: string[] = []
    const a = location("/a", {}, replies)
    const b = location("/b", { per_1: "ses_child" }, replies)
    expect(await replyPermission([a, b], { sessionID: "ses_child", requestID: "per_1", decision: "once" })).toBe("replied")
    expect(replies).toEqual(["/b per_1 once"])
  })

  test("tries the session's own directory first", async () => {
    const replies: string[] = []
    const tried: string[] = []
    const spy = (l: PermissionLocation): PermissionLocation => ({ ...l, get: (input) => (tried.push(l.directory), l.get(input)) })
    const a = spy(location("/a", {}, replies))
    const b = spy(location("/b", { per_1: "ses_x" }, replies))
    await replyPermission([a, b], { sessionID: "ses_x", requestID: "per_1", decision: "reject" }, "/b")
    expect(tried).toEqual(["/b"])
  })

  test("a request no location holds (answered elsewhere, expired) is gone, not an error", async () => {
    const replies: string[] = []
    const a = location("/a", { per_other: "ses_x" }, replies)
    expect(await replyPermission([a], { sessionID: "ses_x", requestID: "per_1", decision: "once" })).toBe("gone")
    expect(await replyPermission([], { sessionID: "ses_x", requestID: "per_1", decision: "once" })).toBe("gone")
    expect(replies).toEqual([])
  })

  test("a failing reply where the request is pending is a real error", async () => {
    const broken: PermissionLocation = { directory: "/a", get: async () => ({}), reply: async () => Promise.reject(new Error("boom")) }
    await expect(replyPermission([broken], { sessionID: "ses_x", requestID: "per_1", decision: "once" })).rejects.toThrow("boom")
  })
})
