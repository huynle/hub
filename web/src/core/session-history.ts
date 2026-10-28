/** Give native browser Back a hierarchical destination, including deep links and reloads. */
export function sessionHistory(history: Pick<History, "state" | "replaceState" | "pushState">, current: string, rootID?: string): void {
  const root = rootID ? `/s/${encodeURIComponent(rootID)}` : "/"
  const back = root === current ? "/" : root
  const state = history.state
  if (state?.hubSessionPath === current && state?.hubSessionBack === back) return
  history.replaceState({ hubSessionPath: "/" }, "", "/")
  if (back !== "/") history.pushState({ hubSessionPath: back, hubSessionBack: "/" }, "", back)
  history.pushState({ hubSessionPath: current, hubSessionBack: back }, "", current)
}
