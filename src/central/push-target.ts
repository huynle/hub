// URLs users give the hub (push endpoints from browsers, webhook URLs from apps) are URLs the hub POSTs to: without
// checks a subscription could make the hub send requests into its own network (SSRF). publicURLProblem: https on a
// public hostname whose every resolved address is public (not loopback, private, link-local, CGNAT, ULA,
// unspecified or multicast); an admin opt-in (allowPrivate, webhooks only) admits http and private targets.
// Push checks endpoints at subscribe time (real push services are public names on public addresses); webhooks
// send through publicFetch, which re-checks (and re-resolves) right before every request, never follows a
// redirect, times out and reads a bounded body.
import { lookup } from "node:dns/promises"
import { isIPv4, isIPv6 } from "node:net"

export type ResolveHost = (host: string) => Promise<readonly string[]>

/** Every address the system resolver returns for a host. */
export const resolveHost: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** IPv4 [network, prefix length] blocks that are never a public service. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
]

const v4Number = (ip: string): number => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0)

function privateV4(ip: string): boolean {
  const n = v4Number(ip)
  return V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(net) / 2 ** (32 - bits)))
}

/** The eight 16-bit groups of an IPv6 address (with any embedded IPv4 tail converted). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().replace(/%.*$/, "")
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const n = v4Number(tail[1]!)
    text = `${text.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, rest] = text.split("::") as [string, string | undefined]
  const left = head ? head.split(":") : []
  const right = rest === undefined ? [] : rest ? rest.split(":") : []
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill("0")
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16))
}

/** True for addresses a public URL must not resolve to. Anything that is not an IP counts as private. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[(.*)\]$/, "$1")
  if (isIPv4(ip)) return privateV4(ip)
  if (!isIPv6(ip)) return true
  const g = v6Groups(ip)
  const first = g[0]!
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, which includes :: and ::1).
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true
    return privateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`)
  }
  if (first === 0x64 && g[1] === 0xff9b) return privateV4(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`) // NAT64
  return (
    (first & 0xfe00) === 0xfc00 || // ULA fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (first & 0xff00) === 0xff00 // multicast
  )
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"]

export interface PublicURLOptions {
  readonly resolve: ResolveHost
  /** How problems name the URL (default "URL"). */
  readonly label?: string
  /**
   * The admin opt-in for private targets (hub.json agents.webhooks.allowPrivate): http, loopback, private
   * addresses and local names pass without a lookup. Other schemes and credentials still fail.
   */
  readonly allowPrivate?: boolean
}

/** Why the hub must not send to a URL (SSRF), or undefined when it may. */
export async function publicURLProblem(raw: string, options: PublicURLOptions): Promise<string | undefined> {
  const label = options.label ?? "URL"
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${label} is not a URL`
  }
  if (options.allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return `${label} must be http or https`
  } else if (url.protocol !== "https:") return `${label} must be https`
  if (url.username || url.password) return `${label} must not carry credentials`
  if (options.allowPrivate) return undefined
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")
  if (isIPv4(host) || isIPv6(host)) return isPrivateAddress(host) ? `${label} is a private or local address` : undefined
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${label} is a local hostname`
  }
  let addresses: readonly string[]
  try {
    addresses = await options.resolve(host)
  } catch {
    return `${label} host ${host} does not resolve`
  }
  if (addresses.length === 0) return `${label} host ${host} does not resolve`
  if (addresses.some(isPrivateAddress)) return `${label} resolves to a private or local address`
  return undefined
}

/** Why an endpoint is not acceptable for Web Push, or undefined when it is. */
export async function pushEndpointProblem(endpoint: string, resolve: ResolveHost): Promise<string | undefined> {
  return publicURLProblem(endpoint, { resolve, label: "Push endpoint" })
}

/** The URL failed publicURLProblem at send time; nothing was sent. */
export class PublicURLError extends Error {
  constructor(readonly problem: string) {
    super(problem)
    this.name = "PublicURLError"
  }
}

export interface PublicFetchOptions extends PublicURLOptions {
  /** For the whole exchange, body included. */
  readonly timeoutMs: number
  /** Bytes of the response body read at most; the rest is discarded. */
  readonly maxBytes: number
  readonly fetch?: typeof globalThis.fetch
}

export interface PublicFetchResult {
  readonly status: number
  /** The first maxBytes of the body (UTF-8, lossy). */
  readonly body: string
  readonly truncated: boolean
}

/**
 * One request to a user-supplied URL: the URL is checked (and its host re-resolved) right before sending, so a
 * name that changed to a private address since registration is refused; redirects are never followed (a 3xx is
 * returned as is); the timeout covers the body; at most maxBytes of the body are read.
 * A rebinding between this lookup and fetch's own remains possible; private targets need the admin opt-in.
 */
export async function publicFetch(
  url: string,
  init: { readonly method: string; readonly headers?: Record<string, string>; readonly body: string },
  options: PublicFetchOptions,
): Promise<PublicFetchResult> {
  const problem = await publicURLProblem(url, options)
  if (problem) throw new PublicURLError(problem)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, redirect: "manual", signal: controller.signal })
    const { body, truncated } = await readCapped(response, options.maxBytes)
    return { status: response.status, body, truncated }
  } catch (cause) {
    if (timedOut) throw new Error(`timed out after ${options.timeoutMs} ms`)
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const room = maxBytes - size
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room))
      size = maxBytes
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated }
}
