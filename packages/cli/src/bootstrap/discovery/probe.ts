// The read-only probe discovery and preview run through. It is the only way they see the host: a handful of
// filesystem reads (lstat, stat, readFile, readdir, readlink, realpath, an executable check), facts about this
// process, and the machine identity. The interface has no method that writes, deletes, connects or spawns an
// arbitrary command, so discover and preview cannot change the host or reach the network even by mistake. Tests
// inject an in-memory probe; the CLI injects createNodeProbe().
import type { EntryKind } from "../contracts/index.ts"

export interface RuntimeFact {
  readonly id: "bun" | "node"
  readonly version: string
  readonly path: string
}

export interface DiscoveryProbe {
  /** process.platform and process.arch as found (may be unsupported). */
  readonly platform: string
  readonly arch: string
  readonly uid: number
  /** The user's home directory (os.homedir()). */
  readonly home: string
  readonly hostname: string
  /** Read, never recorded: discovery looks at PATH, HOME, XDG_* and `container` only. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The runtime running this script, when hubctl runs as a script (absent for a standalone binary). */
  readonly runtime?: RuntimeFact
  /** Does not follow a final symlink. */
  lstat(path: string): EntryKind
  /** Follows symlinks. */
  stat(path: string): EntryKind
  /** Up to `limit` bytes of a file (following symlinks), or undefined when it cannot be read. */
  readFile(path: string, limit?: number): Uint8Array | undefined
  /** Entry names of a directory (sorted), or undefined. */
  readdir(path: string): readonly string[] | undefined
  readlink(path: string): string | undefined
  /** The canonical path (every link resolved), or undefined when it does not exist. */
  realpath(path: string): string | undefined
  /** A regular file (after links) this user may execute. */
  executable(path: string): boolean
  /** /etc/machine-id (Linux) or IOPlatformUUID (macOS); never recorded raw. */
  machineID(): string | undefined
}
