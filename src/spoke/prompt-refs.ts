// Prompt references (design §2.4): hub addresses typed into a prompt get context, never routing.
export interface Mention {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface PromptLike {
  readonly text: string
  readonly files?: readonly { readonly uri?: string; readonly name?: string; readonly mention?: Mention }[]
  readonly agents?: readonly { readonly name: string; readonly mention?: Mention }[]
  readonly skills?: readonly { readonly name?: string; readonly mention?: Mention }[]
}

/**
 * `@name`, `@name.project`, `@@role`, `@@role.project`: names and roles are 2–40 lowercase letters, digits and
 * dashes (src/central/agent/names.ts); not part of a word, email or path, and not followed by one.
 */
const ADDRESS = /(?<![\w@./\\-])(@@?)([a-z0-9-]{2,40})(?:\.([A-Za-z0-9_-]+))?(?![\w@/\\-]|\.[\w/\\-])/g

/** The user's own address (not a session). */
const SELF = "me"

/** The hub addresses a prompt mentions, once each, in order; those the harness already gave a meaning are skipped. */
export function findReferences(prompt: PromptLike): string[] {
  const text = typeof prompt?.text === "string" ? prompt.text : ""
  if (!text.includes("@")) return []
  const mentions = [...(prompt.files ?? []), ...(prompt.agents ?? []), ...(prompt.skills ?? [])].map((m) => m?.mention).filter((m): m is Mention => !!m)
  const agentNames = new Set((prompt.agents ?? []).map((a) => a?.name).filter(Boolean))
  const found: string[] = []
  for (const match of text.matchAll(ADDRESS)) {
    const [token, ats, name] = match as unknown as [string, string, string]
    const start = match.index ?? 0
    const end = start + token.length
    const role = ats === "@@"
    if (!role && name === SELF) continue
    if (mentions.some((m) => m.start < end && m.end > start)) continue
    if (!role && (agentNames.has(name) || mentions.some((m) => m.text === token || m.text === `@${name}`))) continue
    if (!found.includes(token)) found.push(token)
  }
  return found
}
