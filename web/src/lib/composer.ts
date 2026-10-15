// Composer state: the draft, submissions in flight, the last error and a stop in flight. The primary action is
// Send while the session's tree is idle and Steer while it runs (the hub routes typed input either way); Stop
// shows while the tree runs. A submission clears the draft at once; if the hub refuses it, its text comes back.

export interface ComposerState {
  readonly draft: string
  readonly pending: ReadonlyArray<{ readonly id: number; readonly text: string }>
  readonly error?: string
  readonly stopping: boolean
}

export type ComposerAction =
  | { type: "input"; text: string }
  | { type: "submit"; id: number }
  | { type: "accepted"; id: number }
  | { type: "rejected"; id: number; message: string }
  | { type: "stop" }
  | { type: "stopped" }

export interface ComposerView {
  readonly primary: "send" | "steer"
  readonly canSubmit: boolean
  readonly showStop: boolean
  readonly canStop: boolean
  readonly hint?: string
}

export const initialComposer = (): ComposerState => ({ draft: "", pending: [], stopping: false })

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "input":
      return { ...state, draft: action.text, error: undefined }
    case "submit": {
      const text = state.draft.trim()
      if (!text) return state
      return { ...state, draft: "", pending: [...state.pending, { id: action.id, text }], error: undefined }
    }
    case "accepted": {
      if (!state.pending.some((p) => p.id === action.id)) return state
      return { ...state, pending: state.pending.filter((p) => p.id !== action.id) }
    }
    case "rejected": {
      const entry = state.pending.find((p) => p.id === action.id)
      if (!entry) return state
      return {
        ...state,
        draft: state.draft ? `${entry.text}\n${state.draft}` : entry.text,
        pending: state.pending.filter((p) => p.id !== action.id),
        error: action.message,
      }
    }
    case "stop":
      return { ...state, stopping: true }
    case "stopped":
      return { ...state, stopping: false }
  }
}

/**
 * What the composer offers. `running`: the session's tree works or waits; `offline`: no OpenCode process
 * reports the session. A turn that was sent but has not started yet blocks a second Send (it would collide);
 * once the tree runs, more text is a Steer.
 */
export function composerView(state: ComposerState, { running, offline }: { running: boolean; offline: boolean }): ComposerView {
  const hasText = state.draft.trim().length > 0
  const waiting = state.pending.length > 0 && !running
  return {
    primary: running ? "steer" : "send",
    canSubmit: hasText && !offline && !waiting,
    showStop: running,
    canStop: running && !offline && !state.stopping,
    ...(offline ? { hint: "The machine running this session is disconnected; it is read-only until it reconnects." } : {}),
  }
}
