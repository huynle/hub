// The first message of a session started from /new: /new creates the session, then the session view sends
// this as its first turn (so the transcript shows it with its ticks and the reply streams in place).
import type { ComposerImage } from "../lib/composer"

export interface FirstTurn {
  readonly text: string
  readonly images: readonly ComposerImage[]
}

const pending = new Map<string, FirstTurn>()

export function setFirstTurn(sessionID: string, turn: FirstTurn): void {
  pending.set(sessionID, turn)
}

/** The first turn waiting for `sessionID` (removed: it is sent once). */
export function takeFirstTurn(sessionID: string): FirstTurn | undefined {
  const turn = pending.get(sessionID)
  pending.delete(sessionID)
  return turn
}
