// Keeps the per-machine config live: fs.watch on the config's directory (atomic writes replace
// the file, so watching the file itself would go stale) plus a slow poll as a fallback.
import { watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { readConfig, type VoiceConfig } from "../config"

export interface ConfigWatcher {
  current(): VoiceConfig
  /** Re-reads now (e.g. after this process wrote the file) and notifies when it changed. */
  refresh(): VoiceConfig
  stop(): void
}

export function watchConfig(
  file: string,
  machineName: string,
  onChange: (config: VoiceConfig) => void,
  options: { pollMs?: number } = {},
): ConfigWatcher {
  let config = readConfig(file, machineName)
  let key = JSON.stringify(config)
  let stopped = false
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  const refresh = () => {
    if (stopped) return config
    const next = readConfig(file, machineName)
    const nextKey = JSON.stringify(next)
    if (nextKey !== key) {
      config = next
      key = nextKey
      try {
        onChange(config)
      } catch (cause) {
        console.error("[hub] config change handler failed", cause)
      }
    }
    return config
  }

  const startWatcher = () => {
    if (watcher || stopped) return
    try {
      const base = path.basename(file)
      watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
        if (name && name !== base) return
        clearTimeout(debounce)
        debounce = setTimeout(refresh, 50)
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      watcher = undefined // directory missing; the poll keeps trying
    }
  }

  startWatcher()
  const poll = setInterval(() => {
    startWatcher()
    refresh()
  }, options.pollMs ?? 5000)
  ;(poll as { unref?: () => void }).unref?.()

  return {
    current: () => config,
    refresh,
    stop: () => {
      stopped = true
      clearInterval(poll)
      clearTimeout(debounce)
      watcher?.close()
      watcher = undefined
    },
  }
}
