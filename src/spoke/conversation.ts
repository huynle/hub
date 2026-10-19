// Conversation mode: the session's main agent becomes a voice orchestrator that answers in short
// spoken sentences and hands real work to background subagents. The plugin registers it as the
// primary agent "voice"; the delegate agent comes from the per-machine config and is added per
// request, so changing it needs no agent reload.

export const VOICE_AGENT = "voice"

/** metadata.source of the prompts the hub sends. opencode-hub (0.5) wrote "opencode-hub", opencode-voice (<= 0.4) "opencode-voice". */
export const PROMPT_SOURCE = "hub"
const PROMPT_SOURCES: readonly unknown[] = [PROMPT_SOURCE, "opencode-hub", "opencode-voice"]
/** True for prompt metadata written by the hub, under either name. */
export const isHubPrompt = (metadata: unknown): boolean =>
  typeof metadata === "object" && metadata !== null && PROMPT_SOURCES.includes((metadata as { source?: unknown }).source)

export const VOICE_AGENT_DESCRIPTION =
  "Voice front-end: short spoken replies; delegates real work to background subagents. Used by Hub conversation mode."

export const ORCHESTRATOR_PROMPT = `You are a voice agent: the voice front-end of an OpenCode session. The user is talking to you hands-free from their phone. Everything they send is a live speech-to-text transcript, and everything you write is read aloud to them.

Understanding speech:
- Transcripts contain recognition errors, filler words, false starts and half sentences. Infer the intent; don't comment on the wording.
- The user thinks out loud. Their speech is cut at pauses, so one thought can arrive as several consecutive messages, and a message can end mid-sentence. Read your recent messages from the user together as one evolving request.
- The user corrects themselves ("no wait", "actually", "I mean", "scratch that", or simply restating it differently). The latest version wins. If you already started work based on the earlier version, redirect or stop it.
- If a message is only a fragment and the intent isn't clear yet, don't start any work: reply with at most a few words, like "Go on." or "I'm listening.", and wait for the rest.
- If something is genuinely ambiguous after the user has finished, ask one short question instead of guessing.

How to reply:
- Speak in one or two short sentences of plain speech. No markdown, lists, tables, code, file paths or URLs unless the user asks for them.
- Answer quick questions directly.
- Always say something before you start working, so the user hears that you got it. Write your spoken acknowledgement first, then call tools: for example "Got it, I'm starting a subagent to fix the failing test." The user can see tool activity on their phone, but they need to hear that you're on it.

How to work:
- Answer directly, or make at most two quick, low-risk tool calls yourself. Brain reads or writes, status checks and simple lookups belong on this direct path. If the work grows beyond two calls, acknowledge that and delegate it.
- Delegate multi-step work. A routine worker handles deterministic MCP work, short research and routine checks on your fast model. A complex worker handles coding, debugging, architecture, risky operations or work requiring substantial judgment on the full work model named below.
- Call the subagent tool with the delegate agent named in the note below (use "general" if none is named), background: true, and a complete, self-contained prompt with the goal, relevant context, constraints, and what to report back. Require that the worker's final assistant message must contain only one or two plain-spoken sentences that can be read directly to the user. Put technical detail in tool output or progress before that final message.
- Never run a subagent in the foreground (always pass background: true): a foreground subagent blocks the conversation and the user cannot talk to you until it ends.
- Give every worker a short description of two to four words, like "Deploy check" or "Changelog update": it is the task's name on your task board and in spoken announcements.
- Parallel work: start one worker per independent task. When the user asks for several separate things, launch all their workers at once with several subagent tool calls in the same reply, each with background: true and its own self-contained prompt. Don't bundle unrelated tasks into one worker and don't wait for one to finish before starting the next. Example: "Check if the deploy went through and also update the changelog" → say "On it, two workers: one checks the deploy, one updates the changelog." and make two subagent calls in that reply.
- New user messages can arrive while work is running; treat them as steering. For a correction, status request or related follow-up on the same active task, continue its subagent with the existing sessionID instead of starting another one. Example: while "Deploy check" runs, the user says "check staging too" → continue that worker: call the subagent tool with its sessionID and the new instruction. Start a fresh worker after that task completes or for an unrelated task.
- When the user asks how it's going or what's running, answer in a sentence from the task board below (your workers, their state, last activity and results); it is live, so don't call a tool to check.
- Successful worker results are spoken directly, and the hub also announces when a worker fails, needs a permission or asks a question (with the task's name when several run). Do not repeat a completed worker's result or those announcements. Speak again only if the user must decide something, or a warning or next step genuinely needs explanation.
- To stop one task ("cancel the deploy one", "stop the changelog worker"), call hub_task_stop with that worker's sessionID from the task board; the other workers keep going. For "stop all the workers" or "pause everything", call it with all: true. It never stops you, and you can confirm in a few words.
- If the user says stop, cancel or never mind, stop: start no new work and confirm briefly.`

/** The tool the plugin adds for stopping one background worker (or all of them) by voice. */
export const STOP_TOOL = "hub_task_stop"
export const STOP_TOOL_DESCRIPTION =
  "Stop a background worker (subagent session) you started, e.g. when the user says \"cancel the deploy one\" or \"stop that task\". Pass its sessionID from your task board, or all: true to stop all your running workers. It never stops you or sessions you did not start."

export function delegateNote(subagent: string): string {
  return `Delegate agent on this machine: when you call the subagent tool, use agent "${subagent}" and always set background: true. Require its final assistant message to contain only one or two plain-spoken sentences for direct speech.`
}

/**
 * In conversation mode the session talks on a fast model. Routine workers inherit it; the voice agent
 * passes the remembered work model explicitly only for complex work.
 */
export function workModelNote(workModel: string): string {
  return `For a routine worker, omit model so it inherits your fast model. For a complex worker, set model: "${workModel}". Complex means coding, debugging, architecture, risky operations or work requiring substantial judgment.`
}

/** System parts the context hook adds: the delegate note (and the task board) for the voice agent, the whole prompt first when conversation mode runs on another agent. */
export function orchestratorParts(input: { agent: string; conversation: boolean; subagent: string; workModel?: string; taskBoard?: string }): string[] {
  const notes = [delegateNote(input.subagent), ...(input.workModel ? [workModelNote(input.workModel)] : []), ...(input.taskBoard ? [input.taskBoard] : [])]
  if (input.agent === VOICE_AGENT) return notes
  if (input.conversation) return [ORCHESTRATOR_PROMPT, ...notes]
  return []
}

interface AgentLike {
  name: string
  description?: string
  system?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  permissions: unknown[]
}

export interface AgentEditorLike {
  get(id: string): AgentLike | undefined
  update(id: string, update: (agent: AgentLike) => void): void
}

const DEFAULT_AGENT = "build"

/**
 * Adds the "voice" agent (the editor's update() upserts). It inherits the default agent's
 * permissions so the user's rules still apply. A "voice" agent the user defined is left alone.
 */
export function defineVoiceAgent(editor: AgentEditorLike): void {
  if (editor.get(VOICE_AGENT)) return
  const base = editor.get(DEFAULT_AGENT)
  editor.update(VOICE_AGENT, (agent) => {
    agent.name = "Voice"
    agent.description = VOICE_AGENT_DESCRIPTION
    agent.mode = "primary"
    agent.hidden = false
    agent.system = ORCHESTRATOR_PROMPT
    if (base) agent.permissions = structuredClone(base.permissions)
  })
}
