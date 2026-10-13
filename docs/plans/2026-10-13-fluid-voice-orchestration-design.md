# Fluid voice orchestration

## Goal

Make conversation mode feel faster without replacing OpenCode's worker orchestration or weakening its
permission model. Quick requests should avoid unnecessary worker startup, routine delegated work should
use the fast voice model, related follow-ups should continue the active worker, and successful worker
results should reach text-to-speech without a second voice-agent summarization turn.

## Current latency

A delegated voice request can require speech-to-text, a voice-agent turn, worker startup and model turns,
the worker's tools, a second voice-agent turn that summarizes completion, and text-to-speech. Simple Brain
or MCP operations pay most of that cost even when the tool call itself is fast. The current prompt also
forces every worker onto the full work model.

## Routing policy

The voice agent uses three lanes:

1. **Direct:** answer immediately or use at most two quick, low-risk tools. Examples include Brain reads
   and writes, status checks, and simple lookups. If a direct task grows, acknowledge that and delegate it.
2. **Routine worker:** start the configured background subagent without an explicit model, which inherits
   the fast voice model. Use this for short research, deterministic MCP work, and routine checks.
3. **Complex worker:** explicitly pass the configured work model for coding, debugging, architecture,
   risky operations, or work requiring substantial judgment.

Workers always run in the background. Corrections, steering, status requests, and related follow-ups
continue the same active worker with its `sessionID`. A completed task or an unrelated request starts a
fresh worker. Every voice-started worker's final assistant message contains only one or two plain-spoken
sentences; technical detail remains available in earlier progress and the activity feed.

## Direct worker speech

The spoke already forwards child `session.text.ended` and `session.execution.*` events. The hub extends
that pipeline rather than adding a separate task service:

1. Retain the latest completed assistant text for each child session under a conversation-mode root.
2. Pair that text with `session.execution.succeeded`, accepting either event order.
3. Emit one deduplicated `say` event addressed to the root session.
4. Keep the original child text and activity events unchanged for visual inspection.
5. Clear buffered state after emission, when a new execution begins, when the session disappears, when
   conversation mode ends, or when the entry expires.

Only successful child executions are spoken directly. Failed, interrupted, or blocked workers retain the
existing status cues and let the voice agent explain the failure or ask for input. Concurrent completions
are emitted in arrival order and serialized by the phone's existing speech queue. Existing barge-in
continues to stop playback.

The voice prompt tells the root agent not to repeat a worker result that was already prepared for direct
speech. It may still speak when a decision, warning, failure, or next step needs a response.

## Boundaries and safety

No new tools or permissions are granted. The voice agent retains the default agent's permission rules.
Worker-speech state is tenant-local, bounded, and ephemeral: child session ID, root ID, message identity,
latest text, and completion state only. The hub emits worker speech only when the root is in conversation
mode and the child belongs to that root's reported session tree.

Text still passes through the existing `/api/speak` path and `speakable()` cleanup, which flattens
Markdown, omits code blocks, normalizes links, and enforces the configured character cap.

This change does not implement custom context compaction or automatic session rollover. Those are
OpenCode-level concerns and can disrupt the selected work session. Restricting worker reuse to one active
task prevents indefinite child-context growth.

## Alternatives considered

- **Prompt-only optimization:** simplest and useful for direct tools and model routing, but leaves the
  second voice-agent completion turn in place.
- **Plugin-owned task router:** deterministic and flexible, but duplicates OpenCode orchestration and
  couples the plugin to more internal APIs.
- **Prompt routing plus event-based worker speech (chosen):** removes the unnecessary completion turn
  while preserving OpenCode as the worker manager and reusing the existing event and speech paths.

## Error handling

- Text without a matching successful execution is never spoken as a completed result.
- A success without text waits for the matching child text until expiry.
- Duplicate reports from multiple spokes produce one `say` event.
- New child execution invalidates stale buffered text.
- Turning conversation mode off drops pending direct-speech state.
- Failure, interruption, deletion, and expiry clear pending state without presenting partial text as a
  successful result.

## Verification

- Prompt contract tests cover the two-tool limit, complexity routing, same-task reuse, speech-ready worker
  output, background-only workers, and non-repetition.
- Hub tests cover text-before-success, success-before-text, deduplication, concurrent children, cleanup,
  and routing to the root session.
- Negative tests cover failed, interrupted, unrelated, root, and non-conversation sessions.
- Run TypeScript typechecking and the complete test suite.
- Load the packaged plugin in a private OpenCode server and verify it becomes active without touching the
  shared service.
