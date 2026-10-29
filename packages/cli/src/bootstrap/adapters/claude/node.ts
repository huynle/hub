// Default Node implementations of the Claude Code adapter's ports (ports.ts). The integrator (HBS-13) passes them;
// tests inject fakes.
//
//   nodeRunner       spawn(file, args) with shell: false, exactly the given environment, stdin closed, stderr
//                    dropped, stdout capped, and a hard timeout (SIGKILL). The only process starter here.
//   httpsDownloader  https only (also after redirects), non-2xx refused, the body streamed and capped
//                    (DownloadTooLarge, as soon as it runs past the limit).
//   tempScratch      a 0700 directory under the system temp dir with one 0600 file (written as its content
//                    streams), removed afterwards.
import { spawn } from "node:child_process"
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chunksOf, responseChunks } from "../../transaction/stream.ts"
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
      return responseChunks(response, maxBytes, () => new DownloadTooLarge(url, maxBytes))
    },
  }
}

export function tempScratch(base: string = tmpdir()): Scratch {
  return {
    async withFile(content, use) {
      const dir = mkdtempSync(join(base, "hubctl-claude-"))
      try {
        const file = join(dir, "claude")
        const fd = openSync(file, "wx", 0o600)
        try {
          for await (const chunk of chunksOf(content)) for (let at = 0; at < chunk.byteLength; ) at += writeSync(fd, chunk, at)
        } finally {
          closeSync(fd)
        }
        return await use(file)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
