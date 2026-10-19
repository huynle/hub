import { describe, expect, test } from "bun:test"
import { defineVoiceAgent, delegateNote, isHubPrompt, ORCHESTRATOR_PROMPT, orchestratorParts, PROMPT_SOURCE, VOICE_AGENT } from "../src/spoke/conversation"

type Agent = { id: string; name: string; mode: string; hidden: boolean; system?: string; description?: string; permissions: unknown[] }

/** Mirrors core's agent editor: update() upserts with defaults, then applies the change. */
function fakeEditor(initial: Agent[] = []) {
  const agents = new Map(initial.map((a) => [a.id, structuredClone(a)]))
  return {
    agents,
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    update: (id: string, fn: (a: Agent) => void) => {
      const current = agents.get(id) ?? { id, name: id, mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] }
      agents.set(id, current)
      fn(current)
    },
  }
}

describe("orchestrator prompt", () => {
  test("covers spoken replies and background delegation", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("read aloud")
    expect(ORCHESTRATOR_PROMPT).toContain("subagent tool")
    expect(ORCHESTRATOR_PROMPT).toContain("background: true")
    expect(ORCHESTRATOR_PROMPT).toContain("sessionID")
    expect(ORCHESTRATOR_PROMPT.toLowerCase()).toContain("stop")
    expect(delegateNote("tdd-dev")).toContain('agent "tdd-dev"')
  })

  test("insists on background subagents (models tend to drop the flag)", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("Never run a subagent in the foreground")
    expect(delegateNote("general")).toContain("always")
    expect(delegateNote("general")).toContain("background: true")
  })

  test("routes quick tools directly and workers by complexity", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("at most two")
    expect(ORCHESTRATOR_PROMPT).toContain("quick, low-risk tool")
    expect(ORCHESTRATOR_PROMPT).toContain("routine worker")
    expect(ORCHESTRATOR_PROMPT).toContain("complex worker")
  })

  test("reuses only the active task and makes worker results speech-ready without repetition", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("same active task")
    expect(ORCHESTRATOR_PROMPT).toContain("final assistant message must contain only")
    expect(ORCHESTRATOR_PROMPT).toContain("one or two plain-spoken sentences")
    expect(ORCHESTRATOR_PROMPT).toContain("Do not repeat")
    expect(delegateNote("general")).toContain("final assistant message")
  })

  test("launches independent requests as parallel background workers in one turn, with examples", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("Parallel work")
    expect(ORCHESTRATOR_PROMPT).toContain("several subagent tool calls in the same reply")
    expect(ORCHESTRATOR_PROMPT).toContain("one worker per independent task")
    expect(ORCHESTRATOR_PROMPT).toMatch(/Example: .*two workers/)
    expect(ORCHESTRATOR_PROMPT).toContain("short description")
    // Follow-ups still go to the same worker.
    expect(ORCHESTRATOR_PROMPT).toMatch(/Example: .*continue .*sessionID/)
  })

  test("keeps the direct path and the routine/complex split", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("at most two quick, low-risk tool calls")
    expect(ORCHESTRATOR_PROMPT).toContain("A routine worker")
    expect(ORCHESTRATOR_PROMPT).toContain("A complex worker")
    expect(ORCHESTRATOR_PROMPT).toContain("Never run a subagent in the foreground")
  })

  test("the voice agent gets only the delegate note; a conversation on another agent gets the full prompt", () => {
    expect(orchestratorParts({ agent: VOICE_AGENT, conversation: true, subagent: "general" })).toEqual([delegateNote("general")])
    expect(orchestratorParts({ agent: VOICE_AGENT, conversation: false, subagent: "x" })).toEqual([delegateNote("x")])
    expect(orchestratorParts({ agent: "build", conversation: true, subagent: "general" })).toEqual([ORCHESTRATOR_PROMPT, delegateNote("general")])
    expect(orchestratorParts({ agent: "build", conversation: false, subagent: "general" })).toEqual([])
  })
})

describe("defineVoiceAgent", () => {
  test("adds a primary voice agent that inherits the default agent's permissions", () => {
    const rules = [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "rm *", effect: "ask" }]
    const editor = fakeEditor([{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: rules }])
    defineVoiceAgent(editor as any)
    const voice = editor.get(VOICE_AGENT)!
    expect(voice).toMatchObject({ name: "Voice", mode: "primary", hidden: false, system: ORCHESTRATOR_PROMPT })
    expect(voice.description).toBeTruthy()
    expect(voice.permissions).toEqual(rules)
    voice.permissions.push("mutated")
    expect(editor.get("build")!.permissions).toHaveLength(2)
  })

  test("keeps the core defaults when there is no build agent", () => {
    const editor = fakeEditor()
    defineVoiceAgent(editor as any)
    expect(editor.get(VOICE_AGENT)!.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  })

  test("leaves a user-defined voice agent untouched", () => {
    const mine: Agent = { id: VOICE_AGENT, name: "Mine", mode: "all", hidden: false, system: "custom", description: "mine", permissions: [] }
    const editor = fakeEditor([mine])
    defineVoiceAgent(editor as any)
    expect(editor.get(VOICE_AGENT)).toEqual(mine)
  })
})

describe("work model note", () => {
  test("reserves the work model for complex subagent calls", () => {
    const { orchestratorParts } = require("../src/spoke/conversation")
    const parts = orchestratorParts({ agent: "voice", conversation: true, subagent: "general", workModel: "anthropic/claude-opus-5-5" })
    expect(parts.join("\n")).toContain('model: "anthropic/claude-opus-5-5"')
    expect(parts.join("\n")).toContain("complex")
    expect(parts.join("\n")).toContain("omit model")
    expect(orchestratorParts({ agent: "voice", conversation: true, subagent: "general" }).join("\n")).not.toContain("model:")
  })
})

describe("prompt source", () => {
  test("the hub tags its prompts hub and recognizes the legacy opencode-hub and opencode-voice tags", () => {
    expect(PROMPT_SOURCE).toBe("hub")
    expect(isHubPrompt({ source: "hub", mode: "remote" })).toBe(true)
    expect(isHubPrompt({ source: "opencode-hub", mode: "remote" })).toBe(true)
    expect(isHubPrompt({ source: "opencode-voice" })).toBe(true)
    expect(isHubPrompt({ source: "tui" })).toBe(false)
    expect(isHubPrompt(undefined)).toBe(false)
    expect(isHubPrompt("opencode-hub")).toBe(false)
  })
})
