// Prompt references (design §2.4): hub addresses typed into a prompt get context, never routing. The pure parts
// (find, resolve, render) live in the spoke SDK; the OpenCode prompt hook stays here.
import { HubClient } from "../../packages/sdk/src/index.ts"
import { findReferences, renderReferences, resolveReferences, type Mention, type ReferenceSnapshot } from "../../packages/spoke-sdk/src/prompt-refs.ts"
import { isHubPrompt } from "./conversation"
import type { HubToolSpoke } from "./hub-tool"

export * from "../../packages/spoke-sdk/src/prompt-refs.ts"

/** The longest a prompt waits for the hub (design §2.4: ≤ 1.5 s); then it goes on without context. */
export const PROMPT_REF_TIMEOUT_MS = 1500
/** How long one session's lookup (or failure) is reused. */
export const PROMPT_REF_TTL_MS = 10_000
/** Cached sessions at most (expired ones are dropped first). */
const CACHE_MAX = 200

export const REFERENCE_FILE_NAME = "hub-references.txt"
const REFERENCE_FILE_DESCRIPTION = "hub: the sessions this prompt's @addresses name (context from the hub plugin)"

/** OpenCode's prompt hook event (plugin SessionPrompt), the parts used here. */
export interface PromptEvent {
  readonly sessionID: string
  readonly messageID?: string
  readonly delivery?: string
  metadata?: Record<string, unknown>
  prompt: {
    text: string
    files?: { uri: string; name?: string; description?: string; mention?: Mention }[]
    agents?: { name: string; mention?: Mention }[]
    skills?: { name?: string; mention?: Mention }[]
  }
}

export interface PromptReferencesOptions {
  readonly timeoutMs?: number
  readonly ttlMs?: number
  readonly now?: () => number
}

/** The hook: adds hub context for @name / @@role addresses as one text file; never changes the prompt text. */
export class PromptReferences {
  readonly #spoke: () => HubToolSpoke | undefined
  readonly #timeoutMs: number
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #cache = new Map<string, { at: number; snapshot: Promise<ReferenceSnapshot | undefined> }>()

  constructor(spoke: () => HubToolSpoke | undefined, options: PromptReferencesOptions = {}) {
    this.#spoke = spoke
    this.#timeoutMs = Math.min(options.timeoutMs ?? PROMPT_REF_TIMEOUT_MS, PROMPT_REF_TIMEOUT_MS)
    this.#ttlMs = options.ttlMs ?? PROMPT_REF_TTL_MS
    this.#now = options.now ?? Date.now
  }

  /** Never throws and never waits longer than the timeout (fail open). */
  async onPrompt(event: PromptEvent): Promise<void> {
    try {
      const prompt = event?.prompt
      if (!prompt || typeof prompt.text !== "string" || isHubPrompt(event.metadata)) return
      const addresses = findReferences(prompt)
      if (!addresses.length) return
      const spoke = this.#spoke()
      const identity = spoke?.shellIdentity(event.sessionID)
      if (!spoke || !identity?.token || !identity.url) return
      const { token, url } = identity
      const snapshot = await this.#snapshot(event.sessionID, () => this.#fetch({ token, url }, spoke.hubSupports("messaging")))
      if (!snapshot) return
      const refs = resolveReferences(addresses, snapshot, event.sessionID)
      if (!refs.length) return
      prompt.files = [...(prompt.files ?? []), referenceFile(renderReferences(refs))]
    } catch {
      // Fail open: the prompt goes on without context.
    }
  }

  #snapshot(sessionID: string, load: () => Promise<ReferenceSnapshot | undefined>): Promise<ReferenceSnapshot | undefined> {
    const now = this.#now()
    const cached = this.#cache.get(sessionID)
    if (cached && now - cached.at <= this.#ttlMs) return cached.snapshot
    for (const [key, value] of this.#cache) if (now - value.at > this.#ttlMs) this.#cache.delete(key)
    // Still full: drop the oldest (Map keeps insertion order).
    while (this.#cache.size >= CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!)
    const snapshot = load().catch(() => undefined)
    this.#cache.set(sessionID, { at: now, snapshot })
    return snapshot
  }

  /** who (required), status and inbox (optional details), in parallel, all within the timeout. */
  async #fetch(identity: { token: string; url: string }, messaging: boolean): Promise<ReferenceSnapshot | undefined> {
    const client = new HubClient({ url: identity.url, token: identity.token })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        abort.abort()
        resolve(undefined)
      }, this.#timeoutMs)
    })
    const signal = { signal: abort.signal }
    const optional = <T>(promise: Promise<T>) => promise.catch(() => undefined)
    const lookup = Promise.all([client.who(signal), optional(client.status(signal)), messaging ? optional(client.inbox(signal)) : undefined]).then(
      ([who, status, inbox]): ReferenceSnapshot => ({ who: who.sessions, ...(status ? { status } : {}), ...(inbox ? { waiting: inbox.waiting } : {}) }),
    )
    try {
      return await Promise.race([lookup, deadline])
    } finally {
      clearTimeout(timer)
      lookup.catch(() => undefined)
    }
  }
}

/** The context as an inline text file (the spike's mechanism: the model sees it inside the same user message). */
export function referenceFile(text: string): { uri: string; name: string; description: string } {
  return { uri: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`, name: REFERENCE_FILE_NAME, description: REFERENCE_FILE_DESCRIPTION }
}
