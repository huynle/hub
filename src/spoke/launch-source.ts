// Which configuration the plugin's spoke runs from. Inside a launch's sandbox the node puts a read-only launch config
// ({hubURL, token, launchID}, src/config.ts) and node.json in one directory; the spoke is then launch-bound. A launch
// config that cannot be read is an error, never a reason to fall back to the machine config (or to enrol).
import { existsSync } from "node:fs"
import { launchConfigPath, readLaunchConfig, type LaunchConfig } from "../config"
import type { Env } from "../env"
import { nodeConfigPathNextTo } from "./node-roots"

export type LaunchSource =
  | { readonly kind: "machine" }
  | { readonly kind: "launch"; readonly file: string; readonly launch: LaunchConfig; readonly nodeConfig: string }
  | { readonly kind: "invalid"; readonly file: string; readonly error: string }

export function launchSource(env: Env = process.env, exists: (file: string) => boolean = existsSync): LaunchSource {
  const file = launchConfigPath(env, exists)
  if (!file) return { kind: "machine" }
  try {
    return { kind: "launch", file, launch: readLaunchConfig(file), nodeConfig: nodeConfigPathNextTo(file) }
  } catch (cause) {
    return { kind: "invalid", file, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
