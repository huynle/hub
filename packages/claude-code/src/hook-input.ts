// The stdin JSON of a Claude Code hook (shapes recorded by the P7-T0 spike, Brain report v0hsdqhm). Every input
// carries session_id (a UUID), transcript_path, cwd and hook_event_name; the rest depends on the event. Input that is
// not a hook input of a Claude Code session is refused before anything uses it.

/** Claude Code hook input: the common fields checked, the event's own fields kept as they came. */
export interface HookInput {
  readonly session_id: string
  readonly hook_event_name: string
  readonly cwd?: string
  readonly transcript_path?: string
  readonly prompt_id?: string
  readonly prompt?: string
  readonly source?: string
  readonly reason?: string
  readonly tool_name?: string
  readonly tool_input?: unknown
  readonly tool_use_id?: string
  readonly tool_response?: unknown
  readonly permission_suggestions?: unknown
  readonly notification_type?: string
  readonly message?: string
  readonly stop_hook_active?: boolean
  readonly last_assistant_message?: string
  readonly error?: unknown
  readonly error_details?: unknown
  readonly agent_id?: string
  readonly agent_type?: string
  readonly [key: string]: unknown
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT = /^[A-Za-z]{1,64}$/
const OPTIONAL_STRINGS = ["cwd", "transcript_path", "prompt_id", "prompt", "source", "reason", "tool_name", "tool_use_id", "notification_type", "message", "last_assistant_message", "agent_id", "agent_type"] as const

/** The hook input, or undefined when `raw` is not one. */
export function parseHookInput(raw: unknown): HookInput | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.session_id !== "string" || !UUID.test(r.session_id)) return undefined
  if (typeof r.hook_event_name !== "string" || !EVENT.test(r.hook_event_name)) return undefined
  for (const key of OPTIONAL_STRINGS) if (r[key] !== undefined && typeof r[key] !== "string") return undefined
  if (r.stop_hook_active !== undefined && typeof r.stop_hook_active !== "boolean") return undefined
  return r as HookInput
}
