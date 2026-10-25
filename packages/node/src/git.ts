// The node's only way to run git (decision 10). Never a shell: execFile with an argv the caller builds with `--`
// before paths and refs. The environment is fixed: no terminal or credential-manager prompts (a daemon has no one to
// ask), only the https and ssh transports (never ext::, file:: or a local path as a remote), and none of the
// inherited GIT_* variables that redirect a repository, its config or git's own programs. Every run has a time limit
// and can be cancelled. node:child_process (not Bun.spawn) so the node also runs bundled for node.
import { execFile } from "node:child_process"

type Env = Readonly<Record<string, string | undefined>>

/** Transports git may use (GIT_ALLOW_PROTOCOL). */
export const ALLOWED_PROTOCOLS = "https:ssh"
export const GIT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 16 * 1024 * 1024
const STDERR_MAX = 600

/** Inherited GIT_* names that only choose how ssh runs; every other GIT_* name is dropped. */
const KEPT_GIT_VARS = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"])

export class GitError extends Error {
  override readonly name = "GitError"
}

/** `base` without its GIT_* overrides, plus the hardened settings and then `overlay`. */
export function gitEnv(base: Env = process.env, overlay: Env = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (name.startsWith("GIT_") && !KEPT_GIT_VARS.has(name)) continue
    env[name] = value
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS, GCM_INTERACTIVE: "never", LC_ALL: "C" })
  for (const [name, value] of Object.entries(overlay)) if (value !== undefined) env[name] = value
  return env
}

/** Removes credentials (userinfo) from URLs in git output. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
}

export interface GitOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** The environment to start from (default process.env); GIT_* overrides are dropped from it. */
  readonly baseEnv?: Env
  /** Applied after the hardening (tests use it to allow the file transport). */
  readonly env?: Env
  /** The git executable (default "git" on PATH). */
  readonly binary?: string
}

/** Runs `git -c protocol.ext.allow=never <args>` and resolves with stdout; rejects with a GitError. */
export function runGit(args: readonly string[], options: GitOptions): Promise<string> {
  const argv = ["-c", "protocol.ext.allow=never", ...args]
  const what = `git ${args.find((a) => !a.startsWith("-")) ?? ""}`.trim()
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new GitError(`${what} cancelled`))
    let ended: string | undefined
    const child = execFile(
      options.binary ?? "git",
      argv,
      { cwd: options.cwd, env: gitEnv(options.baseEnv ?? process.env, options.env), maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        if (ended) return reject(new GitError(`${what} ${ended}`))
        if (error) {
          const detail = redact(String(stderr || error.message).trim()).slice(0, STDERR_MAX)
          return reject(new GitError(`${what} failed${detail ? `: ${detail}` : ""}`))
        }
        resolve(String(stdout))
      },
    )
    const stop = (why: string) => {
      ended ??= why
      child.kill("SIGKILL")
    }
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000) || 1} s`), timeoutMs)
    const onAbort = () => stop("cancelled")
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
