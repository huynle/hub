// Normalising Claude Code's hook input for the hub: tool names become hub permission actions (decision fx04e42c
// point 4: Bash → shell, Edit/Write → edit, Read → read, mcp__s__t → s_t), tool inputs become short resources and
// summaries (never the whole input), native IDs become hub IDs, and hook stdin is checked before anything uses it.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { HARNESS_RESOURCE_MAX, HARNESS_SUMMARY_MAX, isHubSessionID } from "../../protocol/src/index.ts"
import { nativeSessionID } from "../../spoke-sdk/src/index.ts"
import { childSessionID, claudeSessionID, plainID } from "../src/ids.ts"
import { parseHookInput } from "../src/hook-input.ts"
import { permissionAction, permissionRequest, toolSummary } from "../src/tools.ts"

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8"))
const SID = "fdcdc49e-c7ea-4b8a-886d-7c5d3dbde164"

describe("permission actions", () => {
  test("map Claude Code tool names to the hub's vocabulary", () => {
    expect(permissionAction("Bash")).toBe("shell")
    expect(permissionAction("Edit")).toBe("edit")
    expect(permissionAction("Write")).toBe("edit")
    expect(permissionAction("MultiEdit")).toBe("edit")
    expect(permissionAction("NotebookEdit")).toBe("edit")
    expect(permissionAction("Read")).toBe("read")
    expect(permissionAction("mcp__github__create_issue")).toBe("github_create_issue")
    expect(permissionAction("mcp__plugin_hub_hub__msg")).toBe("plugin_hub_hub_msg")
    expect(permissionAction("WebFetch")).toBe("webfetch")
    expect(permissionAction("")).toBe("unknown")
  })

  test("a request carries what it applies to (the command, the file) and the rules an always reply saves", () => {
    const req = fixture("permission-request")
    expect(permissionRequest(req.tool_name, req.tool_input, req.permission_suggestions)).toEqual({ action: "shell", resources: ["echo hi-from-bash; echo ENVV=$SPIKEVAR"] })
    expect(permissionRequest("Edit", { file_path: "/work/a.ts", old_string: "x", new_string: "y" }, undefined)).toEqual({ action: "edit", resources: ["/work/a.ts"] })
    expect(permissionRequest("Read", { file_path: "/etc/hosts" }, undefined).resources).toEqual(["/etc/hosts"])
    expect(permissionRequest("WebFetch", { url: "https://example.com", prompt: "p" }, undefined).resources).toEqual(["https://example.com"])
    const saved = permissionRequest("Bash", { command: "npm test" }, [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
      { type: "addDirectories", directories: ["/work/x"], destination: "session" },
    ])
    expect(saved.save).toEqual(["Bash(npm test:*)"])
  })

  test("resources are bounded and never the whole tool input", () => {
    const long = "x".repeat(HARNESS_RESOURCE_MAX + 50)
    const { resources } = permissionRequest("Bash", { command: long }, undefined)
    expect(resources[0]!.length).toBeLessThanOrEqual(HARNESS_RESOURCE_MAX)
    const mcp = permissionRequest("mcp__db__query", { sql: "select 1", secret: "S3CRET" }, undefined)
    expect(mcp.action).toBe("db_query")
    expect(JSON.stringify(mcp)).not.toContain("S3CRET")
  })
})

describe("tool summaries", () => {
  test("are short: the command or path's first line, at most the summary limit", () => {
    expect(toolSummary("Bash", { command: "echo hi\necho there" })).toBe("echo hi")
    expect(toolSummary("Read", { file_path: "/work/a.ts" })).toBe("/work/a.ts")
    expect(toolSummary("Bash", { command: "y".repeat(500) })!.length).toBeLessThanOrEqual(HARNESS_SUMMARY_MAX)
    expect(toolSummary("TodoWrite", { todos: [] })).toBeUndefined()
  })
})

describe("IDs", () => {
  test("a Claude Code session UUID maps to a reversible ses_cc hub ID", () => {
    const id = claudeSessionID(SID)
    expect(id).toBe("ses_ccfdcdc49ec7ea4b8a886d7c5d3dbde164")
    expect(nativeSessionID("cc", id)).toBe(SID)
  })

  test("a subagent gets its own child hub ID, stable and distinct per agent", () => {
    const child = childSessionID(SID, "a1b2c3d4")
    expect(isHubSessionID(child)).toBe(true)
    expect(child).toBe(childSessionID(SID, "a1b2c3d4"))
    expect(child).not.toBe(childSessionID(SID, "a1b2c3d5"))
    expect(child).not.toBe(claudeSessionID(SID))
    expect(isHubSessionID(childSessionID(SID, "z".repeat(200)))).toBe(true)
  })

  test("plain IDs keep allowed characters and are never empty or too long", () => {
    expect(plainID("toolu_stub5")).toBe("toolu_stub5")
    expect(plainID("bad id!\n")).toBe("bad_id__")
    expect(plainID("", "tool")).toMatch(/^tool_[0-9a-f]+$/)
    expect(plainID("a".repeat(400)).length).toBeLessThanOrEqual(300)
  })
})

describe("hook input", () => {
  test("every spike fixture parses, keeping its fields", () => {
    for (const name of ["session-start", "user-prompt-submit", "pre-tool-use", "permission-request", "post-tool-use", "stop", "session-end", "notification-permission", "subagent-start"]) {
      const input = parseHookInput(fixture(name))
      expect(input?.session_id).toBe(SID)
      expect(input?.hook_event_name).toBe(fixture(name).hook_event_name)
    }
    expect(parseHookInput(fixture("pre-tool-use"))?.tool_input).toEqual(fixture("pre-tool-use").tool_input)
  })

  test("refuses what is not a hook input of a Claude Code session", () => {
    expect(parseHookInput(null)).toBeUndefined()
    expect(parseHookInput("x")).toBeUndefined()
    expect(parseHookInput({ hook_event_name: "Stop" })).toBeUndefined()
    expect(parseHookInput({ session_id: SID })).toBeUndefined()
    expect(parseHookInput({ session_id: "not a uuid", hook_event_name: "Stop" })).toBeUndefined()
    expect(parseHookInput({ session_id: SID, hook_event_name: "Stop", cwd: 7 })).toBeUndefined()
  })
})
