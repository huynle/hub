// Speak while it writes: cuts a root session's streamed assistant text into sentences as soon as each one is
// complete, so the phone can synthesize and play the first sentence while the rest is still being written.
// Sentences are raw slices of the text (Markdown and code kept): /api/speak runs speakable() on each, and the
// slices joined make up the streamed text, so the phone can merge them with the bubble streamed from deltas.

/** Tokens ending in "." that rarely end a sentence (compared lowercase). */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "cf.", "prof.", "jr.", "sr.", "approx.", "no.", "fig.", "etc."])
/** A line break, or sentence-ending punctuation with closing quotes/brackets. */
const BOUNDARY = /\n|[.?!…]+["'”’)\]]*/g
const CLOSING_FENCE = /\n[ \t]*```/g
const WORDY = /[\p{L}\p{N}]/u

export interface SentenceStreamOptions {
  /** A run this long without a sentence end is cut at a comma or space. */
  readonly maxChars?: number
}

export class SentenceStream {
  private buf = ""
  /** Everything before this offset was emitted. */
  private pos = 0
  private maxChars: number

  constructor({ maxChars = 300 }: SentenceStreamOptions = {}) {
    this.maxChars = maxChars
  }

  /** Appends streamed text; returns the sentences it completed. */
  push(delta: string): string[] {
    this.buf += String(delta ?? "")
    return this.drain(false)
  }

  /**
   * The text ended: returns the remaining sentences. `full` (the final text) is authoritative: missed deltas
   * are recovered, and when only a later part was streamed, speech continues after what was already emitted.
   */
  end(full?: string): string[] {
    if (typeof full === "string") this.adopt(full)
    return this.drain(true)
  }

  private adopt(full: string): void {
    const done = this.buf.slice(0, this.pos)
    if (full.startsWith(done)) {
      this.buf = full
      return
    }
    const spoken = done.trim()
    const at = full.indexOf(spoken)
    if (at >= 0) {
      this.buf = full
      this.pos = at + spoken.length
    }
    // Otherwise the texts diverged: only what was streamed is spoken.
  }

  private drain(final: boolean): string[] {
    const out: string[] = []
    for (;;) {
      while (this.pos < this.buf.length && /\s/.test(this.buf[this.pos]!)) this.pos++
      if (this.pos >= this.buf.length) break
      const end = this.next(this.pos, final)
      if (end === undefined) break
      const sentence = this.buf.slice(this.pos, end).trim()
      this.pos = end
      if (WORDY.test(sentence)) out.push(sentence)
    }
    return out
  }

  /** End offset of the next piece starting at `start`, or undefined to wait for more text. */
  private next(start: number, final: boolean): number | undefined {
    const buf = this.buf
    if (buf.startsWith("```", start)) {
      CLOSING_FENCE.lastIndex = start + 3
      const close = CLOSING_FENCE.exec(buf)
      if (close) return close.index + close[0].length
      return final ? buf.length : undefined
    }
    BOUNDARY.lastIndex = start
    for (let match = BOUNDARY.exec(buf); match; match = BOUNDARY.exec(buf)) {
      const at = match.index
      const after = at + match[0].length
      let end: number | undefined
      if (match[0] === "\n") end = at
      else {
        const verdict = this.sentenceEnd(start, at, after, final)
        if (verdict === "wait") return this.cutLong(start, final)
        if (verdict) end = after
      }
      if (end === undefined) continue
      // Pieces without words ("---", "**") join the next sentence, unless a code block comes next (then
      // they are dropped: drain skips pieces without words).
      if (WORDY.test(buf.slice(start, end)) || /^\n[ \t]*```/.test(buf.slice(at))) return end
    }
    return this.cutLong(start, final)
  }

  /** Whether punctuation at `at`..`after` ends a sentence; "wait" when the text after it has not arrived. */
  private sentenceEnd(start: number, at: number, after: number, final: boolean): boolean | "wait" {
    const buf = this.buf
    if (after >= buf.length) return final ? true : "wait"
    if (!/\s/.test(buf[after]!)) return false // 3.5, config.ts, v1.2
    const rest = /^[ \t]*([\s\S])?/.exec(buf.slice(after))!
    const next = rest[1]
    if (next === undefined) return final ? true : "wait"
    if (next === "\n" || /\s/.test(next)) return true
    if (/[?!]/.test(buf.slice(at, after))) return true
    const lineStart = Math.max(start, buf.lastIndexOf("\n", at) + 1)
    const tokenStart = Math.max(lineStart, buf.lastIndexOf(" ", at) + 1)
    const token = buf.slice(tokenStart, after).toLowerCase()
    if (ABBREVIATIONS.has(token.replace(/["'”’)\]]+$/, ""))) return false
    if (tokenStart === lineStart && /^\d+[.)]$/.test(token)) return false // "1." list marker
    return !/\p{Ll}/u.test(next)
  }

  /** No sentence end yet: a run longer than maxChars is cut at a comma or space; at the end, all of it. */
  private cutLong(start: number, final: boolean): number | undefined {
    const buf = this.buf
    if (final) return buf.length
    if (buf.length - start <= this.maxChars) return undefined
    const window = buf.slice(start, start + this.maxChars)
    let at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "))
    at = at > this.maxChars / 2 ? at + 1 : window.lastIndexOf(" ")
    return start + (at > 0 ? at : this.maxChars)
  }
}
