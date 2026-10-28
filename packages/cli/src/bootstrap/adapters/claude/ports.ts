// The Claude Code adapter's only ways to reach outside itself, all injected: an https downloader, a fixed-argv
// process runner (never a shell) and a private scratch file. node.ts has the default implementations; tests
// inject fakes.

/** Fetches an https URL's body, refusing more than `maxBytes`; throws on any failure. */
export interface Downloader {
  get(url: string, maxBytes: number): Promise<Uint8Array>
}

/** How a fixed-argv probe ended. `stdout` is the probe's to parse and drop; it is never recorded. */
export type RunResult =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly message: string }

export interface RunOptions {
  /** The child's whole environment (nothing else is inherited). */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

/** Runs one program with an argument list (never a shell). The only way this adapter starts a process. */
export interface ProbeRunner {
  run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult>
}

/** A private (0700) scratch copy of some bytes for the duration of `use`, removed afterwards. */
export interface Scratch {
  withFile<T>(bytes: Uint8Array, use: (path: string) => Promise<T>): Promise<T>
}
