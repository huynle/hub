// Hub's TUI slash commands, one entry per feature. /hub configures this harness's connection to the hub;
// every other entry is a feature (/voice today). To add a feature, write its flow in its own module
// (like src/voice-command.ts) and add one HubCommand to the list src/tui.ts passes to hubCommands().

/** The palette group of every Hub command. */
export const COMMAND_GROUP = "Hub"
/** Command IDs are `hub.<id>`, the plugin's namespace. */
export const COMMAND_PREFIX = "hub."

export interface HubCommand {
  /** Unique within Hub; the command ID is `hub.<id>`. */
  readonly id: string
  /** The slash command, without the "/". */
  readonly slash: string
  /** Shown in the command palette after "Hub: ". */
  readonly title: string
  readonly run: () => Promise<unknown>
}

/** The shape OpenCode's keymap layer takes for one command. */
export interface KeymapCommand {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly palette: true
  readonly slash: { readonly name: string }
  readonly run: () => void
}

/**
 * Keymap commands for the given features. Throws on a duplicate ID or slash name (a programming error).
 * A failing run is reported through `onError` (a toast), never thrown into the TUI.
 */
export function hubCommands(features: readonly HubCommand[], onError: (cause: unknown) => void): KeymapCommand[] {
  const ids = new Set<string>()
  const names = new Set<string>()
  return features.map((feature) => {
    if (ids.has(feature.id)) throw new Error(`duplicate Hub command id "${feature.id}"`)
    if (names.has(feature.slash)) throw new Error(`duplicate Hub slash command "/${feature.slash}"`)
    ids.add(feature.id)
    names.add(feature.slash)
    return {
      id: `${COMMAND_PREFIX}${feature.id}`,
      title: `${COMMAND_GROUP}: ${feature.title}`,
      group: COMMAND_GROUP,
      palette: true,
      slash: { name: feature.slash },
      run: () => {
        void feature.run().catch(onError)
      },
    }
  })
}
