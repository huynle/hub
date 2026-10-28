// Fixtures for the OpenCode adapter tests (HBS-06). Plain text and fakes only: no real home, config, binary or
// credential appears here. Provider settings use placeholder env references, never key material.

/** The stable hubctl authority (the installed standalone hubctl in user-bin), as resolved on the fake host. */
export const AUTHORITY = "/Users/dev/.local/bin/hubctl"

/**
 * A real-world-shaped OpenCode 2 config: comments everywhere, trailing commas, other plugins (one commented out),
 * MCP servers (local and remote), a provider, and fields hubctl does not know.
 */
export const CONFIG_WITH_EVERYTHING = `// OpenCode config, synced from dotfiles
{
  "$schema": "https://opencode.ai/config.json",
  /* the user's look */
  "theme": "tokyonight", // always dark
  "plugins": [
    // "opencode-old-plugin",
    "other-plugin", // keep me
    { "package": "@acme/opencode-tools", "options": { "level": 2 } },
  ],
  "providers": {
    // a provider the user configured; never touched
    "local-llm": { "baseURL": "http://127.0.0.1:11434/v1", "models": { "qwen": {} } },
  },
  "mcp": {
    "servers": {
      "notes": { "type": "remote", "url": "https://notes.example/mcp", "disabled": true },
      "tools": {
        "type": "local",
        "command": ["npx", "-y", "some-mcp"], // the user's own server
      },
    },
  },
  "x-unknown-field": { "kept": [1, 2, 3,], },
}
`

/** True when `a` is a subsequence of `b` (b is a plus insertions only); returns the inserted characters. */
export function insertionsOf(a: string, b: string): string | undefined {
  let i = 0
  let extra = ""
  for (const ch of b) {
    if (i < a.length && ch === a[i]) i++
    else extra += ch
  }
  return i === a.length ? extra : undefined
}
