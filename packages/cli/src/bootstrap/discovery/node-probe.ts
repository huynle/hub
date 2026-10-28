// The real DiscoveryProbe, over node:fs. Every method is a read: lstat/stat, a bounded read of a file opened
// read-only, readdir, readlink, realpath and an access(X_OK) check. Errors mean "missing" or "unknown", never a
// throw. The only process it may start is the macOS machine-identity query (`ioreg`, a fixed read-only argv, no
// shell), and only when no machine ID was injected; Linux reads /etc/machine-id.
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import { programLayout, type EntryKind } from "../contracts/index.ts"
import type { DiscoveryProbe, RuntimeFact } from "./probe.ts"

export interface NodeProbeOptions {
  /** Defaults to process.env (read, never recorded). */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  /** Injected machine identity (tests); otherwise read from the OS. */
  readonly machineID?: string
  /** The running runtime; null when hubctl runs standalone. Detected by default. */
  readonly runtime?: RuntimeFact | null
}

/** Reads without a limit are capped (configs are small; a bigger file is not read at all). */
export const MAX_READ_BYTES = 16 * 1024 * 1024

const kindOf = (st: fs.Stats): EntryKind => (st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "other")

function attempt<T>(f: () => T): T | undefined {
  try {
    return f()
  } catch {
    return undefined
  }
}

function currentRuntime(): RuntimeFact | undefined {
  const layout = programLayout({ execPath: process.execPath, entry: process.argv[1] ?? "" })
  if (layout.kind === "standalone") return undefined
  const bun = process.versions.bun
  return bun ? { id: "bun", version: bun, path: process.execPath } : { id: "node", version: process.versions.node, path: process.execPath }
}

function osMachineID(): string | undefined {
  if (process.platform === "linux")
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = attempt(() => fs.readFileSync(p, "utf8").trim())
      if (id) return id
    }
  if (process.platform === "darwin") {
    const out = attempt(() => childProcess.execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }))
    return out ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] : undefined
  }
  return undefined
}

export function createNodeProbe(options: NodeProbeOptions = {}): DiscoveryProbe {
  let machineID: string | undefined | null = options.machineID ?? null
  const runtime = options.runtime === null ? undefined : (options.runtime ?? currentRuntime())
  return {
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.() ?? 0,
    home: options.home ?? os.homedir(),
    hostname: os.hostname(),
    env: options.env ?? process.env,
    ...(runtime ? { runtime } : {}),
    lstat: (p) => attempt(() => kindOf(fs.lstatSync(p))) ?? "missing",
    stat: (p) => attempt(() => kindOf(fs.statSync(p))) ?? "missing",
    readFile(p, limit) {
      const max = Math.min(limit ?? MAX_READ_BYTES, MAX_READ_BYTES)
      const fd = attempt(() => fs.openSync(p, "r"))
      if (fd === undefined) return undefined
      try {
        const st = fs.fstatSync(fd)
        if (!st.isFile() || (limit === undefined && st.size > MAX_READ_BYTES)) return undefined
        const buffer = Buffer.alloc(Math.min(max, st.size))
        let read = 0
        while (read < buffer.length) {
          const n = fs.readSync(fd, buffer, read, buffer.length - read, read)
          if (n === 0) break
          read += n
        }
        return new Uint8Array(buffer.subarray(0, read))
      } catch {
        return undefined
      } finally {
        attempt(() => fs.closeSync(fd))
      }
    },
    readdir: (p) => attempt(() => fs.readdirSync(p).sort()),
    readlink: (p) => attempt(() => fs.readlinkSync(p)),
    realpath: (p) => attempt(() => fs.realpathSync(p)),
    executable: (p) => attempt(() => fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true)) ?? false,
    machineID() {
      if (machineID === null) machineID = osMachineID()
      return machineID
    },
  }
}
