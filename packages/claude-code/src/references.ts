// Prompt references (design §2.4) for Claude Code: the hub addresses a user's prompt mentions (@name, @@role) get a
// context note (UserPromptSubmit additionalContext), never routing. The lookup is the spoke SDK's (find, resolve,
// render) with the session's own token: who, plus status and inbox when they answer, all within 1.5 s; any failure
// or a slow hub means no note (fail open).
import { HubClient } from "../../sdk/src/index.ts"
import { findReferences, renderReferences, resolveReferences, type ReferenceSnapshot } from "../../spoke-sdk/src/index.ts"

/** The longest a prompt waits for the hub (design §2.4). */
export const REFERENCE_TIMEOUT_MS = 1500

type Identity = (sessionID: string) => { readonly token: string; readonly url?: string } | undefined

export function hubReferences(identity: Identity, options: { readonly timeoutMs?: number } = {}): (prompt: string, sessionID: string) => Promise<string | undefined> {
  const timeoutMs = Math.min(options.timeoutMs ?? REFERENCE_TIMEOUT_MS, REFERENCE_TIMEOUT_MS)
  return async (prompt, sessionID) => {
    try {
      const addresses = findReferences({ text: prompt })
      if (!addresses.length) return undefined
      const id = identity(sessionID)
      if (!id?.url) return undefined
      const snapshot = await lookup(new HubClient({ url: id.url, token: id.token }), timeoutMs)
      if (!snapshot) return undefined
      const refs = resolveReferences(addresses, snapshot, sessionID)
      return refs.length ? renderReferences(refs) : undefined
    } catch {
      return undefined
    }
  }
}

async function lookup(client: HubClient, timeoutMs: number): Promise<ReferenceSnapshot | undefined> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(undefined)
    }, timeoutMs)
  })
  const signal = { signal: abort.signal }
  const optional = <T>(promise: Promise<T>) => promise.catch(() => undefined)
  const found = Promise.all([client.who(signal), optional(client.status(signal)), optional(client.inbox(signal))]).then(
    ([who, status, inbox]): ReferenceSnapshot => ({ who: who.sessions, ...(status ? { status } : {}), ...(inbox ? { waiting: inbox.waiting } : {}) }),
  )
  try {
    return await Promise.race([found, deadline])
  } finally {
    clearTimeout(timer)
    found.catch(() => undefined)
  }
}
