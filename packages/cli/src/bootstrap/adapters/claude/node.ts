// Default Node implementations of the Claude Code adapter's ports (ports.ts). The integrator (HBS-13) passes them;
// tests inject fakes.
//
//   nodeRunner       spawn(file, args) with shell: false, exactly the given environment, stdin closed, stderr
//                    dropped, stdout capped, and a hard timeout (SIGKILL). The only process starter here.
//   httpsDownloader  https only (also after redirects), non-2xx refused, the body capped (DownloadTooLarge).
//   tempScratch      a 0700 directory under the system temp dir with one 0600 file, removed afterwards.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DownloadTooLarge, type Downloader, type ProbeRunner, type RunResult, type Scratch } from "./ports.ts"

export function nodeRunner(): ProbeRunner {
  return {
    run: (file, args, options) =>
      new Promise<RunResult>((resolve) => {
        let settled = false
        const done = (r: RunResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(r)
        }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(file, [...args], { shell: false, env: { ...options.env }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
        } catch (error) {
          return resolve({ kind: "error", message: error instanceof Error ? error.message : String(error) })
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          done({ kind: "timeout" })
        }, options.timeoutMs)
        const chunks: Buffer[] = []
        let size = 0
        child.stdout?.on("data", (chunk: Buffer) => {
          if (size >= options.maxOutputBytes) return
          const part = chunk.subarray(0, options.maxOutputBytes - size)
          chunks.push(part)
          size += part.length
        })
        child.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? { kind: "not-found" } : { kind: "error", message: error.code ?? "spawn failed" }))
        // Settle once the process exited and its stdout ended (whichever comes last), or on "close".
        let exitCode: number | undefined
        let ended = !child.stdout
        const finish = () => {
          if (exitCode !== undefined && ended) done({ kind: "exited", code: exitCode, stdout: Buffer.concat(chunks).toString("utf8") })
        }
        child.stdout?.on("end", () => ((ended = true), finish()))
        child.stdout?.on("close", () => ((ended = true), finish()))
        child.on("exit", (code, signal) => ((exitCode = code ?? (signal ? -1 : 0)), finish()))
        child.on("close", (code) => ((exitCode ??= code ?? -1), (ended = true), finish()))
      }),
  }
}

export interface DownloaderOptions {
  /** The fetch implementation (default: the global fetch). */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export function httpsDownloader(options: DownloaderOptions = {}): Downloader {
  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  return {
    async get(url, maxBytes) {
      if (!url.startsWith("https://")) throw new Error(`refusing a non-https download: ${url}`)
      const response = await doFetch(url, { redirect: "follow" })
      if (response.url && !response.url.startsWith("https://")) throw new Error(`${url} redirected away from https`)
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const declared = Number(response.headers.get("content-length") ?? NaN)
      if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadTooLarge(url, maxBytes)
      const reader = response.body?.getReader()
      if (!reader) return new Uint8Array()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new DownloadTooLarge(url, maxBytes)
        }
        chunks.push(value)
      }
      const out = new Uint8Array(size)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      return out
    },
  }
}

export function tempScratch(base: string = tmpdir()): Scratch {
  return {
    async withFile(bytes, use) {
      const dir = mkdtempSync(join(base, "hubctl-claude-"))
      try {
        const file = join(dir, "claude")
        writeFileSync(file, bytes, { mode: 0o600, flag: "wx" })
        return await use(file)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
