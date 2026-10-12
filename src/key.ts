export interface KeySources {
  active(integrationID: string): Promise<unknown>
  resolve(connection: any): Promise<unknown>
  env: Readonly<Record<string, string | undefined>>
}

/** OpenCode's openrouter integration first, then OPENROUTER_API_KEY, then the plugin option. */
export async function resolveOpenRouterKey(sources: KeySources, optionKey: string | undefined): Promise<string | undefined> {
  try {
    const connection = await sources.active("openrouter")
    if (connection) {
      const value = (await sources.resolve(connection)) as { type?: unknown; key?: unknown } | undefined
      if (value?.type === "key" && typeof value.key === "string" && value.key) return value.key
    }
  } catch {}
  return sources.env.OPENROUTER_API_KEY || optionKey || undefined
}
