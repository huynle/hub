// The Claude Code adapter's only ways to reach outside itself, all injected: an https downloader, a fixed-argv
// process runner (never a shell) and a private scratch file. node.ts has the default implementations; tests
// inject fakes. Bodies and scratch content are ByteSources: the ~200 MB binary streams, it is never held whole.
import type { ByteSource } from "../../transaction/stream.ts"

/** Thrown by a Downloader when the body is longer than allowed. */
export class DownloadTooLarge extends Error {
  constructor(url: string, maxBytes: number) {
    super(`${url} is larger than ${maxBytes} bytes`)
    this.name = "DownloadTooLarge"
  }
}

/**
 * Fetches an https URL's body, refusing more than `maxBytes` (DownloadTooLarge, also while it streams); throws on
 * any failure. The body is whole (small things, fakes) or chunks as they arrive.
 */
export interface Downloader {
  get(url: string, maxBytes: number): Promise<ByteSource>
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

/** A private (0700) scratch copy of some content (written as it streams) for the duration of `use`, removed afterwards. */
export interface Scratch {
  withFile<T>(content: ByteSource, use: (path: string) => Promise<T>): Promise<T>
}
