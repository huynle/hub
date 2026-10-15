// One line per process: this package was renamed.
const KEY = Symbol.for("opencode-voice.rename-notice")

export const RENAME_NOTICE =
  "[opencode-voice] @huynle/opencode-voice is now @huynle/opencode-hub; switch your OpenCode plugin to " +
  "@huynle/opencode-hub (or github:huynle/opencode-hub). This package only re-exports it."

export function renameNotice(log: (message: string) => void = console.warn): void {
  const store = globalThis as unknown as Record<symbol, unknown>
  if (store[KEY]) return
  store[KEY] = true
  log(RENAME_NOTICE)
}
