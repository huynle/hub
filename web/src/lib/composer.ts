// Composer state: the draft, submissions in flight, the last error and a stop in flight. The primary action is
// Send while the session's tree is idle and Steer while it runs (the hub routes typed input either way); Stop
// shows while the tree runs. A submission clears the draft (and attached images) at once; if the hub refuses
// it, its text and images come back.
import { IMAGE_LIMITS } from "./images"

/** An image attached to the draft, already encoded within budget; `preview` is a URL for its thumbnail. */
export interface ComposerImage {
  readonly id: string
  readonly mime: string
  readonly data: string
  readonly name: string
  readonly preview: string
}

export interface PendingSubmit {
  readonly id: number
  readonly text: string
  readonly images?: readonly ComposerImage[]
}

export interface ComposerState {
  readonly draft: string
  readonly images: readonly ComposerImage[]
  readonly pending: readonly PendingSubmit[]
  readonly error?: string
  readonly stopping: boolean
}

export type ComposerAction =
  | { type: "input"; text: string }
  | { type: "attach"; image: ComposerImage }
  | { type: "detach"; id: string }
  | { type: "attachError"; message: string }
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

export const initialComposer = (): ComposerState => ({ draft: "", images: [], pending: [], stopping: false })

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "input":
      return { ...state, draft: action.text, error: undefined }
    case "attach":
      if (state.images.length >= IMAGE_LIMITS.maxImages) return state
      return { ...state, images: [...state.images, action.image], error: undefined }
    case "detach":
      return { ...state, images: state.images.filter((image) => image.id !== action.id), error: undefined }
    case "attachError":
      return { ...state, error: action.message }
    case "submit": {
      const text = state.draft.trim()
      if (!text && !state.images.length) return state
      const entry: PendingSubmit = { id: action.id, text, ...(state.images.length ? { images: state.images } : {}) }
      return { ...state, draft: "", images: [], pending: [...state.pending, entry], error: undefined }
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
        draft: state.draft && entry.text ? `${entry.text}\n${state.draft}` : entry.text || state.draft,
        images: [...(entry.images ?? []), ...state.images].slice(0, IMAGE_LIMITS.maxImages),
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
  const hasContent = state.draft.trim().length > 0 || state.images.length > 0
  const waiting = state.pending.length > 0 && !running
  return {
    primary: running ? "steer" : "send",
    canSubmit: hasContent && !offline && !waiting,
    showStop: running,
    canStop: running && !offline && !state.stopping,
    ...(offline ? { hint: "The machine running this session is disconnected; it is read-only until it reconnects." } : {}),
  }
}

/** Unsent drafts per session, kept while the console is open (switching sessions keeps each one's text). */
export class Drafts {
  private readonly drafts = new Map<string, string>()
  private readonly listeners = new Set<(sessionID: string) => void>()

  get(sessionID: string): string {
    return this.drafts.get(sessionID) ?? ""
  }

  set(sessionID: string, text: string): void {
    if (this.get(sessionID) === text) return
    if (text) this.drafts.set(sessionID, text)
    else this.drafts.delete(sessionID)
    for (const listener of [...this.listeners]) listener(sessionID)
  }

  /** Adds dictated text after the draft (one space between). Returns the new draft. */
  append(sessionID: string, text: string): string {
    const current = this.get(sessionID).replace(/\s+$/, "")
    const next = current ? `${current} ${text}` : text
    this.set(sessionID, next)
    return next
  }

  subscribe(listener: (sessionID: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
